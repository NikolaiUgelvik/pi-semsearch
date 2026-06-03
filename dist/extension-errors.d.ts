declare class IndexUnavailableError extends Error {
    constructor(message: string);
}
declare function isStoreUnavailableError(error: unknown): boolean;
declare function formatThrownError(error: unknown): string;
export { formatThrownError, IndexUnavailableError, isStoreUnavailableError };
