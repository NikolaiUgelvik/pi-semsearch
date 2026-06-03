class IndexUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "IndexUnavailableError";
    }
}
function isStoreUnavailableError(error) {
    const message = formatThrownError(error).toLowerCase();
    return (message.includes("sqlite") ||
        message.includes("database") ||
        message.includes("index unavailable") ||
        message.includes("failed to open") ||
        message.includes("unable to open"));
}
function formatThrownError(error) {
    return error instanceof Error ? error.message : String(error);
}
export { formatThrownError, IndexUnavailableError, isStoreUnavailableError };
