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
} from "./types.js"

const CANDIDATE_MULTIPLIER = 3
const DEFAULT_MIN_FINAL_SCORE = 0.01

export interface RetrievalIndexStore {
  readMetadata(): Promise<CastIndex["metadata"]>
  searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<RankedChunkCandidate[]>
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
  const rankingTopK = rankingLimit(settings.topK, input.options.rerank)
  const candidateCount = storeVectorCandidateCount(rankingTopK, input.options.hybrid)
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
  const vectorCandidates = await input.indexStore.searchVectorCandidates(queryVector, candidateCount, input.input.paths)
  const lexicalCandidates = await storeLexicalCandidates(input, rankingTopK)
  const hyde = await storeHydeCandidates(input, vectorCandidates, candidateCount)
  return {
    vectorCandidates,
    lexicalCandidates,
    rankedVectorCandidates: hyde.rankedVectorCandidates,
    diagnostics: hyde.diagnostics,
    diagnosticDetails: hyde.diagnosticDetails,
    hydeUsed: hyde.used,
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
  Pick<StoreCandidateSearch, "rankedVectorCandidates" | "diagnostics" | "diagnosticDetails"> & { used: boolean }
> {
  if (!shouldUseHyde(input, vectorCandidates)) {
    return { rankedVectorCandidates: vectorCandidates, diagnostics: [], diagnosticDetails: [], used: false }
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

function storeVectorCandidateCount(rankingTopK: number, hybrid: HybridRetrievalOptions | undefined) {
  const multiplier = hybrid?.enabled ? hybrid.vectorCandidateMultiplier : CANDIDATE_MULTIPLIER
  return Math.max(rankingTopK * multiplier, rankingTopK)
}

function retrievalSettings(input: RetrievalSettingsInput) {
  return {
    topK: input.input.topK ?? input.options.topK,
    maxContextChars: input.input.maxContextChars ?? input.options.maxContextChars,
    minFinalScore: Math.max(0, input.input.minFinalScore ?? DEFAULT_MIN_FINAL_SCORE),
  }
}

function rankingLimit(topK: number, rerank: RerankOptions | undefined) {
  return rerank ? Math.max(topK * rerank.candidateMultiplier, topK) : topK
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
  const results = await Promise.all(input.results.flatMap((result) => outputResult(input, result)))
  return omitDuplicateParentRanges(results.flat())
}

async function outputResult(input: Parameters<typeof outputResults>[0], result: RankedResult) {
  const chunk = input.chunksById[result.id]
  if (!chunk) {
    return []
  }
  const source = await sourceForChunk(input.input, chunk, input.diagnostics, input.diagnosticDetails)
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
    includeParents: input.input.input.includeParents === true,
    maxContextChars: input.maxContextChars,
    source,
    symbols: input.input.index.symbols,
  })
  return [
    {
      filePath: chunk.filePath,
      language: chunk.language,
      range: chunk.range,
      score: input.initialScores[result.id] ?? result.score,
      finalScore: result.score,
      kind: chunk.kind,
      breadcrumbs: context.breadcrumbs,
      text: sourceMatches ? chunk.text : "",
      parentText: context.parentText,
      parentRange: context.parentRange,
      topology: summarizeTopology(chunk, input.chunksById, input.input.index.symbols),
      retrieval: input.retrieval.get(result.id),
    },
  ]
}

function sourceForChunk(
  input: ResultOutputContext,
  chunk: ChunkRecord,
  diagnostics: string[],
  diagnosticDetails: DiagnosticRecord[],
) {
  return input
    .readSource(chunk.filePath)
    .then((text) => ({ text, ok: true }))
    .catch(() => {
      addSourceDiagnostic(diagnostics, diagnosticDetails, {
        chunk,
        code: "source.read_failed",
        message: `source read failed for ${chunk.filePath}; parent context omitted`,
      })
      return { text: "", ok: false }
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
  const parentRangeKey = `${result.filePath}:${result.parentRange.byteStart}:${result.parentRange.byteEnd}:${result.parentText}`
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
