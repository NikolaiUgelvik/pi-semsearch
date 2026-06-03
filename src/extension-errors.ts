class IndexUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IndexUnavailableError"
  }
}

function isStoreUnavailableError(error: unknown) {
  const message = formatThrownError(error).toLowerCase()
  return (
    message.includes("sqlite") ||
    message.includes("database") ||
    message.includes("index unavailable") ||
    message.includes("failed to open") ||
    message.includes("unable to open")
  )
}

function formatThrownError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export { formatThrownError, IndexUnavailableError, isStoreUnavailableError }
