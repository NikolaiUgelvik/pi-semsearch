interface PendingWriteRefresh {
  promise: Promise<void>
  resolve(): void
  resultSeen: boolean
}

class PendingWriteTracker {
  private readonly refreshes = new Map<string, PendingWriteRefresh>()

  has(toolCallId: string) {
    return this.refreshes.has(toolCallId)
  }

  track(toolCallId: string) {
    if (this.refreshes.has(toolCallId)) {
      return
    }
    let resolvePending!: () => void
    const promise = new Promise<void>((resolve) => {
      resolvePending = resolve
    })
    this.refreshes.set(toolCallId, { promise, resolve: resolvePending, resultSeen: false })
  }

  markResultSeen(toolCallId: string) {
    const pending = this.refreshes.get(toolCallId)
    if (pending) {
      pending.resultSeen = true
    }
    return pending !== undefined
  }

  resolveUnseen(toolCallId: string) {
    const pending = this.refreshes.get(toolCallId)
    if (pending && !pending.resultSeen) {
      this.resolve(toolCallId)
    }
  }

  resolve(toolCallId: string) {
    const pending = this.refreshes.get(toolCallId)
    if (!pending) {
      return
    }
    this.refreshes.delete(toolCallId)
    pending.resolve()
  }

  resolveAll() {
    for (const toolCallId of this.refreshes.keys()) {
      this.resolve(toolCallId)
    }
  }

  async waitForAll() {
    await Promise.all([...this.refreshes.values()].map((pending) => pending.promise))
  }
}

export { PendingWriteTracker }
