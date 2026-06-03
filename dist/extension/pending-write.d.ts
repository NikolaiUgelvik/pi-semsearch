declare class PendingWriteTracker {
    private readonly refreshes;
    has(toolCallId: string): boolean;
    track(toolCallId: string): void;
    markResultSeen(toolCallId: string): boolean;
    resolveUnseen(toolCallId: string): void;
    resolve(toolCallId: string): void;
    resolveAll(): void;
    waitForAll(): Promise<void>;
}
export { PendingWriteTracker };
