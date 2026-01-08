import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  /**
   * Create an async iterator that yields messages as they become available.
   * Uses atomic claim-and-delete to prevent duplicates.
   * The queue is a pure buffer: claim it, delete it, process in memory.
   * Waits for 'message' event when queue is empty.
   */
  async *createIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId> {
    while (!signal.aborted) {
      try {
        // Atomically claim AND DELETE next message from DB
        // Message is now in memory only - no "processing" state tracking needed
        const persistentMessage = this.store.claimAndDelete(sessionDbId);

        if (persistentMessage) {
          // Yield the message for processing (it's already deleted from queue)
          yield this.toPendingMessageWithId(persistentMessage);
        } else {
          // Queue empty - wait for wake-up event
          await this.waitForMessage(signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        logger.error('SESSION', 'Error in queue processor loop', { sessionDbId }, error as Error);
        // Small backoff to prevent tight loop on DB error
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Create an async iterator that yields BATCHES of messages.
   * After wake-up, drains all available messages and yields them as a single batch.
   * This enables batch prompt construction for cost reduction.
   */
  async *createBatchIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId[]> {
    while (!signal.aborted) {
      try {
        // Drain all available messages from queue
        const batch: PendingMessageWithId[] = [];
        let persistentMessage = this.store.claimAndDelete(sessionDbId);

        while (persistentMessage) {
          batch.push(this.toPendingMessageWithId(persistentMessage));
          persistentMessage = this.store.claimAndDelete(sessionDbId);
        }

        if (batch.length > 0) {
          // Yield the entire batch for processing
          logger.info('BATCH', `BATCH_YIELD | sessionDbId=${sessionDbId} | count=${batch.length}`, {
            sessionId: sessionDbId
          });
          yield batch;
        } else {
          // Queue empty - wait for wake-up event (flush signal)
          await this.waitForMessage(signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        logger.error('SESSION', 'Error in batch processor loop', { sessionDbId }, error as Error);
        // Small backoff to prevent tight loop on DB error
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private toPendingMessageWithId(msg: PersistentPendingMessage): PendingMessageWithId {
    const pending = this.store.toPendingMessage(msg);
    return {
      ...pending,
      _persistentId: msg.id,
      _originalTimestamp: msg.created_at_epoch
    };
  }

  private waitForMessage(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const onMessage = () => {
        cleanup();
        resolve();
      };

      const onAbort = () => {
        cleanup();
        resolve(); // Resolve to let the loop check signal.aborted and exit
      };

      const cleanup = () => {
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
