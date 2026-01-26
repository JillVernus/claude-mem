/**
 * Session Routes
 *
 * Handles session lifecycle operations: initialization, observations, summarization, completion.
 * These routes manage the flow of work through the Claude Agent SDK.
 */

import express, { Request, Response } from 'express';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTagsFromJson, stripMemoryTagsFromPrompt } from '../../../../utils/tag-stripping.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SDKAgent } from '../../SDKAgent.js';
import { GeminiAgent, isGeminiSelected, isGeminiAvailable } from '../../GeminiAgent.js';
import { OpenAIAgent, isOpenAISelected, isOpenAIAvailable } from '../../OpenAIAgent.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import { SessionCompletionHandler } from '../../session/SessionCompletionHandler.js';
import { PrivacyCheckValidator } from '../../validation/PrivacyCheckValidator.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { getProcessBySession, ensureProcessExit } from '../../ProcessRegistry.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';

export class SessionRoutes extends BaseRouteHandler {
  private completionHandler: SessionCompletionHandler;
  private pendingRestartListeners: Map<number, (sid: number, reason: string) => void> = new Map();
  private restartInProgress: Set<number> = new Set();  // Mutex for concurrent restart prevention

  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: SDKAgent,
    private geminiAgent: GeminiAgent,
    private openAIAgent: OpenAIAgent,
    private eventBroadcaster: SessionEventBroadcaster,
    private workerService: WorkerService
  ) {
    super();
    this.completionHandler = new SessionCompletionHandler(
      sessionManager,
      eventBroadcaster
    );
  }

  /**
   * Get the appropriate agent based on settings
   * Throws error if provider is selected but not configured (no silent fallback)
   *
   * Note: Session linking via contentSessionId allows provider switching mid-session.
   * The conversationHistory on ActiveSession maintains context across providers.
   */
  private getActiveAgent(): SDKAgent | GeminiAgent | OpenAIAgent {
    if (isOpenAISelected()) {
      if (isOpenAIAvailable()) {
        logger.debug('SESSION', 'Using OpenAI-compatible agent');
        return this.openAIAgent;
      } else {
        throw new Error('OpenAI-compatible provider selected but no API key configured. Set CLAUDE_MEM_OPENAI_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
      }
    }
    if (isGeminiSelected()) {
      if (isGeminiAvailable()) {
        logger.debug('SESSION', 'Using Gemini agent');
        return this.geminiAgent;
      } else {
        throw new Error('Gemini provider selected but no API key configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
      }
    }
    return this.sdkAgent;
  }

  /**
   * Get the currently selected provider name
   */
  private getSelectedProvider(): 'claude' | 'gemini' | 'openai' {
    if (isOpenAISelected() && isOpenAIAvailable()) {
      return 'openai';
    }
    return (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude';
  }

  /**
   * Ensures agent generator is running for a session
   * Auto-starts if not already running to process pending queue
   * Uses either Claude SDK or Gemini based on settings
   *
   * Provider switching: If provider setting changed while generator is running,
   * we let the current generator finish naturally (max 5s linger timeout).
   * The next generator will use the new provider with shared conversationHistory.
   */
  private async ensureGeneratorRunning(sessionDbId: number, source: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return;

    const selectedProvider = this.getSelectedProvider();

    // Start generator if not running
    if (!session.generatorPromise) {
      await this.startGeneratorWithProvider(session, selectedProvider, source);
      return;
    }

    // Generator is running - check if provider changed
    if (session.currentProvider && session.currentProvider !== selectedProvider) {
      logger.info('SESSION', `Provider changed, will switch after current generator finishes`, {
        sessionId: sessionDbId,
        currentProvider: session.currentProvider,
        selectedProvider,
        historyLength: session.conversationHistory.length
      });
      // Let current generator finish naturally, next one will use new provider
      // The shared conversationHistory ensures context is preserved
    }
  }

  /**
   * Start a generator with the specified provider
   * Includes generator identity tracking for safe hot-reload restarts
   */
  private async startGeneratorWithProvider(
    session: ReturnType<typeof this.sessionManager.getSession>,
    provider: 'claude' | 'gemini' | 'openai',
    source: string
  ): Promise<void> {
    if (!session) return;

    const agent = provider === 'openai' ? this.openAIAgent : (provider === 'gemini' ? this.geminiAgent : this.sdkAgent);
    const agentName = provider === 'openai' ? 'OpenAI' : (provider === 'gemini' ? 'Gemini' : 'Claude SDK');

    // CLAUDE ROLLOVER: Check if input tokens exceed threshold before starting
    // If threshold exceeded, clear claudeResumeSessionId to start fresh (no resume)
    let previousResumeIdForCleanup: string | null = null;  // Save for orphan cleanup
    if (provider === 'claude' && session.lastInputTokens !== undefined) {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const rolloverEnabled = settings.CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED === 'true';
      const maxTokens = parseInt(settings.CLAUDE_MEM_CLAUDE_MAX_TOKENS, 10);
      const effectiveMaxTokens = isNaN(maxTokens) ? 150000 : maxTokens;
      // Use 90% safety margin to trigger before hitting hard limit
      const threshold = Math.floor(effectiveMaxTokens * 0.9);

      if (rolloverEnabled && session.lastInputTokens > threshold) {
        previousResumeIdForCleanup = session.claudeResumeSessionId;
        logger.info('SESSION', `CLAUDE_ROLLOVER_TRIGGERED | tokens=${session.lastInputTokens} > threshold=${threshold}`, {
          sessionId: session.sessionDbId,
          lastInputTokens: session.lastInputTokens,
          threshold,
          maxTokens: effectiveMaxTokens,
          previousResumeId: previousResumeIdForCleanup
        });
        // TELEMETRY: Rollover executed event (at generator start)
        logger.info('TELEMETRY', 'ROLLOVER_EXECUTED', {
          sessionId: session.sessionDbId,
          provider: 'claude',
          tokens: session.lastInputTokens,
          threshold,
          maxTokens: effectiveMaxTokens,
          previousResumeId: previousResumeIdForCleanup
        });

        // Clear claudeResumeSessionId to start fresh (no resume)
        session.claudeResumeSessionId = null;
        this.dbManager.getSessionStore().updateClaudeResumeSessionId(session.sessionDbId, null);

        // CRITICAL: Reset lastInputTokens to prevent immediate re-trigger of rollover
        // Without this, the first API call after rollover returns high token count
        // (conversation history is still large), which immediately triggers another rollover
        session.lastInputTokens = undefined;
        this.dbManager.getSessionStore().updateLastInputTokens(session.sessionDbId, null);

        // MEMORY LEAK FIX: Clear conversationHistory on rollover
        // Without this, conversationHistory grows unbounded since SDKAgent doesn't truncate
        // (unlike Gemini/OpenAI which call truncateHistory). The SDK context is being reset
        // anyway, so the old history is useless and just consumes memory.
        const oldHistoryLength = session.conversationHistory.length;
        session.conversationHistory = [];
        logger.info('SESSION', `ROLLOVER_HISTORY_CLEARED | oldLength=${oldHistoryLength}`, {
          sessionId: session.sessionDbId,
          oldHistoryLength
        });

        // Note: memorySessionId stays the same (stable FK identity)
        // Observations will continue to be stored under the same memorySessionId
      }
    }

    // Ensure previous subprocess has exited before starting new generator (Issue #737)
    // This uses ProcessRegistry's PID tracking instead of pgrep scanning
    if (provider === 'claude') {
      const tracked = getProcessBySession(session.sessionDbId);
      if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
        logger.info('SESSION', `Waiting for previous subprocess to exit before starting new generator`, {
          sessionId: session.sessionDbId,
          pid: tracked.pid
        });
        await ensureProcessExit(tracked, 5000);
      }
    }

    // Generate unique ID for this generator instance (for race detection)
    const generatorId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Store generator ID on session for .finally() race detection
    session.currentGeneratorId = generatorId;

    // Capture the AbortController used for THIS generator (immutable reference)
    const thisAbortController = session.abortController;

    // CRITICAL: Reset idle state when starting a new generator
    session.generatorIdle = false;
    session.idleSince = null;
    session.inFlightCount = 0;

    // DIAGNOSTIC: Check if generator is already running (potential bug)
    if (session.generatorPromise) {
      logger.warn('SESSION', `DIAGNOSTIC: Starting generator while one already running!`, {
        sessionId: session.sessionDbId,
        newGeneratorId: generatorId,
        source,
        provider: agentName,
        existingProvider: session.currentProvider
      });
    }

    logger.info('SESSION', `Generator STARTING | id=${generatorId} | source=${source} | provider=${agentName}`, {
      sessionId: session.sessionDbId,
      generatorId,
      queueDepth: session.pendingMessages.length,
      historyLength: session.conversationHistory.length
    });

    // Track which provider is running
    session.currentProvider = provider;

    // Set up pending-restart listener for this session
    this.setupPendingRestartListener(session.sessionDbId);

    session.generatorPromise = agent.startSession(session, this.workerService)
      .catch(error => {
        // Only log non-abort errors
        if (thisAbortController.signal.aborted) {
          logger.debug('SESSION', `Generator ${generatorId} caught error after abort (expected)`, {
            sessionId: session.sessionDbId
          });
          return;
        }

        logger.error('SESSION', `Generator FAILED | id=${generatorId}`, {
          sessionId: session.sessionDbId,
          generatorId,
          provider: provider,
          error: error.message
        }, error);

        // Mark all processing messages as failed so they can be retried or abandoned
        const pendingStore = this.sessionManager.getPendingMessageStore();
        try {
          const failedCount = pendingStore.markSessionMessagesFailed(session.sessionDbId);
          if (failedCount > 0) {
            logger.error('SESSION', `Marked messages as failed after generator error`, {
              sessionId: session.sessionDbId,
              failedCount
            });
          }
        } catch (dbError) {
          logger.error('SESSION', 'Failed to mark messages as failed', {
            sessionId: session.sessionDbId
          }, dbError as Error);
        }
      })
      .finally(() => {
        const sessionDbId = session.sessionDbId;
        const wasAborted = thisAbortController.signal.aborted;

        // CRITICAL: Only mutate session state if this generator is still current
        // This prevents hot-reload race where old .finally() clobbers new generator
        if (session.currentGeneratorId !== generatorId) {
          logger.debug('SESSION', `Generator ${generatorId} .finally() skipped - superseded by ${session.currentGeneratorId}`, {
            sessionId: sessionDbId
          });
          return;
        }

        // DIAGNOSTIC: Log generator end with full context
        logger.info('SESSION', `Generator ENDED | id=${generatorId} | wasAborted=${wasAborted}`, {
          sessionId: sessionDbId,
          generatorId,
          wasAborted,
          reason: wasAborted ? 'aborted' : 'exited-unexpectedly'
        });

        session.generatorPromise = null;
        session.currentProvider = null;
        session.currentGeneratorId = null;

        // Clean up pending-restart listener
        this.cleanupPendingRestartListener(sessionDbId);

        this.workerService.broadcastProcessingStatus();

        // Crash recovery: If not aborted and still has work, restart
        if (!wasAborted) {
          try {
            const pendingStore = this.sessionManager.getPendingMessageStore();
            const pendingCount = pendingStore.getPendingCount(sessionDbId);

            if (pendingCount > 0) {
              logger.info('SESSION', `Generator RESTARTING | oldId=${generatorId} | pendingCount=${pendingCount}`, {
                sessionId: sessionDbId,
                oldGeneratorId: generatorId,
                pendingCount
              });

              // DIAGNOSTIC: Log abort call
              logger.debug('SESSION', `DIAGNOSTIC: Calling abort() on old controller before restart`, {
                sessionId: sessionDbId,
                generatorId
              });
              // Abort OLD controller before replacing to prevent child process leaks
              const oldController = session.abortController;
              session.abortController = new AbortController();
              oldController.abort();

              // Small delay before restart
              setTimeout(async () => {
                const stillExists = this.sessionManager.getSession(sessionDbId);
                if (stillExists && !stillExists.generatorPromise) {
                  await this.startGeneratorWithProvider(stillExists, this.getSelectedProvider(), 'crash-recovery');
                } else if (stillExists?.generatorPromise) {
                  logger.warn('SESSION', `DIAGNOSTIC: Skipped restart - generator already running`, {
                    sessionId: sessionDbId
                  });
                }
              }, 1000);
            } else {
              // No pending work - abort to kill the child process
              logger.debug('SESSION', `DIAGNOSTIC: Calling abort() after natural completion (no pending work)`, {
                sessionId: sessionDbId,
                generatorId
              });
              session.abortController.abort();
            }
          } catch (e) {
            // Ignore errors during recovery check, but still abort to prevent leaks
            logger.debug('SESSION', 'Error during recovery check, aborting to prevent leaks', { sessionId: sessionDbId, error: e instanceof Error ? e.message : String(e) });
            session.abortController.abort();
          }
        }
        // NOTE: We do NOT delete the session here anymore.
        // The generator waits for events, so if it exited, it's either aborted or crashed.
        // Idle sessions stay in memory (ActiveSession is small) to listen for future events.
      });
  }

  /**
   * Set up listener for pending-restart events (settings hot-reload)
   */
  private setupPendingRestartListener(sessionDbId: number): void {
    // Clean up any existing listener first
    this.cleanupPendingRestartListener(sessionDbId);

    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return;

    // Get the session's event emitter (same one used by queue processor)
    const emitter = this.sessionManager.getSessionQueueEmitter(sessionDbId);
    if (!emitter) return;

    const listener = (sid: number, reason: string) => {
      if (sid === sessionDbId) {
        // CRITICAL: Use .catch() to prevent unhandled promise rejection
        this.tryRestartGeneratorAsync(sessionDbId, reason).catch(error => {
          logger.error('SESSION', `Hot-reload restart failed`, {
            sessionId: sessionDbId,
            reason,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    };

    emitter.on('pending-restart', listener);
    this.pendingRestartListeners.set(sessionDbId, listener);
  }

  /**
   * Clean up pending-restart listener
   */
  private cleanupPendingRestartListener(sessionDbId: number): void {
    const listener = this.pendingRestartListeners.get(sessionDbId);
    if (!listener) return;

    const emitter = this.sessionManager.getSessionQueueEmitter(sessionDbId);
    if (emitter) {
      emitter.off('pending-restart', listener);
    }
    this.pendingRestartListeners.delete(sessionDbId);
  }

  /**
   * Attempt to restart generator for settings hot-reload
   * Uses async flow: check safety → abort → await settle → start new
   * Includes mutex to prevent concurrent restart attempts.
   *
   * @returns Promise<boolean> - true if restart was initiated
   */
  private async tryRestartGeneratorAsync(sessionDbId: number, reason: string): Promise<boolean> {
    // MUTEX: Prevent concurrent restart attempts for same session
    if (this.restartInProgress.has(sessionDbId)) {
      logger.debug('SESSION', `Hot-reload restart skipped - already in progress`, {
        sessionId: sessionDbId,
        reason
      });
      return false;
    }

    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return false;

    // Check if safe to restart
    if (!this.sessionManager.isGeneratorSafeToRestart(sessionDbId)) {
      logger.debug('SESSION', `Hot-reload restart deferred - not safe`, {
        sessionId: sessionDbId,
        reason,
        generatorIdle: session.generatorIdle,
        inFlightCount: session.inFlightCount
      });
      return false;
    }

    // Acquire mutex
    this.restartInProgress.add(sessionDbId);

    try {
      const oldGeneratorId = session.currentGeneratorId;
      const oldProvider = session.currentProvider;

      logger.info('SESSION', `Generator HOT-RELOAD RESTARTING | reason=${reason}`, {
        sessionId: sessionDbId,
        oldGeneratorId,
        oldProvider,
        newProvider: this.getSelectedProvider()
      });

      // Step 1: Abort current generator
      const oldController = session.abortController;
      session.abortController = new AbortController();
      oldController.abort();

      // Step 2: Wait for old generator to settle (with timeout)
      if (session.generatorPromise) {
        try {
          await Promise.race([
            session.generatorPromise,
            new Promise(resolve => setTimeout(resolve, 5000)) // 5s timeout
          ]);
        } catch {
          // Ignore errors, we just want it to settle
        }
      }

      // Step 2.5: Reset any processing messages back to pending
      // This ensures no message loss during restart - messages stay in DB as 'processing'
      // and will be re-claimed by the new generator
      const resetCount = this.sessionManager.getPendingMessageStore().resetProcessingToPending(sessionDbId);
      if (resetCount > 0) {
        logger.info('SESSION', `Reset ${resetCount} processing messages to pending for restart`, {
          sessionId: sessionDbId,
          reason
        });
      }

      // Step 3: Double-check session still exists and no new generator started
      const currentSession = this.sessionManager.getSession(sessionDbId);
      if (!currentSession) {
        logger.warn('SESSION', `Hot-reload restart aborted - session no longer exists`, {
          sessionId: sessionDbId,
          reason
        });
        return false;
      }

      if (currentSession.generatorPromise) {
        logger.warn('SESSION', `Hot-reload restart aborted - new generator already started`, {
          sessionId: sessionDbId,
          reason
        });
        return false;
      }

      // Step 4: Start new generator with updated settings
      await this.startGeneratorWithProvider(currentSession, this.getSelectedProvider(), `hot-reload:${reason}`);

      // ONLY clear pendingRestart AFTER successful start
      currentSession.pendingRestart = null;

      return true;
    } finally {
      // Release mutex
      this.restartInProgress.delete(sessionDbId);
    }
  }

  setupRoutes(app: express.Application): void {
    // Legacy session endpoints (use sessionDbId)
    app.post('/sessions/:sessionDbId/init', this.handleSessionInit.bind(this));
    app.post('/sessions/:sessionDbId/observations', this.handleObservations.bind(this));
    app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));
    app.get('/sessions/:sessionDbId/status', this.handleSessionStatus.bind(this));
    app.delete('/sessions/:sessionDbId', this.handleSessionDelete.bind(this));
    app.post('/sessions/:sessionDbId/complete', this.handleSessionComplete.bind(this));

    // New session endpoints (use contentSessionId)
    app.post('/api/sessions/init', this.handleSessionInitByClaudeId.bind(this));
    app.post('/api/sessions/observations', this.handleObservationsByClaudeId.bind(this));
    app.post('/api/sessions/summarize', this.handleSummarizeByClaudeId.bind(this));
  }

  /**
   * Initialize a new session
   */
  private handleSessionInit = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { userPrompt, promptNumber } = req.body;
    logger.info('HTTP', 'SessionRoutes: handleSessionInit called', {
      sessionDbId,
      promptNumber,
      has_userPrompt: !!userPrompt
    });

    const session = this.sessionManager.initializeSession(sessionDbId, userPrompt, promptNumber);

    // Get the latest user_prompt for this session to sync to Chroma
    const latestPrompt = this.dbManager.getSessionStore().getLatestUserPrompt(session.contentSessionId);

    // Broadcast new prompt to SSE clients (for web UI)
    if (latestPrompt) {
      this.eventBroadcaster.broadcastNewPrompt({
        id: latestPrompt.id,
        content_session_id: latestPrompt.content_session_id,
        project: latestPrompt.project,
        prompt_number: latestPrompt.prompt_number,
        prompt_text: latestPrompt.prompt_text,
        created_at_epoch: latestPrompt.created_at_epoch
      });

      // Sync user prompt to Chroma
      const chromaStart = Date.now();
      const promptText = latestPrompt.prompt_text;
      this.dbManager.getChromaSync().syncUserPrompt(
        latestPrompt.id,
        latestPrompt.memory_session_id,
        latestPrompt.project,
        promptText,
        latestPrompt.prompt_number,
        latestPrompt.created_at_epoch
      ).then(() => {
        const chromaDuration = Date.now() - chromaStart;
        const truncatedPrompt = promptText.length > 60
          ? promptText.substring(0, 60) + '...'
          : promptText;
        logger.debug('CHROMA', 'User prompt synced', {
          promptId: latestPrompt.id,
          duration: `${chromaDuration}ms`,
          prompt: truncatedPrompt
        });
      }).catch((error) => {
        logger.error('CHROMA', 'User prompt sync failed, continuing without vector search', {
          promptId: latestPrompt.id,
          prompt: promptText.length > 60 ? promptText.substring(0, 60) + '...' : promptText
        }, error);
      });
    }

    // LAZY START: Don't start generator on /init - wait for first observation
    // Generator will be started by ensureGeneratorRunning() when observations arrive
    // This prevents wasted resources polling an empty queue

    // Broadcast session started event
    this.eventBroadcaster.broadcastSessionStarted(sessionDbId, session.project);

    res.json({ status: 'initialized', sessionDbId, port: getWorkerPort() });
  });

  /**
   * Queue observations for processing
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleObservations = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { tool_name, tool_input, tool_response, prompt_number, cwd } = req.body;

    this.sessionManager.queueObservation(sessionDbId, {
      tool_name,
      tool_input,
      tool_response,
      prompt_number,
      cwd
    });

    // CRITICAL: Ensure SDK agent is running to consume the queue
    await this.ensureGeneratorRunning(sessionDbId, 'observation');

    // Broadcast observation queued event
    this.eventBroadcaster.broadcastObservationQueued(sessionDbId);

    res.json({ status: 'queued' });
  });

  /**
   * Queue summarize request
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleSummarize = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { last_assistant_message } = req.body;

    this.sessionManager.queueSummarize(sessionDbId, last_assistant_message);

    // CRITICAL: Ensure SDK agent is running to consume the queue
    await this.ensureGeneratorRunning(sessionDbId, 'summarize');

    // Broadcast summarize queued event
    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
  });

  /**
   * Get session status
   */
  private handleSessionStatus = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const session = this.sessionManager.getSession(sessionDbId);

    if (!session) {
      res.json({ status: 'not_found' });
      return;
    }

    res.json({
      status: 'active',
      sessionDbId,
      project: session.project,
      queueLength: session.pendingMessages.length,
      uptime: Date.now() - session.startTime
    });
  });

  /**
   * Delete a session
   */
  private handleSessionDelete = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    await this.completionHandler.completeByDbId(sessionDbId);

    res.json({ status: 'deleted' });
  });

  /**
   * Complete a session (backward compatibility for cleanup-hook)
   * cleanup-hook expects POST /sessions/:sessionDbId/complete instead of DELETE
   */
  private handleSessionComplete = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    await this.completionHandler.completeByDbId(sessionDbId);

    res.json({ success: true });
  });

  /**
   * Queue observations by contentSessionId (post-tool-use-hook uses this)
   * POST /api/sessions/observations
   * Body: { contentSessionId, tool_name, tool_input, tool_response, cwd }
   */
  private handleObservationsByClaudeId = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { contentSessionId, tool_name, tool_input, tool_response, cwd } = req.body;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId');
    }

    // Load skip tools from settings
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const skipTools = new Set(settings.CLAUDE_MEM_SKIP_TOOLS.split(',').map(t => t.trim()).filter(Boolean));

    // Skip low-value or meta tools
    if (skipTools.has(tool_name)) {
      logger.debug('SESSION', 'Skipping observation for tool', { tool_name });
      res.json({ status: 'skipped', reason: 'tool_excluded' });
      return;
    }

    // Skip meta-observations: file operations on session-memory files
    const fileOperationTools = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);
    if (fileOperationTools.has(tool_name) && tool_input) {
      const filePath = tool_input.file_path || tool_input.notebook_path;
      if (filePath && filePath.includes('session-memory')) {
        logger.debug('SESSION', 'Skipping meta-observation for session-memory file', {
          tool_name,
          file_path: filePath
        });
        res.json({ status: 'skipped', reason: 'session_memory_meta' });
        return;
      }
    }

    const store = this.dbManager.getSessionStore();

    // Get or create session
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');
    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      promptNumber,
      'observation',
      sessionDbId,
      { tool_name }
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    // Strip memory tags from tool_input and tool_response
    const cleanedToolInput = tool_input !== undefined
      ? stripMemoryTagsFromJson(JSON.stringify(tool_input))
      : '{}';

    const cleanedToolResponse = tool_response !== undefined
      ? stripMemoryTagsFromJson(JSON.stringify(tool_response))
      : '{}';

    // Queue observation
    this.sessionManager.queueObservation(sessionDbId, {
      tool_name,
      tool_input: cleanedToolInput,
      tool_response: cleanedToolResponse,
      prompt_number: promptNumber,
      cwd: cwd || (() => {
        logger.error('SESSION', 'Missing cwd when queueing observation in SessionRoutes', {
          sessionId: sessionDbId,
          tool_name
        });
        return '';
      })()
    });

    // Ensure SDK agent is running
    await this.ensureGeneratorRunning(sessionDbId, 'observation');

    // Broadcast observation queued event
    this.eventBroadcaster.broadcastObservationQueued(sessionDbId);

    res.json({ status: 'queued' });
  });

  /**
   * Queue summarize by contentSessionId (summary-hook uses this)
   * POST /api/sessions/summarize
   * Body: { contentSessionId, last_assistant_message }
   *
   * Checks privacy, queues summarize request for SDK agent
   */
  private handleSummarizeByClaudeId = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { contentSessionId, last_assistant_message } = req.body;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId');
    }

    const store = this.dbManager.getSessionStore();

    // Get or create session
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');
    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId);

    // BATCHING: Flush any pending observations before summarizing (end of turn)
    // This is the primary flush trigger - ensures all observations are processed
    this.sessionManager.flushBatch(sessionDbId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      promptNumber,
      'summarize',
      sessionDbId
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    // Queue summarize
    this.sessionManager.queueSummarize(sessionDbId, last_assistant_message);

    // Ensure SDK agent is running
    await this.ensureGeneratorRunning(sessionDbId, 'summarize');

    // Broadcast summarize queued event
    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
  });

  /**
   * Initialize session by contentSessionId (new-hook uses this)
   * POST /api/sessions/init
   * Body: { contentSessionId, project, prompt }
   *
   * Performs all session initialization DB operations:
   * - Creates/gets SDK session (idempotent)
   * - Increments prompt counter
   * - Saves user prompt (with privacy tag stripping)
   *
   * Returns: { sessionDbId, promptNumber, skipped: boolean, reason?: string }
   */
  private handleSessionInitByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId, project, prompt } = req.body;

    logger.info('HTTP', 'SessionRoutes: handleSessionInitByClaudeId called', {
      contentSessionId,
      project,
      prompt_length: prompt?.length
    });

    // Validate required parameters
    if (!this.validateRequired(req, res, ['contentSessionId', 'project', 'prompt'])) {
      return;
    }

    const store = this.dbManager.getSessionStore();

    // Step 1: Create/get SDK session (idempotent INSERT OR IGNORE)
    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt);

    // BATCHING: Flush any pending observations from previous turn before starting new one
    // This ensures observations are processed even if idle timeout didn't fire
    this.sessionManager.flushBatch(sessionDbId);

    // Verify session creation with DB lookup
    const dbSession = store.getSessionById(sessionDbId);
    const isNewSession = !dbSession?.memory_session_id;
    logger.info('SESSION', `CREATED | contentSessionId=${contentSessionId} → sessionDbId=${sessionDbId} | isNew=${isNewSession} | project=${project}`, {
      sessionId: sessionDbId
    });

    // Step 2: Get next prompt number from user_prompts count
    const currentCount = store.getPromptNumberFromUserPrompts(contentSessionId);
    const promptNumber = currentCount + 1;

    // Debug-level alignment logs for detailed tracing
    const memorySessionId = dbSession?.memory_session_id || null;
    if (promptNumber > 1) {
      logger.debug('HTTP', `[ALIGNMENT] DB Lookup Proof | contentSessionId=${contentSessionId} → memorySessionId=${memorySessionId || '(not yet captured)'} | prompt#=${promptNumber}`);
    } else {
      logger.debug('HTTP', `[ALIGNMENT] New Session | contentSessionId=${contentSessionId} | prompt#=${promptNumber} | memorySessionId will be captured on first SDK response`);
    }

    // Step 3: Strip privacy tags from prompt
    const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

    // Step 4: Check if prompt is entirely private
    if (!cleanedPrompt || cleanedPrompt.trim() === '') {
      logger.debug('HOOK', 'Session init - prompt entirely private', {
        sessionId: sessionDbId,
        promptNumber,
        originalLength: prompt.length
      });

      res.json({
        sessionDbId,
        promptNumber,
        skipped: true,
        reason: 'private'
      });
      return;
    }

    // Step 5: Save cleaned user prompt
    store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt);

    // Debug-level log since CREATED already logged the key info
    logger.debug('SESSION', 'User prompt saved', {
      sessionId: sessionDbId,
      promptNumber
    });

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false
    });
  });
}
