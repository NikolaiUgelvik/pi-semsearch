import { chunkBreadcrumbs, chunkMatchesSource, expandWithParentContext, summarizeChunk, summarizeTopology, } from "./topology.js";
async function getChunkById(input) {
    const diagnostics = [...input.index.metadata.diagnostics];
    const sourceCache = new Map();
    const getSource = (filePath) => readSourceCached(filePath, input.readSource, sourceCache);
    const chunk = input.index.chunks[input.input.id];
    if (!chunk) {
        if (input.index.metadata.status !== "ready") {
            return {
                status: input.index.metadata,
                diagnostics: [...diagnostics, `index unavailable: ${input.index.metadata.status}`],
            };
        }
        return {
            status: input.index.metadata,
            diagnostics: [...diagnostics, `chunk not found: ${input.input.id}`],
        };
    }
    const source = await getSource(chunk.filePath);
    const chunkText = validatedChunkText(chunk, source, diagnostics, "chunk text omitted");
    const context = parentContext({
        chunk,
        diagnostics,
        includeParents: input.input.includeParents,
        index: input.index,
        maxContextChars: input.input.maxContextChars,
        source,
    });
    const related = await relatedChunks({
        chunk,
        childrenLimit: input.input.childrenLimit,
        childrenOffset: input.input.childrenOffset,
        chunks: input.index.chunks,
        diagnostics,
        getSource,
        includeChildren: input.input.includeChildren,
        includeParents: input.input.includeParents,
        includeSiblings: input.input.includeSiblings,
        maxContextChars: input.input.maxContextChars,
        symbols: input.index.symbols,
    });
    return {
        status: input.index.metadata,
        chunk: {
            filePath: chunk.filePath,
            language: chunk.language,
            range: chunk.range,
            kind: chunk.kind,
            breadcrumbs: context.breadcrumbs,
            text: chunkText,
            parentText: context.parentText,
            parentRange: context.parentRange,
            topology: summarizeTopology(chunk, input.index.chunks, input.index.symbols),
            related,
        },
        diagnostics,
    };
}
const DEFAULT_CHILDREN_LIMIT = 20;
function parentContext(input) {
    if (input.includeParents === false) {
        return { breadcrumbs: chunkBreadcrumbs(input.chunk, input.index.symbols) };
    }
    if (input.source.ok && chunkMatchesSource(input.source.text, input.chunk)) {
        return expandWithParentContext({
            chunk: input.chunk,
            symbols: input.index.symbols,
            source: input.source.text,
            maxContextChars: input.maxContextChars ?? Number.MAX_SAFE_INTEGER,
        });
    }
    if (input.source.ok) {
        input.diagnostics.push(`source mismatch for ${input.chunk.filePath}:${input.chunk.id}; parent context omitted`);
    }
    else {
        input.diagnostics.push(`source read failed for ${input.chunk.filePath}; parent context omitted`);
    }
    return { breadcrumbs: chunkBreadcrumbs(input.chunk, input.index.symbols) };
}
async function relatedChunks(input) {
    const childrenPage = childPage({
        childChunkIds: input.chunk.childChunkIds,
        includeChildren: input.includeChildren,
        limit: input.childrenLimit,
        offset: input.childrenOffset,
    });
    const [parent, previousSibling, nextSibling, children] = await Promise.all([
        input.includeParents === false
            ? undefined
            : relatedChunk({
                chunk: input.chunks[input.chunk.parentChunkId ?? ""],
                symbols: input.symbols,
                maxContextChars: input.maxContextChars,
                diagnostics: input.diagnostics,
                getSource: input.getSource,
            }),
        input.includeSiblings === false
            ? undefined
            : relatedChunk({
                chunk: input.chunks[input.chunk.previousSiblingChunkId ?? ""],
                symbols: input.symbols,
                maxContextChars: input.maxContextChars,
                diagnostics: input.diagnostics,
                getSource: input.getSource,
            }),
        input.includeSiblings === false
            ? undefined
            : relatedChunk({
                chunk: input.chunks[input.chunk.nextSiblingChunkId ?? ""],
                symbols: input.symbols,
                maxContextChars: input.maxContextChars,
                diagnostics: input.diagnostics,
                getSource: input.getSource,
            }),
        Promise.all(childrenPage.childIds.map((id) => relatedChunk({
            chunk: input.chunks[id],
            symbols: input.symbols,
            maxContextChars: input.maxContextChars,
            diagnostics: input.diagnostics,
            getSource: input.getSource,
        }))),
    ]);
    return {
        parent,
        previousSibling,
        nextSibling,
        children: children.flatMap((child) => (child ? [child] : [])),
        childrenPage: childrenPage.page,
    };
}
function childPage(input) {
    const total = input.childChunkIds.length;
    if (input.includeChildren === false) {
        return { childIds: [], page: { offset: 0, limit: 0, total, hasMore: false } };
    }
    const offset = Math.max(input.offset ?? 0, 0);
    const limit = Math.max(input.limit ?? DEFAULT_CHILDREN_LIMIT, 0);
    return {
        childIds: input.childChunkIds.slice(offset, offset + limit),
        page: { offset, limit, total, hasMore: offset + limit < total },
    };
}
async function relatedChunk(input) {
    if (!input.chunk) {
        return;
    }
    const source = await input.getSource(input.chunk.filePath);
    const text = validatedChunkText(input.chunk, source, input.diagnostics, "related chunk text omitted");
    return {
        ...summarizeChunk(input.chunk, input.symbols),
        text: input.maxContextChars === undefined ? text : text.slice(0, input.maxContextChars),
    };
}
function validatedChunkText(chunk, source, diagnostics, omittedReason) {
    if (!source.ok) {
        diagnostics.push(`source read failed for ${chunk.filePath}:${chunk.id}; ${omittedReason}`);
        return "";
    }
    if (!chunkMatchesSource(source.text, chunk)) {
        diagnostics.push(`source mismatch for ${chunk.filePath}:${chunk.id}; ${omittedReason}`);
        return "";
    }
    return chunk.text;
}
function readSourceCached(filePath, readSource, sourceCache) {
    const cached = sourceCache.get(filePath);
    if (cached) {
        return cached;
    }
    const source = readSource(filePath)
        .then((text) => ({ text, ok: true }))
        .catch(() => ({ text: "", ok: false }));
    sourceCache.set(filePath, source);
    return source;
}
export { getChunkById };
