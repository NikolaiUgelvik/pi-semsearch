import type { RankedResult } from "../search/lexical.js"
import type {
  CastIndex,
  ChunkRecord,
  DiagnosticRecord,
  SearchInput,
  SearchOutput,
  SearchResultRetrievalDetails,
} from "../shared/types.js"
import { chunkBreadcrumbs, chunkMatchesSource, expandWithParentContext, summarizeTopology } from "../topology/index.js"

interface RetrieveOutputResultsInput {
  input: {
    input: SearchInput
    index: Pick<CastIndex, "symbols">
    readSource(filePath: string): Promise<string>
  }
  results: RankedResult[]
  chunksById: Record<string, ChunkRecord>
  diagnostics: string[]
  diagnosticDetails: DiagnosticRecord[]
  initialScores: Record<string, number>
  maxContextChars: number
  retrieval: Map<string, SearchResultRetrievalDetails>
}

type SourceReadResult = { text: string; ok: true } | { text: string; ok: false }
type SourceCache = Map<string, Promise<SourceReadResult>>

async function outputResults(input: RetrieveOutputResultsInput): Promise<SearchOutput["results"]> {
  const sourceCache: SourceCache = new Map()
  const sourceReadFailures = new Set<string>()
  const results = await Promise.all(
    input.results.flatMap((result) => outputResult(input, result, sourceCache, sourceReadFailures)),
  )
  return omitDuplicateParentRanges(results.flat())
}

async function outputResult(
  input: RetrieveOutputResultsInput,
  result: RankedResult,
  sourceCache: SourceCache,
  sourceReadFailures: Set<string>,
) {
  const chunk = input.chunksById[result.id]
  if (!chunk) {
    return []
  }
  if (input.input.input.includeParents !== true) {
    return [baseOutputResult(input, result, chunk)]
  }
  const source = await sourceForChunk({
    input: input.input,
    chunk,
    diagnostics: input.diagnostics,
    diagnosticDetails: input.diagnosticDetails,
    sourceCache,
    sourceReadFailures,
  })
  const sourceMatches = source.ok && chunkMatchesSource(source.text, chunk)
  if (source.ok && !sourceMatches) {
    addSourceDiagnostic(input.diagnostics, input.diagnosticDetails, {
      chunk,
      code: "source.mismatch",
      message: `source mismatch for ${chunk.filePath}:${chunk.id}; parent context omitted`,
    })
  }
  const context = parentContext({
    chunk,
    includeParents: true,
    maxContextChars: input.maxContextChars,
    source,
    symbols: input.input.index.symbols,
  })
  return [parentOutputResult({ input, result, chunk, context, sourceMatches })]
}

function baseOutputResult(input: RetrieveOutputResultsInput, result: RankedResult, chunk: ChunkRecord) {
  return {
    filePath: chunk.filePath,
    language: chunk.language,
    range: chunk.range,
    score: input.initialScores[result.id] ?? result.score,
    finalScore: result.score,
    kind: chunk.kind,
    breadcrumbs: chunkBreadcrumbs(chunk, input.input.index.symbols),
    text: chunk.text,
    topology: summarizeTopology(chunk, input.chunksById, input.input.index.symbols),
    retrieval: input.retrieval.get(result.id),
  }
}

function parentOutputResult(input: {
  input: RetrieveOutputResultsInput
  result: RankedResult
  chunk: ChunkRecord
  context: ReturnType<typeof parentContext>
  sourceMatches: boolean
}) {
  return {
    ...baseOutputResult(input.input, input.result, input.chunk),
    breadcrumbs: input.context.breadcrumbs,
    text: input.sourceMatches ? input.chunk.text : "",
    parentText: input.context.parentText,
    parentRange: input.context.parentRange,
  }
}

function sourceForChunk(input: {
  input: RetrieveOutputResultsInput["input"]
  chunk: ChunkRecord
  diagnostics: string[]
  diagnosticDetails: DiagnosticRecord[]
  sourceCache: SourceCache
  sourceReadFailures: Set<string>
}) {
  const filePath = input.chunk.filePath
  let source = input.sourceCache.get(filePath)
  if (!source) {
    source = input.input
      .readSource(filePath)
      .then((text): SourceReadResult => ({ text, ok: true }))
      .catch((): SourceReadResult => ({ text: "", ok: false }))
    input.sourceCache.set(filePath, source)
  }
  return source.then((result) => {
    if (result.ok) {
      return result
    }
    if (input.sourceReadFailures.has(filePath)) {
      return result
    }
    input.sourceReadFailures.add(filePath)
    addSourceDiagnostic(input.diagnostics, input.diagnosticDetails, {
      chunk: input.chunk,
      code: "source.read_failed",
      message: `source read failed for ${input.chunk.filePath}; parent context omitted`,
    })
    return result
  })
}

function addSourceDiagnostic(
  diagnostics: string[],
  diagnosticDetails: DiagnosticRecord[],
  detail: { chunk: ChunkRecord; code: "source.read_failed" | "source.mismatch"; message: string },
) {
  diagnostics.push(detail.message)
  diagnosticDetails.push({
    code: detail.code,
    message: detail.message,
    filePath: detail.chunk.filePath,
    chunkId: detail.chunk.id,
  })
}

function omitDuplicateParentRanges<
  T extends { filePath: string; parentRange?: { byteStart: number; byteEnd: number }; parentText?: string },
>(results: T[]) {
  const seenParentRanges = new Set<string>()
  return results.map((result) => omitDuplicateParentRange(result, seenParentRanges))
}

function omitDuplicateParentRange<
  T extends { filePath: string; parentRange?: { byteStart: number; byteEnd: number }; parentText?: string },
>(result: T, seenParentRanges: Set<string>) {
  if (!result.parentRange) {
    return result
  }
  const parentRangeKey = `${result.filePath}\0${result.parentRange.byteStart}\0${result.parentRange.byteEnd}`
  if (seenParentRanges.has(parentRangeKey)) {
    return { ...result, parentText: undefined, parentRange: undefined }
  }
  seenParentRanges.add(parentRangeKey)
  return result
}

function parentContext(input: {
  chunk: ChunkRecord
  includeParents: boolean | undefined
  maxContextChars: number
  source: { text: string; ok: boolean }
  symbols: CastIndex["symbols"]
}) {
  if (input.includeParents === false) {
    return { breadcrumbs: chunkBreadcrumbs(input.chunk, input.symbols), parentText: undefined, parentRange: undefined }
  }
  if (input.source.ok && chunkMatchesSource(input.source.text, input.chunk)) {
    return expandWithParentContext({
      chunk: input.chunk,
      symbols: input.symbols,
      source: input.source.text,
      maxContextChars: input.maxContextChars,
    })
  }
  return { breadcrumbs: chunkBreadcrumbs(input.chunk, input.symbols) }
}

export type { RetrieveOutputResultsInput }
export { outputResults }
