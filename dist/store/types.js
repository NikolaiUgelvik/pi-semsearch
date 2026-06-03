class CorruptIndexError extends Error {
    constructor(cause) {
        super("corrupt persisted index", { cause });
        this.name = "CorruptIndexError";
    }
}
function chunkForStorage(chunk) {
    const { text: _text, embedding: _embedding, ...storedChunk } = chunk;
    return storedChunk;
}
export { CorruptIndexError, chunkForStorage };
