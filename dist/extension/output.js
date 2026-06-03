import path from "node:path";
import { env } from "node:process";
import { Minimatch } from "minimatch";
const COMPACTION_DIAGNOSTIC = "output compacted; use semantic_get_chunk for more context";
const LOOKUP_COMPACTION_DIAGNOSTIC = "output compacted; narrow semantic_get_chunk args, page children, or reduce included relations";
const LONG_COMPACT_TEXT_LENGTH = 200;
const MEDIUM_COMPACT_TEXT_LENGTH = 80;
const SHORT_COMPACT_TEXT_LENGTH = 20;
const OMITTED_TEXT_LENGTH = 0;
const MANY_COMPACT_CHILDREN = 5;
const SINGLE_COMPACT_CHILD = 1;
const MAX_DIAGNOSTIC_SAMPLES = 5;
const NO_COMPACT_CHILDREN = 0;
const SEARCH_COMPACT_TEXT_LENGTHS = [
    LONG_COMPACT_TEXT_LENGTH,
    MEDIUM_COMPACT_TEXT_LENGTH,
    SHORT_COMPACT_TEXT_LENGTH,
    OMITTED_TEXT_LENGTH,
];
const LOOKUP_COMPACT_TEXT_LENGTHS = [LONG_COMPACT_TEXT_LENGTH, MEDIUM_COMPACT_TEXT_LENGTH, OMITTED_TEXT_LENGTH];
const LOOKUP_COMPACT_CHILD_LIMITS = [
    Number.MAX_SAFE_INTEGER,
    MANY_COMPACT_CHILDREN,
    SINGLE_COMPACT_CHILD,
    NO_COMPACT_CHILDREN,
];
const RETRIEVAL_DEBUG_ENV = "PI_SEMSEARCH_DEBUG_RETRIEVAL";
const DISABLED_ENV_VALUES = new Set(["", "0", "false", "no", "off"]);
function unavailableToolResult(title, message) {
    return {
        title,
        output: `index unavailable${message ? `: ${message}` : ""}`,
        metadata: { configured: true, available: false },
    };
}
function searchOutputForTool(output) {
    const diagnosticDetails = [...(output.status.diagnosticDetails ?? []), ...(output.diagnosticDetails ?? [])];
    const diagnostics = summarizeDiagnostics({
        diagnostics: [...output.status.diagnostics, ...output.diagnostics],
        details: diagnosticDetails,
    });
    const includeRetrievalDebug = retrievalDebugEnabled();
    const status = visibleStatusForTool(output.status, diagnostics, [
        ...output.results.map((result) => result.filePath),
        ...diagnosticFilePaths(diagnosticDetails),
    ]);
    return {
        results: output.results.map((result) => visibleSearchResult(result, includeRetrievalDebug)),
        status: includeRetrievalDebug ? status : statusWithoutRetrievalDebug(status),
    };
}
function visibleSearchResult(result, includeRetrievalDebug) {
    if (includeRetrievalDebug) {
        return result;
    }
    const { finalScore: _finalScore, retrieval: _retrieval, score: _score, ...visibleResult } = result;
    return visibleResult;
}
function statusWithoutRetrievalDebug(status) {
    const { bestScore: _bestScore, ...visibleStatus } = status;
    return visibleStatus;
}
function retrievalDebugEnabled() {
    const value = env[RETRIEVAL_DEBUG_ENV];
    return value !== undefined && !DISABLED_ENV_VALUES.has(value.toLowerCase());
}
function chunkLookupOutputForTool(output) {
    const diagnosticDetails = [...(output.status.diagnosticDetails ?? []), ...(output.diagnosticDetails ?? [])];
    const diagnostics = summarizeDiagnostics({
        diagnostics: [...output.status.diagnostics, ...output.diagnostics],
        details: diagnosticDetails,
    });
    return {
        ...(output.chunk ? { chunk: output.chunk } : {}),
        status: visibleStatusForTool(output.status, diagnostics, [
            ...(output.chunk ? [output.chunk.filePath] : []),
            ...diagnosticFilePaths(diagnosticDetails),
        ]),
    };
}
function visibleStatusForTool(status, diagnostics, relevantPaths) {
    const { projectId: _projectId, cacheKey: _cacheKey, includeGlobs, excludeGlobs, diagnosticDetails: _diagnosticDetails, diagnostics: _diagnostics, ...visibleStatus } = status;
    return {
        ...visibleStatus,
        ...matchedVisibleGlobs({ includeGlobs, excludeGlobs, relevantPaths }),
        diagnostics,
    };
}
function matchedVisibleGlobs(input) {
    const relevantPaths = [...new Set(input.relevantPaths.filter((filePath) => filePath.length > 0))];
    if (relevantPaths.length === 0) {
        return {};
    }
    const includeGlobs = matchedGlobs(input.includeGlobs ?? [], relevantPaths).filter((glob) => glob !== "**/*");
    const excludeGlobs = matchedGlobs(input.excludeGlobs ?? [], relevantPaths);
    return {
        ...(includeGlobs.length > 0 ? { includeGlobs } : {}),
        ...(excludeGlobs.length > 0 ? { excludeGlobs } : {}),
    };
}
function matchedGlobs(globs, relevantPaths) {
    return globs.filter((glob) => {
        const matcher = new Minimatch(glob, { dot: true });
        return relevantPaths.some((filePath) => matcher.match(toGlobPath(filePath)));
    });
}
function toGlobPath(filePath) {
    return filePath.split(path.sep).join("/");
}
function diagnosticFilePaths(details) {
    return details.flatMap((detail) => (detail.filePath ? [detail.filePath] : []));
}
function summarizeDiagnostics(input) {
    const details = uniqueDiagnosticDetails(input.details);
    const detailMessages = new Set(details.map((detail) => detail.message));
    const indexDiagnostics = details.filter((detail) => detail.code === "index.skipped_file");
    const sourceReadDiagnostics = details.filter((detail) => detail.code === "source.read_failed");
    const sourceMismatchDiagnostics = details.filter((detail) => detail.code === "source.mismatch");
    const grouped = new Set([...indexDiagnostics, ...sourceReadDiagnostics, ...sourceMismatchDiagnostics]);
    const detailDiagnostics = details.filter((detail) => !grouped.has(detail)).map((detail) => detail.message);
    const legacyDiagnostics = [...new Set(input.diagnostics.filter((diagnostic) => !detailMessages.has(diagnostic)))];
    const otherDiagnostics = [...detailDiagnostics, ...legacyDiagnostics];
    const summarized = [];
    if (indexDiagnostics.length > 0) {
        summarized.push(`${indexDiagnostics.length} index ${plural(indexDiagnostics.length, "diagnostic")} suppressed`);
    }
    summarized.push(...otherDiagnostics.slice(0, MAX_DIAGNOSTIC_SAMPLES));
    if (otherDiagnostics.length > MAX_DIAGNOSTIC_SAMPLES) {
        const suppressedCount = otherDiagnostics.length - MAX_DIAGNOSTIC_SAMPLES;
        summarized.push(`${suppressedCount} additional ${plural(suppressedCount, "diagnostic")} suppressed`);
    }
    if (sourceReadDiagnostics.length > 0) {
        summarized.push(`${sourceReadDiagnostics.length} source-read ${plural(sourceReadDiagnostics.length, "issue")} while hydrating chunks (sample: ${sourceReadDiagnostics[0]?.message})`);
    }
    if (sourceMismatchDiagnostics.length > 0) {
        summarized.push(`${sourceMismatchDiagnostics.length} source-mismatch ${plural(sourceMismatchDiagnostics.length, "issue")} while hydrating chunks (sample: ${sourceMismatchDiagnostics[0]?.message})`);
    }
    return summarized;
}
function uniqueDiagnosticDetails(details) {
    const seen = new Set();
    return details.filter((detail) => {
        const key = `${detail.code}\0${detail.message}\0${detail.filePath ?? ""}\0${detail.chunkId ?? ""}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function plural(count, word) {
    return count === 1 ? word : `${word}s`;
}
function serializeToolOutput(input) {
    const preferred = serializeJson(input.output);
    if (serializedFits(preferred, input.limits)) {
        return preferred;
    }
    const compacted = serializeJson(input.compact(input.output, input.limits));
    if (serializedFits(compacted, input.limits)) {
        return compacted;
    }
    const minimalOutput = input.minimal(input.output);
    const serializedMinimal = serializeJson(minimalOutput);
    if (serializedFits(serializedMinimal, input.limits)) {
        return serializedMinimal;
    }
    const compactMinimal = JSON.stringify(minimalOutput);
    if (serializedFits(compactMinimal, input.limits)) {
        return compactMinimal;
    }
    const diagnosticsOutput = input.diagnosticsFocused(input.output);
    const serializedDiagnostics = serializeJson(diagnosticsOutput);
    if (serializedFits(serializedDiagnostics, input.limits)) {
        return serializedDiagnostics;
    }
    const compactDiagnostics = JSON.stringify(diagnosticsOutput);
    return serializedFits(compactDiagnostics, input.limits)
        ? compactDiagnostics
        : forceFitSerialized(compactDiagnostics, input.limits);
}
function serializeJson(value) {
    return JSON.stringify(value, null, 2);
}
function serializedFits(serialized, limits) {
    return ((limits.maxBytes === undefined || Buffer.byteLength(serialized, "utf8") <= limits.maxBytes) &&
        (limits.maxLines === undefined || serialized.split("\n").length <= limits.maxLines));
}
function forceFitSerialized(serialized, limits) {
    let output = serialized;
    if (limits.maxLines !== undefined) {
        output = output.split("\n").slice(0, Math.max(limits.maxLines, 0)).join("\n");
    }
    if (limits.maxBytes !== undefined) {
        output = truncateUtf8(output, Math.max(limits.maxBytes, 0));
    }
    return output;
}
function truncateUtf8(value, maxBytes) {
    let output = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
    while (Buffer.byteLength(output, "utf8") > maxBytes) {
        output = output.slice(0, -1);
    }
    return output;
}
function compactSearchOutput(output, limits) {
    for (const maxTextLength of SEARCH_COMPACT_TEXT_LENGTHS) {
        const compacted = {
            ...output,
            results: output.results.map((result) => {
                const { parentText: _parentText, parentRange: _parentRange, text, ...rest } = result;
                return { ...rest, text: trimText(text, maxTextLength) };
            }),
            status: statusWithSearchCompaction(output.status),
        };
        if (serializedFits(serializeJson(compacted), limits)) {
            return compacted;
        }
    }
    return {
        ...output,
        results: output.results.map((result) => {
            const { parentText: _parentText, parentRange: _parentRange, text, ...rest } = result;
            return { ...rest, text: trimText(text, 0) };
        }),
        status: statusWithSearchCompaction(output.status),
    };
}
function minimalSearchOutput(output) {
    return {
        status: output.results.length === 0 ? statusWithSearchCompaction(output.status) : output.status,
        results: output.results.map((result, index) => ({
            rank: index + SINGLE_COMPACT_CHILD,
            id: result.topology.current.id,
            label: result.topology.current.label,
            range: result.topology.current.range,
            score: result.score,
            finalScore: result.finalScore,
            retrieval: result.retrieval,
        })),
    };
}
function diagnosticsFocusedSearchOutput(output) {
    return {
        status: output.status.status,
        resultCount: output.results.length,
        diagnostics: diagnosticsWithSearchCompaction(output.status.diagnostics),
    };
}
function compactChunkLookupOutput(output, limits) {
    for (const maxTextLength of LOOKUP_COMPACT_TEXT_LENGTHS) {
        for (const maxChildren of LOOKUP_COMPACT_CHILD_LIMITS) {
            const compacted = compactChunkLookupOutputWith(output, maxTextLength, maxChildren);
            if (serializedFits(serializeJson(compacted), limits)) {
                return compacted;
            }
        }
    }
    return compactChunkLookupOutputWith(output, 0, 0);
}
function compactChunkLookupOutputWith(output, maxTextLength, maxChildren) {
    if (!output.chunk) {
        return { ...output, status: statusWithLookupCompaction(output.status) };
    }
    const { parentText: _parentText, parentRange: _parentRange, text, related, ...chunk } = output.chunk;
    const children = related.children.slice(0, maxChildren).map(compactRelatedChunk);
    return {
        ...output,
        chunk: {
            ...chunk,
            text: trimText(text, maxTextLength),
            related: {
                parent: compactRelatedChunk(related.parent),
                previousSibling: compactRelatedChunk(related.previousSibling),
                nextSibling: compactRelatedChunk(related.nextSibling),
                children,
                childrenPage: compactChildrenPage(related.childrenPage, children.length),
            },
        },
        status: statusWithLookupCompaction(output.status),
    };
}
function compactRelatedChunk(chunk) {
    if (!chunk) {
        return chunk;
    }
    const { text: _text, ...rest } = chunk;
    return rest;
}
function minimalChunkLookupOutput(output) {
    if (!output.chunk) {
        return { status: statusWithLookupCompaction(output.status) };
    }
    return {
        status: statusWithLookupCompaction(output.status),
        chunk: {
            filePath: output.chunk.filePath,
            language: output.chunk.language,
            range: output.chunk.range,
            kind: output.chunk.kind,
            breadcrumbs: output.chunk.breadcrumbs,
            topology: output.chunk.topology,
            related: {
                parent: compactRelatedChunk(output.chunk.related.parent),
                previousSibling: compactRelatedChunk(output.chunk.related.previousSibling),
                nextSibling: compactRelatedChunk(output.chunk.related.nextSibling),
                children: output.chunk.related.children.map(compactRelatedChunk),
                childrenPage: output.chunk.related.childrenPage,
            },
        },
    };
}
function diagnosticsFocusedChunkLookupOutput(output) {
    return {
        status: output.status.status,
        found: Boolean(output.chunk),
        diagnostics: diagnosticsWithLookupCompaction(output.status.diagnostics),
    };
}
function compactChildrenPage(page, emittedChildren) {
    if (emittedChildren === page.limit) {
        return page;
    }
    return {
        ...page,
        limit: emittedChildren,
        hasMore: page.offset + emittedChildren < page.total,
    };
}
function statusWithSearchCompaction(status) {
    return { ...status, diagnostics: diagnosticsWithSearchCompaction(status.diagnostics) };
}
function statusWithLookupCompaction(status) {
    return { ...status, diagnostics: diagnosticsWithLookupCompaction(status.diagnostics) };
}
function diagnosticsWithSearchCompaction(diagnostics) {
    return diagnostics.includes(COMPACTION_DIAGNOSTIC) ? diagnostics : [...diagnostics, COMPACTION_DIAGNOSTIC];
}
function diagnosticsWithLookupCompaction(diagnostics) {
    return diagnostics.includes(LOOKUP_COMPACTION_DIAGNOSTIC)
        ? diagnostics
        : [...diagnostics, LOOKUP_COMPACTION_DIAGNOSTIC];
}
function trimText(text, maxLength) {
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}
function serializeSearchToolOutput(output, limits = {}) {
    return serializeToolOutput({
        output: searchOutputForTool(output),
        limits,
        compact: compactSearchOutput,
        minimal: minimalSearchOutput,
        diagnosticsFocused: diagnosticsFocusedSearchOutput,
    });
}
function serializeChunkLookupToolOutput(output, limits = {}) {
    return serializeToolOutput({
        output: chunkLookupOutputForTool(output),
        limits,
        compact: compactChunkLookupOutput,
        minimal: minimalChunkLookupOutput,
        diagnosticsFocused: diagnosticsFocusedChunkLookupOutput,
    });
}
export { serializeChunkLookupToolOutput, serializeSearchToolOutput, unavailableToolResult };
