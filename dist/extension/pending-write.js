class PendingWriteTracker {
    refreshes = new Map();
    has(toolCallId) {
        return this.refreshes.has(toolCallId);
    }
    track(toolCallId) {
        if (this.refreshes.has(toolCallId)) {
            return;
        }
        let resolvePending;
        const promise = new Promise((resolve) => {
            resolvePending = resolve;
        });
        this.refreshes.set(toolCallId, { promise, resolve: resolvePending, resultSeen: false });
    }
    markResultSeen(toolCallId) {
        const pending = this.refreshes.get(toolCallId);
        if (pending) {
            pending.resultSeen = true;
        }
        return pending !== undefined;
    }
    resolveUnseen(toolCallId) {
        const pending = this.refreshes.get(toolCallId);
        if (pending && !pending.resultSeen) {
            this.resolve(toolCallId);
        }
    }
    resolve(toolCallId) {
        const pending = this.refreshes.get(toolCallId);
        if (!pending) {
            return;
        }
        this.refreshes.delete(toolCallId);
        pending.resolve();
    }
    resolveAll() {
        for (const toolCallId of this.refreshes.keys()) {
            this.resolve(toolCallId);
        }
    }
    async waitForAll() {
        await Promise.all([...this.refreshes.values()].map((pending) => pending.promise));
    }
}
export { PendingWriteTracker };
