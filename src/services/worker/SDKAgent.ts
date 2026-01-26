/**
 * SDKAgent: SDK query loop handler
 *
 * Responsibility:
 * - Spawn Claude subprocess via Agent SDK
 * - Run event-driven query loop (no polling)
 * - Process SDK responses (observations, summaries)
 * - Sync to database and Chroma
 */

import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildBatchObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, SDKUserMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { processAgentResponse, type WorkerRef } from './agents/index.js';
import { createPidCapturingSpawn, getProcessBySession, ensureProcessExit } from './ProcessRegistry.js';

// Import Agent SDK (assumes it's installed)
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

export class SDKAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start SDK agent for a session (event-driven, no polling)
   * @param worker WorkerService reference for spinner control (optional)
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    // Initialize FIFO queue for tracking message IDs (handles SDK prefetch)
    session.processingMessageIdQueue = [];

    // Track cwd from messages for CLAUDE.md generation (worktree support)
    // Uses mutable object so generator updates are visible in response processing
    const cwdTracker = { lastCwd: undefined as string | undefined };

    // Find Claude executable
    const claudePath = this.findClaudeExecutable();

    // Get model ID and disallowed tools
    const modelId = this.getModelId();
    // Memory agent is OBSERVER ONLY - no tools allowed
    // This list blocks tools to prevent autonomous behavior if the model misinterprets
    // its role (e.g., when receiving compaction summaries with action descriptions)
    // See: docs/reports/2026-01-09-autonomous-sdk-execution.md
    const disallowedTools = [
      'Bash',           // Prevent infinite loops
      'Read',           // No file reading
      'Write',          // No file writing
      'Edit',           // No file editing
      'Grep',           // No code searching
      'Glob',           // No file pattern matching
      'WebFetch',       // No web fetching
      'WebSearch',      // No web searching
      'Task',           // No spawning sub-agents
      'NotebookEdit',   // No notebook editing
      'AskUserQuestion',// No asking questions
      'TodoWrite',      // No todo management
      // Planning and task management tools (added 2026-01-09)
      // These were used by SDK when it misinterpreted compaction summaries as work instructions
      'EnterPlanMode',  // No planning mode entry
      'ExitPlanMode',   // No planning mode exit
      'TaskOutput',     // No background task output retrieval
      'Skill',          // No skill/slash command invocation
      'KillShell',      // No shell management
      'LSP',            // No language server operations
    ];

    // Create message generator (event-driven)
    const messageGenerator = this.createMessageGenerator(session, cwdTracker);

    // CRITICAL: Generate stable UUID for memorySessionId if not already set
    // This decouples the FK identity from the Claude SDK session_id
    // memorySessionId: Stable UUID for FK (generated once, never changes)
    // claudeResumeSessionId: Claude SDK session_id (changes on rollover)
    if (!session.memorySessionId) {
      const generatedId = crypto.randomUUID();
      session.memorySessionId = generatedId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, generatedId);
      logger.info('SDK', `Generated stable memorySessionId for Claude session | sessionDbId=${session.sessionDbId} | memorySessionId=${generatedId}`, {
        sessionId: session.sessionDbId
      });
    }

    // Resume logic uses claudeResumeSessionId (the actual SDK session_id)
    // Only resume if:
    // 1. claudeResumeSessionId exists (was captured from a previous SDK response)
    // 2. lastPromptNumber > 1 (this is a continuation within the same SDK session)
    // On worker restart or crash recovery, claudeResumeSessionId may exist from a previous
    // SDK session but we must NOT resume because the SDK context was lost.
    const hasClaudeResumeId = !!session.claudeResumeSessionId;

    logger.info('SDK', 'Starting SDK query', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      memorySessionId: session.memorySessionId,
      claudeResumeSessionId: session.claudeResumeSessionId,
      hasClaudeResumeId,
      resume_parameter: hasClaudeResumeId ? session.claudeResumeSessionId : '(none - fresh start)',
      lastPromptNumber: session.lastPromptNumber
    });

    // Debug-level alignment logs for detailed tracing
    if (session.lastPromptNumber > 1) {
      const willResume = hasClaudeResumeId;
      logger.debug('SDK', `[ALIGNMENT] Resume Decision | contentSessionId=${session.contentSessionId} | memorySessionId=${session.memorySessionId} | claudeResumeSessionId=${session.claudeResumeSessionId} | prompt#=${session.lastPromptNumber} | hasClaudeResumeId=${hasClaudeResumeId} | willResume=${willResume} | resumeWith=${willResume ? session.claudeResumeSessionId : 'NONE'}`);
    } else {
      // INIT prompt - never resume even if claudeResumeSessionId exists (stale from previous session)
      const hasStaleResumeId = hasClaudeResumeId;
      logger.debug('SDK', `[ALIGNMENT] First Prompt (INIT) | contentSessionId=${session.contentSessionId} | prompt#=${session.lastPromptNumber} | hasStaleResumeId=${hasStaleResumeId} | action=START_FRESH | Will capture new claudeResumeSessionId from SDK response`);
      if (hasStaleResumeId) {
        logger.warn('SDK', `Skipping resume for INIT prompt despite existing claudeResumeSessionId=${session.claudeResumeSessionId} - SDK context was lost (worker restart or crash recovery)`);
      }
    }

    // Run Agent SDK query loop
    // Only resume if we have a captured Claude resume session ID
    // Use custom spawn to capture PIDs for zombie process cleanup (Issue #737)
    const queryResult = query({
      prompt: messageGenerator,
      options: {
        model: modelId,
        // Only resume if BOTH: (1) we have a claudeResumeSessionId AND (2) this isn't the first prompt
        // On worker restart, claudeResumeSessionId may exist from a previous SDK session but we
        // need to start fresh since the SDK context was lost
        ...(hasClaudeResumeId && session.lastPromptNumber > 1 && { resume: session.claudeResumeSessionId }),
        disallowedTools,
        abortController: session.abortController,
        pathToClaudeCodeExecutable: claudePath,
        // Custom spawn function captures PIDs to fix zombie process accumulation
        spawnClaudeCodeProcess: createPidCapturingSpawn(session.sessionDbId)
      }
    });

    // Process SDK messages
    for await (const message of queryResult) {
      // Capture Claude resume session ID from SDK messages
      // This is the SDK's session_id used for --resume flag
      // Update on every message in case SDK returns a new session_id
      if (message.session_id && message.session_id !== session.claudeResumeSessionId) {
        const previousResumeId = session.claudeResumeSessionId;
        session.claudeResumeSessionId = message.session_id;
        // Persist to database for cross-restart recovery
        this.dbManager.getSessionStore().updateClaudeResumeSessionId(
          session.sessionDbId,
          message.session_id
        );
        logger.info('SESSION', `CLAUDE_RESUME_ID_CAPTURED | sessionDbId=${session.sessionDbId} | claudeResumeSessionId=${message.session_id} | previousResumeId=${previousResumeId || '(none)'}`, {
          sessionId: session.sessionDbId,
          claudeResumeSessionId: message.session_id
        });
        // Debug-level alignment log for detailed tracing
        logger.debug('SDK', `[ALIGNMENT] Captured | contentSessionId=${session.contentSessionId} | memorySessionId=${session.memorySessionId} → claudeResumeSessionId=${message.session_id} | Future prompts will resume with this ID`);
      }

      // Handle assistant messages
      if (message.type === 'assistant') {
        const content = message.message.content;
        const textContent = Array.isArray(content)
          ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
          : typeof content === 'string' ? content : '';

        const responseSize = textContent.length;

        // Capture token state BEFORE updating (for delta calculation)
        const tokensBeforeResponse = session.cumulativeInputTokens + session.cumulativeOutputTokens;

        // Extract and track token usage
        const usage = message.message.usage;
        if (usage) {
          session.cumulativeInputTokens += usage.input_tokens || 0;
          session.cumulativeOutputTokens += usage.output_tokens || 0;

          // Cache creation counts as discovery, cache read doesn't
          if (usage.cache_creation_input_tokens) {
            session.cumulativeInputTokens += usage.cache_creation_input_tokens;
          }

          // Track last input tokens for rollover threshold checking
          // Include cache tokens in the count since they contribute to context size
          // cache_read_input_tokens: tokens read from cache (still in context)
          // cache_creation_input_tokens: tokens written to cache (still in context)
          const totalInputTokens = (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);

          if (totalInputTokens > 0) {
            session.lastInputTokens = totalInputTokens;
            // Persist to database for worker restart survival
            this.dbManager.getSessionStore().updateLastInputTokens(
              session.sessionDbId,
              totalInputTokens
            );
          }

          logger.debug('SDK', 'Token usage captured', {
            sessionId: session.sessionDbId,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            cumulativeInput: session.cumulativeInputTokens,
            cumulativeOutput: session.cumulativeOutputTokens,
            lastInputTokens: session.lastInputTokens
          });

          // MID-SESSION ROLLOVER CHECK: If tokens exceed threshold, schedule restart
          // This triggers rollover while the generator is running (not just at start)
          if (session.lastInputTokens !== undefined && !session.pendingRestart) {
            const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
            const rolloverEnabled = settings.CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED === 'true';
            const maxTokens = parseInt(settings.CLAUDE_MEM_CLAUDE_MAX_TOKENS, 10);
            const effectiveMaxTokens = isNaN(maxTokens) ? 150000 : maxTokens;
            const threshold = Math.floor(effectiveMaxTokens * 0.9);

            if (rolloverEnabled && session.lastInputTokens > threshold) {
              logger.info('SDK', `CLAUDE_ROLLOVER_SCHEDULED | tokens=${session.lastInputTokens} > threshold=${threshold}`, {
                sessionId: session.sessionDbId,
                lastInputTokens: session.lastInputTokens,
                threshold,
                maxTokens: effectiveMaxTokens
              });
              // TELEMETRY: Rollover scheduled event
              logger.info('TELEMETRY', 'ROLLOVER_SCHEDULED', {
                sessionId: session.sessionDbId,
                provider: 'claude',
                tokens: session.lastInputTokens,
                threshold,
                maxTokens: effectiveMaxTokens
              });
              // Schedule restart via pendingRestart mechanism (will trigger when idle)
              session.pendingRestart = {
                reason: `context-rollover:${session.lastInputTokens}>${threshold}`,
                requestedAt: Date.now()
              };
            }
          }
        }

        // Calculate discovery tokens (delta for this response only)
        const discoveryTokens = (session.cumulativeInputTokens + session.cumulativeOutputTokens) - tokensBeforeResponse;

        // Process response (empty or not) and mark messages as processed
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        const originalTimestamp = session.earliestPendingTimestamp;

        // Get the message ID for this response (FIFO order)
        // Handles SDK prefetch where multiple prompts may be in-flight
        const messageId = session.processingMessageIdQueue?.shift();

        if (responseSize > 0) {
          const truncatedResponse = responseSize > 100
            ? textContent.substring(0, 100) + '...'
            : textContent;
          logger.dataOut('SDK', `Response received (${responseSize} chars)`, {
            sessionId: session.sessionDbId,
            promptNumber: session.lastPromptNumber
          }, truncatedResponse);
        }

        // Parse and process response using shared ResponseProcessor
        // Pass messageId for atomic store+mark-complete (undefined for init/continuation)
        await processAgentResponse(
          textContent,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          discoveryTokens,
          originalTimestamp,
          'SDK',
          cwdTracker.lastCwd,
          messageId
        );
      }

      // Log result messages
      if (message.type === 'result' && message.subtype === 'success') {
        // Usage telemetry is captured at SDK level
      }
    }

    // Mark session complete
    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`
    });
  }

  /**
   * Create event-driven message generator (yields messages from SessionManager)
   *
   * CRITICAL: CONTINUATION PROMPT LOGIC
   * ====================================
   * This is where NEW hook's dual-purpose nature comes together:
   *
   * - Prompt #1 (lastPromptNumber === 1): buildInitPrompt
   *   - Full initialization prompt with instructions
   *   - Sets up the SDK agent's context
   *
   * - Prompt #2+ (lastPromptNumber > 1): buildContinuationPrompt
   *   - Continuation prompt for same session
   *   - Includes session context and prompt number
   *
   * BOTH prompts receive session.contentSessionId:
   * - This comes from the hook's session_id (see new-hook.ts)
   * - Same session_id used by SAVE hook to store observations
   * - This is how everything stays connected in one unified session
   *
   * NO SESSION EXISTENCE CHECKS NEEDED:
   * - SessionManager.initializeSession already fetched this from database
   * - Database row was created by new-hook's createSDKSession call
   * - We just use the session_id we're given - simple and reliable
   *
   * SHARED CONVERSATION HISTORY:
   * - Each user message is added to session.conversationHistory
   * - This allows provider switching (Claude→Gemini) with full context
   * - SDK manages its own internal state, but we mirror it for interop
   *
   * CWD TRACKING:
   * - cwdTracker is a mutable object shared with startSession
   * - As messages with cwd are processed, cwdTracker.lastCwd is updated
   * - This enables processAgentResponse to use the correct cwd for CLAUDE.md
   */
  private async *createMessageGenerator(
    session: ActiveSession,
    cwdTracker: { lastCwd: string | undefined }
  ): AsyncIterableIterator<SDKUserMessage> {
    // Load active mode
    const mode = ModeManager.getInstance().getActiveMode();

    // Build initial prompt
    const isInitPrompt = session.lastPromptNumber === 1;
    logger.info('SDK', 'Creating message generator', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      lastPromptNumber: session.lastPromptNumber,
      isInitPrompt,
      promptType: isInitPrompt ? 'INIT' : 'CONTINUATION'
    });

    const initPrompt = isInitPrompt
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    // Add to shared conversation history for provider interop
    session.conversationHistory.push({ role: 'user', content: initPrompt });

    // Push undefined sentinel for init/continuation prompt (no messageId)
    // This ensures FIFO queue stays aligned when processing responses
    session.processingMessageIdQueue?.push(undefined);

    // Yield initial user prompt with context (or continuation if prompt #2+)
    // CRITICAL: Both paths use session.contentSessionId from the hook
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: initPrompt
      },
      session_id: session.contentSessionId,
      parent_tool_use_id: null,
      isSynthetic: true
    };

    // Check if batching is enabled
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const batchingEnabled = settings.CLAUDE_MEM_BATCHING_ENABLED === 'true';

    if (batchingEnabled) {
      // BATCHED MODE: Consume batches of messages, build combined prompts
      for await (const batch of this.sessionManager.getBatchIterator(session.sessionDbId)) {
        // Separate observations from summarize requests
        const observations: typeof batch = [];
        const summarizeRequests: typeof batch = [];

        for (const message of batch) {
          if (message.cwd) {
            cwdTracker.lastCwd = message.cwd;
          }
          if (message.type === 'observation') {
            if (message.prompt_number !== undefined) {
              session.lastPromptNumber = message.prompt_number;
            }
            observations.push(message);
          } else if (message.type === 'summarize') {
            summarizeRequests.push(message);
          }
        }

        // Yield batched observation prompt (if any observations)
        if (observations.length > 0) {
          const batchPrompt = buildBatchObservationPrompt(observations.map(obs => ({
            id: 0,
            tool_name: obs.tool_name!,
            tool_input: JSON.stringify(obs.tool_input),
            tool_output: JSON.stringify(obs.tool_response),
            created_at_epoch: obs._originalTimestamp || Date.now(),
            cwd: obs.cwd
          })));

          logger.info('BATCH', `BATCH_PROMPT | sessionDbId=${session.sessionDbId} | count=${observations.length}`, {
            sessionId: session.sessionDbId
          });

          session.conversationHistory.push({ role: 'user', content: batchPrompt });

          yield {
            type: 'user',
            message: {
              role: 'user',
              content: batchPrompt
            },
            session_id: session.contentSessionId,
            parent_tool_use_id: null,
            isSynthetic: true
          };
        }

        // Yield summarize prompts individually (they need separate processing)
        for (const message of summarizeRequests) {
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });

          yield {
            type: 'user',
            message: {
              role: 'user',
              content: summaryPrompt
            },
            session_id: session.contentSessionId,
            parent_tool_use_id: null,
            isSynthetic: true
          };
        }
      }
    } else {
      // IMMEDIATE MODE: Consume individual messages (original behavior)
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        if (message.cwd) {
          cwdTracker.lastCwd = message.cwd;
        }

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: Date.now(),
            cwd: message.cwd
          });

          session.conversationHistory.push({ role: 'user', content: obsPrompt });

          // Push message ID to FIFO BEFORE yielding
          // This handles SDK prefetch - multiple prompts can be in-flight
          session.processingMessageIdQueue?.push(message._persistentId);

          yield {
            type: 'user',
            message: {
              role: 'user',
              content: obsPrompt
            },
            session_id: session.contentSessionId,
            parent_tool_use_id: null,
            isSynthetic: true
          };
        } else if (message.type === 'summarize') {
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });

          // Push message ID to FIFO BEFORE yielding
          session.processingMessageIdQueue?.push(message._persistentId);

          yield {
            type: 'user',
            message: {
              role: 'user',
              content: summaryPrompt
            },
            session_id: session.contentSessionId,
            parent_tool_use_id: null,
            isSynthetic: true
          };
        }
      }
    }
  }

  // ============================================================================
  // Configuration Helpers
  // ============================================================================

  /**
   * Find Claude executable (inline, called once per session)
   */
  private findClaudeExecutable(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // 1. Check configured path
    if (settings.CLAUDE_CODE_PATH) {
      // Lazy load fs to keep startup fast
      const { existsSync } = require('fs');
      if (!existsSync(settings.CLAUDE_CODE_PATH)) {
        throw new Error(`CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`);
      }
      return settings.CLAUDE_CODE_PATH;
    }

    // 2. Try auto-detection
    try {
      const claudePath = execSync(
        process.platform === 'win32' ? 'where claude' : 'which claude',
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim().split('\n')[0].trim();

      if (claudePath) return claudePath;
    } catch (error) {
      // [ANTI-PATTERN IGNORED]: Fallback behavior - which/where failed, continue to throw clear error
      logger.debug('SDK', 'Claude executable auto-detection failed', {}, error as Error);
    }

    throw new Error('Claude executable not found. Please either:\n1. Add "claude" to your system PATH, or\n2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json');
  }

  /**
   * Get model ID from settings or environment
   */
  private getModelId(): string {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CLAUDE_MEM_MODEL;
  }
}
