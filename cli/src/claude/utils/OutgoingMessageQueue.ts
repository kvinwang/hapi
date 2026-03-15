/**
 * Outgoing Message Queue with strict ordering using incremental IDs
 * 
 * Ensures messages are always sent in the order they were received,
 * while allowing delayed messages to be released early when needed.
 */

import { AsyncLock } from '@/utils/lock';
import { logger } from '@/ui/logger';

interface QueueItem {
    id: number;                    // Incremental ID for ordering
    logMessage: any;               
    delayed: boolean;              // Whether this message should be delayed
    delayMs: number;               // Delay duration (e.g., 250ms)
    toolCallIds?: string[];        // Tool calls to track for early release
    released: boolean;             // Whether delay has been released
    sent: boolean;                 // Whether message has been sent
}

export class OutgoingMessageQueue {
    private queue: QueueItem[] = [];
    private nextId = 1;
    private lock = new AsyncLock();
    private processTimer?: NodeJS.Timeout;
    private delayTimers = new Map<number, NodeJS.Timeout>();
    private drainWaiters: Array<() => void> = [];
    private enqueueCount = 0;
    private sentCount = 0;
    private scheduleCount = 0;
    private processCount = 0;
    private lastEnqueueAt: number | null = null;
    private lastProcessAt: number | null = null;
    private lastSendAt: number | null = null;
    
    constructor(private sendFunction: (message: any) => void) {}
    
    /**
     * Add message to queue
     */
    enqueue(logMessage: any, options?: {
        delay?: number,
        toolCallIds?: string[]
    }) {
        this.lock.inLock(async () => {
            const item: QueueItem = {
                id: this.nextId++,
                logMessage,
                delayed: !!options?.delay,
                delayMs: options?.delay || 0,
                toolCallIds: options?.toolCallIds,
                released: !options?.delay,  // Not delayed = already released
                sent: false
            };
            
            this.queue.push(item);
            this.enqueueCount += 1;
            this.lastEnqueueAt = Date.now();
            
            // If delayed, set timer to release it
            if (item.delayed) {
                const timer = setTimeout(() => {
                    this.releaseItem(item.id);
                }, item.delayMs);
                this.delayTimers.set(item.id, timer);
            }

            // Try to process queue after item is actually inserted.
            this.scheduleProcessing('enqueue');
        });
    }
    
    /**
     * Release specific item by ID
     */
    private async releaseItem(itemId: number): Promise<void> {
        await this.lock.inLock(async () => {
            const item = this.queue.find(i => i.id === itemId);
            if (item && !item.released) {
                item.released = true;
                
                // Clear timer if exists
                const timer = this.delayTimers.get(itemId);
                if (timer) {
                    clearTimeout(timer);
                    this.delayTimers.delete(itemId);
                }
            }
        });
        
        this.scheduleProcessing('release-item');
    }
    
    /**
     * Release all messages with specific tool call ID
     */
    async releaseToolCall(toolCallId: string): Promise<void> {
        await this.lock.inLock(async () => {
            for (const item of this.queue) {
                if (item.toolCallIds?.includes(toolCallId) && !item.released) {
                    item.released = true;
                    
                    // Clear timer if exists
                    const timer = this.delayTimers.get(item.id);
                    if (timer) {
                        clearTimeout(timer);
                        this.delayTimers.delete(item.id);
                    }
                }
            }
        });
        
        this.scheduleProcessing('release-tool-call');
    }
    
    /**
     * Process queue - send messages in ID order that are released
     * (Internal implementation without lock)
     */
    private processQueueInternal(): void {
        this.processCount += 1;
        this.lastProcessAt = Date.now();
        // Sort by ID to ensure order
        this.queue.sort((a, b) => a.id - b.id);
        
        // Process from front of queue
        while (this.queue.length > 0) {
            const item = this.queue[0];
            
            // If not released yet, stop processing (maintain order)
            if (!item.released) {
                break;
            }
            
            // Send if not already sent
            if (!item.sent) {
                if (item.logMessage.type !== 'system') {
                    this.sendFunction(item.logMessage);
                    this.sentCount += 1;
                    this.lastSendAt = Date.now();
                }
                item.sent = true;
            }
            
            // Remove from queue
            this.queue.shift();
        }

        if (this.queue.length === 0) {
            this.resolveDrainWaiters();
        }
    }
    
    /**
     * Process queue - send messages in ID order that are released
     */
    private async processQueue(): Promise<void> {
        await this.lock.inLock(async () => {
            this.processQueueInternal();
        });
    }
    
    /**
     * Flush all messages immediately (for cleanup)
     */
    async flush(): Promise<void> {
        await this.lock.inLock(async () => {
            // Clear all delay timers
            for (const timer of this.delayTimers.values()) {
                clearTimeout(timer);
            }
            this.delayTimers.clear();
            
            // Mark all as released
            for (const item of this.queue) {
                item.released = true;
            }
            
            // Process everything - use internal method since we already have the lock
            this.processQueueInternal();
        });
    }

    /**
     * Wait until queue is fully drained.
     * Returns false on timeout.
     */
    async waitForDrain(timeoutMs?: number): Promise<boolean> {
        const isEmpty = await this.lock.inLock(async () => this.queue.length === 0);
        if (isEmpty) {
            return true;
        }

        return await new Promise<boolean>((resolve) => {
            let timeout: NodeJS.Timeout | null = null;
            let settled = false;

            const finish = (ok: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timeout) {
                    clearTimeout(timeout);
                }
                resolve(ok);
            };

            this.drainWaiters.push(() => finish(true));

            if (typeof timeoutMs === 'number' && timeoutMs > 0) {
                timeout = setTimeout(() => finish(false), timeoutMs);
            }
        });
    }

    async getDebugState(): Promise<{
        queueLength: number
        delayedTimerCount: number
        enqueueCount: number
        sentCount: number
        scheduleCount: number
        processCount: number
        nextId: number
        head?: {
            id: number
            delayed: boolean
            released: boolean
            sent: boolean
            hasToolCallIds: boolean
            logType?: string
        }
        lastEnqueueAt: number | null
        lastProcessAt: number | null
        lastSendAt: number | null
    }> {
        return await this.lock.inLock(async () => {
            const head = this.queue[0];
            return {
                queueLength: this.queue.length,
                delayedTimerCount: this.delayTimers.size,
                enqueueCount: this.enqueueCount,
                sentCount: this.sentCount,
                scheduleCount: this.scheduleCount,
                processCount: this.processCount,
                nextId: this.nextId,
                head: head ? {
                    id: head.id,
                    delayed: head.delayed,
                    released: head.released,
                    sent: head.sent,
                    hasToolCallIds: Boolean(head.toolCallIds && head.toolCallIds.length > 0),
                    logType: typeof head.logMessage?.type === 'string' ? head.logMessage.type : undefined
                } : undefined,
                lastEnqueueAt: this.lastEnqueueAt,
                lastProcessAt: this.lastProcessAt,
                lastSendAt: this.lastSendAt
            };
        });
    }
    
    /**
     * Process queue inline when already holding the lock.
     *
     * Previous implementation deferred processing to a setTimeout(0), but each
     * new enqueue call would clearTimeout the previous timer and set a new one.
     * Because `for await` loop iterations and lock.inLock callbacks are
     * microtasks, the macrotask timer could be continuously cancelled before it
     * ever fired — causing messages to accumulate in the queue indefinitely.
     *
     * Now we simply process inline (we are already inside the lock) which
     * guarantees messages are sent as soon as they are enqueued.
     */
    private scheduleProcessing(reason: 'enqueue' | 'release-item' | 'release-tool-call'): void {
        this.scheduleCount += 1;
        // Process immediately — we are already inside the lock
        this.processQueueInternal();
    }

    private resolveDrainWaiters(): void {
        if (this.drainWaiters.length === 0) {
            return;
        }
        const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
        for (const waiter of waiters) {
            waiter();
        }
    }
    
    /**
     * Cleanup timers and resources
     */
    destroy(): void {
        if (this.processTimer) {
            clearTimeout(this.processTimer);
        }
        
        for (const timer of this.delayTimers.values()) {
            clearTimeout(timer);
        }
        this.delayTimers.clear();
        this.resolveDrainWaiters();
    }
}
