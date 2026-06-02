import { type RankedResult, reciprocalRankFusion } from "./lexical.js"
import { matchesPaths } from "./path-filter.js"
import { chunkBreadcrumbs, chunkMatchesSource, expandWithParentContext, summarizeTopology } from "./topology.js"
import type {
  CastIndex,
  ChunkRecord,
  DiagnosticRecord,
  HybridRetrievalOptions,
  HydratedChunkSet,
  LexicalChunkCandidate,
  RankedChunkCandidate,
  RerankOptions,
  SearchInput,
  SearchOutput,
  SearchResultRetrievalDetails,
  VectorCandidateSearchResult,
} from "./types.js"

const CANDIDATE_MULTIPLIER = 3
const DEFAULT_MIN_FINAL_SCORE = 0.01
const DEFAULT_MAX_VECTOR_CANDIDATES = 512
const DEFAULT_MAX_RERANK_CANDIDATES = 64
const PATH_FILTER_CAP_DIAGNOSTIC = "path-filtered vector search hit the candidate cap; results may be incomplete"

export interface RetrievalIndexStore {
  readMetadata(): Promise<CastIndex["metadata"]>
  searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<VectorCandidateSearchResult>
  searchLexicalCandidates?(query: string, topK: number, paths?: string[]): Promise<LexicalChunkCandidate[]>
  hydrateChunks(chunkIds: string[]): Promise<HydratedChunkSet>
}

export interface RetrieveFromStoreInput {
  input: SearchInput
  options: {
    topK: number
    maxContextChars: number
    hyde: { enabled: boolean; threshold: number }
    hybrid?: HybridRetrievalOptions
    rerank?: RerankOptions
    maxVectorCandidates?: number
    maxRerankCandidates?: number
  }
  embed(text: string): Promise<number[]>
  generateHyde(query: string): Promise<string>
  rerank?(query: string, documents: string[]): Promise<Array<{ index: number; score: number }>>
  readSource(filePath: string): Promise<string>
  indexStore: RetrievalIndexStore
}

type RetrievalContext = RetrieveFromStoreInput & { index: CastIndex }

type RetrievalSettingsInput = Pick<RetrieveFromStoreInput, "input" | "options">

type ResultOutputContext = RetrievalContext & Pick<RetrieveFromStoreInput, "readSource">

type SourceReadResult = { text: string; ok: true } | { text: string; ok: false }

type SourceCache = Map<string, Promise<SourceReadResult>>

interface RankedSearch {
  results: RankedResult[]
  retrieval: Map<string, SearchResultRetrievalDetails>
}

interface StoreCandidateSearch {
  vectorCandidates: RankedChunkCandidate[]
  lexicalCandidates: LexicalChunkCandidate[]
  rankedVectorCandidates: RankedChunkCandidate[]
  diagnostics: string[]
  diagnosticDetails: DiagnosticRecord[]
  hydeUsed: boolean
}

export async function retrieveFromStore(input: RetrieveFromStoreInput): Promise<SearchOutput> {
  await input.indexStore.readMetadata()
  const settings = retrievalSettings(input)
  const maxVectorCandidates = input.options.maxVectorCandidates ?? DEFAULT_MAX_VECTOR_CANDIDATES
  const maxRerankCandidates = input.options.maxRerankCandidates ?? DEFAULT_MAX_RERANK_CANDIDATES
  const rankingTopK = rankingLimit(settings.topK, input.options.rerank, maxRerankCandidates)
  const candidateCount = storeVectorCandidateCount(rankingTopK, input.options.hybrid, maxVectorCandidates)
  const candidates = await collectStoreCandidates(input, rankingTopK, candidateCount)

  const ranked = storeBackedRanking({
    vectorCandidates: candidates.rankedVectorCandidates,
    lexicalCandidates: candidates.lexicalCandidates,
    hybrid: input.options.hybrid,
    topK: rankingTopK,
  })
  const candidateIds = ranked.results.map((result) => result.id)
  const hydrated = await input.indexStore.hydrateChunks(candidateIds)
  const hydratedStatusDiagnostics = uniqueDiagnostics([...hydrated.metadata.diagnostics, ...hydrated.diagnostics])
  const hydratedStatusDiagnosticDetails = uniqueDiagnosticDetails([
    ...(hydrated.metadata.diagnosticDetails ?? []),
    ...(hydrated.diagnosticDetails ?? []),
  ])
  const index = {
    metadata: {
      ...hydrated.metadata,
      diagnostics: hydratedStatusDiagnostics,
      diagnosticDetails: hydratedStatusDiagnosticDetails,
    },
    files: hydrated.files,
    chunks: hydrated.chunks,
    symbols: hydrated.symbols,
    lexical: hydrated.lexical,
  }
  const diagnostics = hydratedDiagnostics(input, hydrated, candidates.diagnostics)
  const diagnosticDetails = hydratedDiagnosticDetails(hydrated, candidates.diagnosticDetails)
  const reranked = await maybeRerank({
    input: { ...input, index },
    rerank: input.options.rerank,
    ranked,
    chunksById: hydrated.chunks,
    diagnostics,
  })
  const candidateResults = reranked.ranked.results.slice(0, settings.topK)
  const filteredRankedResults = candidateResults.filter((result) => result.score >= settings.minFinalScore)
  const filteredCount = candidateResults.length - filteredRankedResults.length
  const results = await outputResults({
    input: { ...input, index },
    results: filteredRankedResults,
    chunksById: hydrated.chunks,
    diagnostics,
    diagnosticDetails,
    initialScores: Object.fromEntries(candidates.vectorCandidates.map((result) => [result.id, result.score])),
    maxContextChars: settings.maxContextChars,
    retrieval: reranked.ranked.retrieval,
  })

  return {
    status: {
      ...hydrated.metadata,
      diagnostics: hydratedStatusDiagnostics,
      diagnosticDetails: hydratedStatusDiagnosticDetails,
      hydeUsed: candidates.hydeUsed,
      bestScore: candidates.vectorCandidates[0]?.score,
      rerankUsed: reranked.used,
      minFinalScore: settings.minFinalScore,
      filteredCount,
      candidateCount: candidateResults.length,
    },
    results,
    diagnostics,
    diagnosticDetails,
  }
}

async function collectStoreCandidates(
  input: RetrieveFromStoreInput,
  rankingTopK: number,
  candidateCount: number,
): Promise<StoreCandidateSearch> {
  const queryVector = await input.embed(input.input.query)
  const vectorSearch = await input.indexStore.searchVectorCandidates(queryVector, candidateCount, input.input.paths)
  const vectorCandidates = vectorSearch.slice(0, candidateCount)
  const lexicalCandidates = await storeLexicalCandidates(input, rankingTopK)
  const hyde = await storeHydeCandidates(input, vectorCandidates, candidateCount)
  const cappedDiagnostics = cappedPathFilterDiagnostics(input, vectorSearch.incomplete === true || hyde.incomplete)
  return {
    vectorCandidates,
    lexicalCandidates,
    rankedVectorCandidates: hyde.rankedVectorCandidates.slice(0, candidateCount),
    diagnostics: [...hyde.diagnostics, ...cappedDiagnostics.diagnostics],
    diagnosticDetails: [...hyde.diagnosticDetails, ...cappedDiagnostics.diagnosticDetails],
    hydeUsed: hyde.used,
  }
}

function cappedPathFilterDiagnostics(input: RetrieveFromStoreInput, incomplete: boolean) {
  if (!input.input.paths || input.input.paths.length === 0 || !incomplete) {
    return { diagnostics: [], diagnosticDetails: [] }
  }
  return {
    diagnostics: [PATH_FILTER_CAP_DIAGNOSTIC],
    diagnosticDetails: [{ code: "retrieval.knn_capped" as const, message: PATH_FILTER_CAP_DIAGNOSTIC }],
  }
}

function storeLexicalCandidates(input: RetrieveFromStoreInput, rankingTopK: number) {
  const hybrid = input.options.hybrid
  const searchLexicalCandidates = input.indexStore.searchLexicalCandidates
  if (!hybrid?.enabled) {
    return []
  }
  if (!searchLexicalCandidates) {
    return []
  }
  return searchLexicalCandidates(input.input.query, rankingTopK * hybrid.bm25CandidateMultiplier, input.input.paths)
}

async function storeHydeCandidates(
  input: RetrieveFromStoreInput,
  vectorCandidates: RankedChunkCandidate[],
  candidateCount: number,
): Promise<
  Pick<StoreCandidateSearch, "rankedVectorCandidates" | "diagnostics" | "diagnosticDetails"> & {
    used: boolean
    incomplete: boolean
  }
> {
  if (!shouldUseHyde(input, vectorCandidates)) {
    return {
      rankedVectorCandidates: vectorCandidates,
      diagnostics: [],
      diagnosticDetails: [],
      used: false,
      incomplete: false,
    }
  }
  try {
    const hydeText = await input.generateHyde(input.input.query)
    const hydeVector = await input.embed(hydeText)
    const hydeCandidates = await input.indexStore.searchVectorCandidates(hydeVector, candidateCount, input.input.paths)
    return {
      rankedVectorCandidates: mergeRankedCandidates(vectorCandidates, hydeCandidates),
      diagnostics: [],
      diagnosticDetails: [],
      used: true,
      incomplete: hydeCandidates.incomplete === true,
    }
  } catch (error) {
    if (isIndexUnavailableError(error)) {
      throw error
    }
    const message = `HyDE failed: ${error instanceof Error ? error.message : String(error)}`
    return {
      rankedVectorCandidates: vectorCandidates,
      diagnostics: [message],
      diagnosticDetails: [{ code: "hyde.failed", message }],
      used: false,
      incomplete: false,
    }
  }
}

function shouldUseHyde(input: RetrieveFromStoreInput, vectorCandidates: RankedChunkCandidate[]) {
  return input.options.hyde.enabled && (vectorCandidates[0]?.score ?? -1) < input.options.hyde.threshold
}

function hydratedDiagnostics(
  input: RetrieveFromStoreInput,
  hydrated: HydratedChunkSet,
  candidateDiagnostics: string[],
) {
  return uniqueDiagnostics([
    ...hydrated.metadata.diagnostics,
    ...candidateDiagnostics,
    ...Object.values(hydrated.files)
      .filter((file) => file.diagnostics.length > 0 && matchesPaths(file.path, input.input.paths))
      .flatMap((file) => file.diagnostics.map((diagnostic) => `${file.path}: ${diagnostic}`)),
    ...hydrated.diagnostics,
  ])
}

function hydratedDiagnosticDetails(hydrated: HydratedChunkSet, candidateDiagnostics: DiagnosticRecord[]) {
  return uniqueDiagnosticDetails([
    ...(hydrated.metadata.diagnosticDetails ?? []),
    ...candidateDiagnostics,
    ...(hydrated.diagnosticDetails ?? []),
  ])
}

function uniqueDiagnosticDetails(details: DiagnosticRecord[]) {
  const seen = new Set<string>()
  return details.filter((detail) => {
    const key = `${detail.code}\0${detail.message}\0${detail.filePath ?? ""}\0${detail.chunkId ?? ""}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function uniqueDiagnostics(diagnostics: string[]) {
  return [...new Set(diagnostics)]
}

function storeVectorCandidateCount(
  rankingTopK: number,
  hybrid: HybridRetrievalOptions | undefined,
  maxVectorCandidates: number,
) {
  const multiplier = hybrid?.enabled ? hybrid.vectorCandidateMultiplier : CANDIDATE_MULTIPLIER
  return Math.max(rankingTopK, Math.min(rankingTopK * multiplier, maxVectorCandidates))
}

function retrievalSettings(input: RetrievalSettingsInput) {
  return {
    topK: input.input.topK ?? input.options.topK,
    maxContextChars: input.input.maxContextChars ?? input.options.maxContextChars,
    minFinalScore: Math.max(0, input.input.minFinalScore ?? DEFAULT_MIN_FINAL_SCORE),
  }
}

function rankingLimit(topK: number, rerank: RerankOptions | undefined, maxRerankCandidates: number) {
  if (!rerank) {
    return topK
  }
  return Math.max(topK, Math.min(topK * rerank.candidateMultiplier, maxRerankCandidates))
}

function vectorRanking(vectorCandidates: RankedResult[], rankingTopK: number): RankedSearch {
  return {
    results: vectorCandidates.slice(0, rankingTopK),
    retrieval: new Map(
      vectorCandidates.map((result, index) => [result.id, { mode: "vector" as const, vectorRank: index + 1 }]),
    ),
  }
}

function storeBackedRanking(input: {
  vectorCandidates: RankedChunkCandidate[]
  lexicalCandidates: LexicalChunkCandidate[]
  hybrid: HybridRetrievalOptions | undefined
  topK: number
}): RankedSearch {
  if (!input.hybrid?.enabled || input.lexicalCandidates.length === 0) {
    return vectorRanking(input.vectorCandidates, input.topK)
  }
  const results = reciprocalRankFusion({
    lists: [
      { weight: input.hybrid.vectorWeight, results: input.vectorCandidates },
      { weight: input.hybrid.bm25Weight, results: input.lexicalCandidates },
    ],
    rrfK: input.hybrid.rrfK,
    topK: input.topK,
  })
  const vectorRanks = rankMap(input.vectorCandidates)
  const bm25Ranks = rankMap(input.lexicalCandidates)
  const bm25Scores = new Map(input.lexicalCandidates.map((result) => [result.id, result.bm25Score ?? result.score]))
  return {
    results,
    retrieval: new Map(
      results.map((result) => [
        result.id,
        {
          mode: "hybrid" as const,
          vectorRank: vectorRanks.get(result.id),
          bm25Rank: bm25Ranks.get(result.id),
          bm25Score: bm25Scores.get(result.id),
        },
      ]),
    ),
  }
}

function mergeRankedCandidates(...candidateGroups: RankedChunkCandidate[][]) {
  const candidatesById = new Map<string, RankedChunkCandidate>()
  for (const candidate of candidateGroups.flat()) {
    const existing = candidatesById.get(candidate.id)
    if (!existing || candidate.score > existing.score) {
      candidatesById.set(candidate.id, candidate)
    }
  }
  return [...candidatesById.values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
}

async function maybeRerank(input: {
  input: RetrievalContext
  rerank: RerankOptions | undefined
  ranked: RankedSearch
  chunksById: Record<string, ChunkRecord>
  diagnostics: string[]
}) {
  if (!input.rerank || input.ranked.results.length === 0) {
    return { ranked: input.ranked, used: false }
  }
  try {
    return { ranked: await rerankedSearch(input), used: true }
  } catch (error) {
    input.diagnostics.push(`Rerank failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ranked: input.ranked, used: false }
  }
}

async function rerankedSearch(input: {
  input: RetrievalContext
  ranked: RankedSearch
  chunksById: Record<string, ChunkRecord>
}) {
  if (!input.input.rerank) {
    throw new Error("rerank dependency unavailable")
  }
  return {
    ...input.ranked,
    results: await rerankResults({
      query: input.input.input.query,
      results: input.ranked.results,
      chunksById: input.chunksById,
      retrieval: input.ranked.retrieval,
      rerank: input.input.rerank,
    }),
  }
}

async function outputResults(input: {
  input: ResultOutputContext
  results: RankedResult[]
  chunksById: Record<string, ChunkRecord>
  diagnostics: string[]
  diagnosticDetails: DiagnosticRecord[]
  initialScores: Record<string, number>
  maxContextChars: number
  retrieval: Map<string, SearchResultRetrievalDetails>
}) {
  const sourceCache: SourceCache = new Map()
  const sourceReadFailures = new Set<string>()
  const results = await Promise.all(
    input.results.flatMap((result) => outputResult(input, result, sourceCache, sourceReadFailures)),
  )
  return omitDuplicateParentRanges(results.flat())
}

async function outputResult(
  input: Parameters<typeof outputResults>[0],
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

function baseOutputResult(input: Parameters<typeof outputResults>[0], result: RankedResult, chunk: ChunkRecord) {
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
  input: Parameters<typeof outputResults>[0]
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
  input: ResultOutputContext
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

function isIndexUnavailableError(error: unknown) {
  return error instanceof Error && error.name === "IndexUnavailableError"
}

function rankMap(results: RankedResult[]) {
  return new Map(results.map((result, index) => [result.id, index + 1]))
}

async function rerankResults(input: {
  query: string
  results: RankedResult[]
  chunksById: Record<string, ChunkRecord>
  retrieval: Map<string, SearchResultRetrievalDetails>
  rerank(query: string, documents: string[]): Promise<Array<{ index: number; score: number }>>
}) {
  const candidates = input.results.flatMap((result) => {
    const chunk = input.chunksById[result.id]
    return chunk ? [{ result, chunk }] : []
  })
  const reranked = await input.rerank(
    input.query,
    candidates.map(({ chunk }) => rerankDocument(chunk)),
  )

  const seenCandidateIndexes = new Set<number>()
  const rerankedResults = reranked.flatMap((rerankedResult, index) => {
    if (seenCandidateIndexes.has(rerankedResult.index)) {
      return []
    }
    const candidate = candidates[rerankedResult.index]
    if (!candidate) {
      return []
    }
    seenCandidateIndexes.add(rerankedResult.index)
    const existing = input.retrieval.get(candidate.result.id)
    input.retrieval.set(candidate.result.id, {
      ...(existing ?? { mode: "vector" }),
      rerankRank: index + 1,
      rerankScore: rerankedResult.score,
    })
    return [{ id: candidate.result.id, score: rerankedResult.score }]
  })
  const missingResults = candidates.flatMap(({ result }, index) => (seenCandidateIndexes.has(index) ? [] : [result]))
  return [...rerankedResults, ...missingResults]
}

function rerankDocument(chunk: ChunkRecord) {
  return `${chunk.filePath}:${formatLineRange(chunk.range.lineStart, chunk.range.lineEnd)}\nkind: ${chunk.kind}\n${chunk.text}`
}

function formatLineRange(lineStart: number, lineEnd: number) {
  return lineStart === lineEnd ? String(lineStart) : `${lineStart}-${lineEnd}`
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
