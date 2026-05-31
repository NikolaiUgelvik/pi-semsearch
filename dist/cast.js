import { fallbackChunks } from "./fallback.js";
import { nonWhitespaceLength, rangeForSlice, stableChunkId, textForByteSlice } from "./range.js";
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/;
const PUNCTUATION_OR_SYMBOL_PATTERN = /^[\p{P}\p{S}\s]+$/u;
export function castChunks(input) {
    if (nonWhitespaceLength(input.source) <= input.maxNonWhitespaceChars) {
        return [makeChunk(input, "file", input.root.startIndex, input.root.endIndex, [input.root.type])];
    }
    if (input.root.children.length === 0) {
        return fallbackChunks({
            filePath: input.filePath,
            language: input.language,
            text: input.source,
            maxNonWhitespaceChars: input.maxNonWhitespaceChars,
        });
    }
    const windows = buildWindows(input, input.root.children, undefined);
    const normalized = normalizeTrivialWindows(input, windows);
    const overlapped = applyOverlap(normalized, input.chunking.overlap);
    return linkSiblings(overlapped.map((window) => makeChunkFromWindow(input, window)));
}
function buildWindows(input, nodes, parentChunkId) {
    const windows = [];
    let pending = [];
    for (const child of nodes) {
        if (nodeNonWhitespace(input, child) > input.maxNonWhitespaceChars) {
            const prefix = flushWindow(pending, parentChunkId);
            pending = [];
            windows.push(...mergePrefixWithFirstSplitWindow(input, prefix, splitOversizedNode(input, child)));
            continue;
        }
        if (pending.length > 0 &&
            rangeNonWhitespace(input, pending[0].startIndex, child.endIndex) > input.maxNonWhitespaceChars) {
            windows.push(...flushWindow(pending, parentChunkId));
            pending = [];
        }
        pending.push(child);
    }
    windows.push(...flushWindow(pending, parentChunkId));
    return windows;
}
function mergePrefixWithFirstSplitWindow(input, prefix, split) {
    if (prefix.length !== 1 || !split[0]) {
        return [...prefix, ...split];
    }
    if (rangeNonWhitespace(input, prefix[0].byteStart, split[0].byteEnd) > input.maxNonWhitespaceChars) {
        return [...prefix, ...split];
    }
    return [mergeWindows(prefix[0], split[0]), ...split.slice(1)];
}
function splitOversizedNode(input, node) {
    const parentChunkId = stableChunkId(input.filePath, node.startIndex, node.endIndex);
    if (node.children.length === 0) {
        return fallbackChunks({
            filePath: input.filePath,
            language: input.language,
            text: textForByteSlice(input.source, node.startIndex, node.endIndex),
            maxNonWhitespaceChars: input.maxNonWhitespaceChars,
        }).map((chunk) => ({
            nodes: [],
            byteStart: node.startIndex + chunk.range.byteStart,
            byteEnd: node.startIndex + chunk.range.byteEnd,
            nodeTypes: [node.type],
            kind: chunk.kind,
            parentChunkId,
            parentByteStart: node.startIndex,
            parentByteEnd: node.endIndex,
        }));
    }
    return mergeAdjacentWindows(input, buildWindows(input, node.children, parentChunkId)).map((window) => ({
        ...window,
        parentByteStart: window.parentByteStart ?? node.startIndex,
        parentByteEnd: window.parentByteEnd ?? node.endIndex,
    }));
}
function flushWindow(pending, parentChunkId) {
    const first = pending[0];
    const last = pending.at(-1);
    if (!(first && last)) {
        return [];
    }
    return [windowForNodes(first.startIndex, last.endIndex, pending, parentChunkId)];
}
function windowForNodes(byteStart, byteEnd, nodes, parentChunkId) {
    return {
        nodes,
        byteStart,
        byteEnd,
        nodeTypes: nodes.map((node) => node.type),
        parentChunkId,
    };
}
function mergeAdjacentWindows(input, windows) {
    const merged = [];
    for (const window of windows) {
        const previous = merged.at(-1);
        if (previous && rangeNonWhitespace(input, previous.byteStart, window.byteEnd) <= input.maxNonWhitespaceChars) {
            merged[merged.length - 1] = mergeWindows(previous, window);
            continue;
        }
        merged.push(window);
    }
    return merged;
}
function mergeWindows(left, right) {
    const byteStart = left.byteStart;
    const byteEnd = right.byteEnd;
    return {
        nodes: [...left.nodes, ...right.nodes],
        byteStart,
        byteEnd,
        nodeTypes: [...left.nodeTypes, ...right.nodeTypes],
        kind: left.kind ?? right.kind,
        ...parentMetadataForRange(byteStart, byteEnd, left, right),
    };
}
function parentMetadataForRange(byteStart, byteEnd, left, right) {
    const parentChunkId = left.parentChunkId ?? right.parentChunkId;
    if (!parentChunkId) {
        return {};
    }
    const parentByteStart = left.parentByteStart ?? right.parentByteStart;
    const parentByteEnd = left.parentByteEnd ?? right.parentByteEnd;
    const parentBounds = { parentByteStart, parentByteEnd };
    if (!hasParentBounds(parentBounds)) {
        return { parentChunkId };
    }
    if (!rangeWithinParent(byteStart, byteEnd, parentBounds.parentByteStart, parentBounds.parentByteEnd)) {
        return {};
    }
    return { parentChunkId, parentByteStart: parentBounds.parentByteStart, parentByteEnd: parentBounds.parentByteEnd };
}
function hasParentBounds(input) {
    return input.parentByteStart !== undefined && input.parentByteEnd !== undefined;
}
function rangeWithinParent(byteStart, byteEnd, parentByteStart, parentByteEnd) {
    return byteStart >= parentByteStart && byteEnd <= parentByteEnd;
}
function normalizeTrivialWindows(input, windows) {
    const normalized = [];
    for (let index = 0; index < windows.length; index++) {
        const window = windows[index];
        if (!window) {
            continue;
        }
        if (!isTrivialWindow(input, window)) {
            normalized.push(window);
            continue;
        }
        const result = mergeTrivialWindow(input, normalized, windows, index, window);
        if (result.window) {
            normalized.push(result.window);
        }
        if (result.skipNext) {
            index++;
        }
    }
    return normalized;
}
function mergeTrivialWindow(input, normalized, windows, index, window) {
    const previous = normalized.at(-1);
    if (previous && rangeNonWhitespace(input, previous.byteStart, window.byteEnd) <= input.maxNonWhitespaceChars) {
        normalized[normalized.length - 1] = mergeWindows(previous, window);
        return { skipNext: false };
    }
    const next = windows[index + 1];
    if (next && rangeNonWhitespace(input, window.byteStart, next.byteEnd) <= input.maxNonWhitespaceChars) {
        return { window: mergeWindows(window, next), skipNext: true };
    }
    return { window, skipNext: false };
}
function isTrivialWindow(input, window) {
    const text = textForByteSlice(input.source, window.byteStart, window.byteEnd).trim();
    return (nonWhitespaceLength(text) < input.chunking.minSemanticNonWhitespaceChars ||
        !IDENTIFIER_PATTERN.test(text) ||
        PUNCTUATION_OR_SYMBOL_PATTERN.test(text));
}
function applyOverlap(windows, overlap) {
    if (overlap === 0) {
        return windows;
    }
    return windows.map((window, index) => {
        const previous = windows.slice(Math.max(0, index - overlap), index);
        const next = windows.slice(index + 1, index + 1 + overlap);
        const expanded = [...previous, window, ...next];
        const merged = expanded.reduce((merged, current) => mergeWindows(merged, current));
        return {
            ...merged,
            idByteStart: window.byteStart,
            idByteEnd: window.byteEnd,
            parentChunkId: parentChunkIdForOverlap(window, merged),
            parentByteStart: window.parentByteStart,
            parentByteEnd: window.parentByteEnd,
        };
    });
}
function parentChunkIdForOverlap(origin, expanded) {
    if (!(origin.parentChunkId && origin.parentByteStart !== undefined && origin.parentByteEnd !== undefined)) {
        return;
    }
    if (expanded.byteStart < origin.parentByteStart || expanded.byteEnd > origin.parentByteEnd) {
        return;
    }
    return origin.parentChunkId;
}
function makeChunkFromWindow(input, window) {
    return makeChunk(input, window.kind ?? kindFor(window.nodeTypes), window.byteStart, window.byteEnd, window.nodeTypes, window.parentChunkId, window.idByteStart, window.idByteEnd);
}
function nodeNonWhitespace(input, node) {
    return rangeNonWhitespace(input, node.startIndex, node.endIndex);
}
function rangeNonWhitespace(input, byteStart, byteEnd) {
    return nonWhitespaceLength(textForByteSlice(input.source, byteStart, byteEnd));
}
function makeChunk(input, kind, byteStart, byteEnd, nodeTypes, parentChunkId, idByteStart, idByteEnd) {
    return {
        id: stableChunkId(input.filePath, idByteStart ?? byteStart, idByteEnd ?? byteEnd),
        filePath: input.filePath,
        language: input.language,
        kind,
        range: rangeForSlice(input.source, byteStart, byteEnd),
        text: textForByteSlice(input.source, byteStart, byteEnd),
        nonWhitespaceChars: nonWhitespaceLength(textForByteSlice(input.source, byteStart, byteEnd)),
        nodeTypes,
        symbolIds: [],
        parentChunkId,
        childChunkIds: [],
    };
}
function linkSiblings(chunks) {
    return chunks.map((chunk, index) => ({
        ...chunk,
        previousSiblingChunkId: chunks[index - 1]?.id,
        nextSiblingChunkId: chunks[index + 1]?.id,
    }));
}
function kindFor(nodeTypes) {
    if (nodeTypes.some((type) => type.includes("class"))) {
        return "class";
    }
    if (nodeTypes.some((type) => type.includes("method"))) {
        return "method";
    }
    if (nodeTypes.some((type) => type.includes("function"))) {
        return "function";
    }
    return "block";
}
