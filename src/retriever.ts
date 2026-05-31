import { bm25Search, type RankedResult, reciprocalRankFusion } from "./lexical.js"
import { matchesPaths } from "./path-filter.js"
import { searchVectors } from "./store.js"
import { chunkBreadcrumbs, chunkMatchesSource, expandWithParentContext, summarizeTopology } from "./topology.js"
import type {
  CastIndex,
  ChunkRecord,
  HybridRetrievalMode,
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
const STORE_BACKED_VECTOR_PREFILTER_CANDIDATE_COUNT = 10_000

export interface VectorCandidateSource {
  searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<RankedResult[]>
}

export interface RetrievalIndexStore {
  readMetadata(): Promise<CastIndex["metadata"]>
  searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<RankedChunkCandidate[]>
  searchLexicalCandidates?(query: string, topK: number, paths?: string[]): Promise<LexicalChunkCandidate[]>
  hydrateChunks(chunkIds: string[]): Promise<HydratedChunkSet>
}

export interface RetrieveInput {
  index: CastIndex
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
  indexStore?: VectorCandidateSource
}

export interface RetrieveFromStoreInput extends Omit<RetrieveInput, "index" | "indexStore"> {
  indexStore: RetrievalIndexStore
}

export async function retrieveFromStore(input: RetrieveFromStoreInput): Promise<SearchOutput> {
  const settings = retrievalSettings({ ...input, index: emptyRetrievalIndex(await input.indexStore.readMetadata()) })
  const rankingTopK = rankingLimit(settings.topK, input.options.rerank)
  const candidateCount = storeVectorCandidateCount(rankingTopK, input.options.hybrid)
  const queryVector = await input.embed(input.input.query)
  const vectorCandidates = await input.indexStore.searchVectorCandidates(queryVector, candidateCount, input.input.paths)
  const lexicalCandidates =
    input.options.hybrid?.enabled && input.indexStore.searchLexicalCandidates
      ? await input.indexStore.searchLexicalCandidates(
          input.input.query,
          rankingTopK * input.options.hybrid.bm25CandidateMultiplier,
          input.input.paths,
        )
      : []
  const candidateBatches = [{ vector: queryVector, candidates: vectorCandidates, requestedTopK: candidateCount }]
  let generateHyde = input.generateHyde
  let embed = input.embed

  if (input.options.hyde.enabled && (vectorCandidates[0]?.score ?? -1) < input.options.hyde.threshold) {
    try {
      const hydeText = await input.generateHyde(input.input.query)
      const hydeVector = await input.embed(hydeText)
      candidateBatches.push({
        vector: hydeVector,
        candidates: await input.indexStore.searchVectorCandidates(hydeVector, candidateCount, input.input.paths),
        requestedTopK: candidateCount,
      })
      generateHyde = () => Promise.resolve(hydeText)
      embed = (text) => (text === hydeText ? Promise.resolve(hydeVector) : input.embed(text))
    } catch {
      // Let retrieve perform HyDE and preserve its fallback diagnostics/status behavior.
    }
  }

  const candidateIds = mergeCandidateIds(...candidateBatches.map((batch) => batch.candidates), lexicalCandidates)
  const hydrated = await input.indexStore.hydrateChunks(candidateIds)
  return retrieve({
    ...input,
    generateHyde,
    embed,
    index: {
      metadata: { ...hydrated.metadata, diagnostics: [...hydrated.metadata.diagnostics, ...hydrated.diagnostics] },
      files: hydrated.files,
      chunks: hydrated.chunks,
      symbols: hydrated.symbols,
      lexical: hydrated.lexical,
    },
    indexStore: {
      searchVectorCandidates: (vector, topK, paths) => {
        const cached = candidateBatches.find((batch) => vectorsEqual(batch.vector, vector))
        return cached && cached.requestedTopK >= topK
          ? Promise.resolve(cached.candidates)
          : input.indexStore.searchVectorCandidates(vector, topK, paths)
      },
    },
  })
}

function mergeCandidateIds(...candidateGroups: Array<Array<{ id: string }>>) {
  return [...new Set(candidateGroups.flatMap((group) => group.map((candidate) => candidate.id)))]
}

function storeVectorCandidateCount(rankingTopK: number, hybrid: HybridRetrievalOptions | undefined) {
  if (hybrid?.enabled && hybrid.mode === "vector-prefilter") {
    return Math.max(
      rankingTopK * hybrid.vectorCandidateMultiplier,
      rankingTopK,
      STORE_BACKED_VECTOR_PREFILTER_CANDIDATE_COUNT,
    )
  }
  const multiplier = hybrid?.enabled ? hybrid.vectorCandidateMultiplier : CANDIDATE_MULTIPLIER
  return Math.max(rankingTopK * multiplier, rankingTopK)
}

function vectorsEqual(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function emptyRetrievalIndex(metadata: CastIndex["metadata"]): CastIndex {
  return { metadata, files: {}, chunks: {}, symbols: {} }
}

interface RankedSearch {
  results: RankedResult[]
  retrieval: Map<string, SearchResultRetrievalDetails>
}

export async function retrieve(input: RetrieveInput): Promise<SearchOutput> {
  const settings = retrievalSettings(input)
  const rerank = input.options.rerank
  const rankingTopK = rankingLimit(settings.topK, rerank)
  const diagnostics = diagnosticsForSearch(input)
  const chunks = matchedChunks(input, diagnostics)
  const chunksById = Object.fromEntries(chunks.map((chunk) => [chunk.id, chunk]))
  const queryVector = await input.embed(input.input.query)
  const hybrid = input.options.hybrid
  const canUseHybrid = Boolean(hybrid?.enabled && input.index.lexical && chunks.some((chunk) => chunk.lexical))
  addHybridDiagnostic(hybrid, canUseHybrid, diagnostics)
  const vectors = searchableVectors(chunks)
  const searchVectorCandidates = vectorCandidateSearch({
    input,
    chunks,
    chunksById,
    vectors,
    rankingTopK,
    canUseHybrid,
  })
  const initial = await searchVectorCandidates(queryVector)
  const bestScore = initial[0]?.score
  const initialScores = Object.fromEntries(initial.map((result) => [result.id, result.score]))
  const hyde = await hydeResults(input, initial, bestScore, searchVectorCandidates)
  let ranked = initialRanking({ input, chunks, vectorCandidates: hyde.scored, rankingTopK, canUseHybrid })
  const reranked = await maybeRerank({ input, rerank, ranked, chunksById, diagnostics })
  ranked = reranked.ranked
  const candidateResults = ranked.results.slice(0, settings.topK)
  const filteredRankedResults = candidateResults.filter((result) => result.score >= settings.minFinalScore)
  const filteredCount = candidateResults.length - filteredRankedResults.length
  const results = await outputResults({
    input,
    results: filteredRankedResults,
    chunksById,
    diagnostics,
    initialScores,
    maxContextChars: settings.maxContextChars,
    retrieval: ranked.retrieval,
  })

  return {
    status: {
      ...input.index.metadata,
      hydeUsed: hyde.hydeUsed,
      bestScore,
      rerankUsed: reranked.used,
      minFinalScore: settings.minFinalScore,
      filteredCount,
      candidateCount: candidateResults.length,
    },
    results,
    diagnostics: [...diagnostics, ...hyde.diagnostics],
  }
}

function retrievalSettings(input: RetrieveInput) {
  return {
    topK: input.input.topK ?? input.options.topK,
    maxContextChars: input.input.maxContextChars ?? input.options.maxContextChars,
    minFinalScore: Math.max(0, input.input.minFinalScore ?? DEFAULT_MIN_FINAL_SCORE),
  }
}

function rankingLimit(topK: number, rerank: RerankOptions | undefined) {
  return rerank ? Math.max(topK * rerank.candidateMultiplier, topK) : topK
}

function addHybridDiagnostic(hybrid: HybridRetrievalOptions | undefined, canUseHybrid: boolean, diagnostics: string[]) {
  if (hybrid?.enabled && !canUseHybrid) {
    diagnostics.push("hybrid retrieval requested but lexical data is unavailable; using vector-only retrieval")
  }
}

function initialRanking(input: {
  input: RetrieveInput
  chunks: ChunkRecord[]
  vectorCandidates: RankedResult[]
  rankingTopK: number
  canUseHybrid: boolean
}): RankedSearch {
  return input.canUseHybrid
    ? hybridRanking(input.input, input.chunks, input.vectorCandidates, input.rankingTopK)
    : vectorRanking(input.vectorCandidates, input.rankingTopK)
}

function hybridRanking(
  input: RetrieveInput,
  chunks: ChunkRecord[],
  vectorCandidates: RankedResult[],
  rankingTopK: number,
) {
  return hybridResults({
    query: input.input.query,
    chunks,
    lexical: input.index.lexical,
    topK: rankingTopK,
    vectorCandidates,
    hybrid: input.options.hybrid as HybridRetrievalOptions,
  })
}

function vectorRanking(vectorCandidates: RankedResult[], rankingTopK: number): RankedSearch {
  return {
    results: vectorCandidates.slice(0, rankingTopK),
    retrieval: new Map(
      vectorCandidates.map((result, index) => [result.id, { mode: "vector" as const, vectorRank: index + 1 }]),
    ),
  }
}

async function maybeRerank(input: {
  input: RetrieveInput
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
  input: RetrieveInput
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

function diagnosticsForSearch(input: RetrieveInput) {
  return [
    ...input.index.metadata.diagnostics,
    ...Object.values(input.index.files)
      .filter((file) => file.diagnostics.length > 0 && matchesPaths(file.path, input.input.paths))
      .flatMap((file) => file.diagnostics.map((diagnostic) => `${file.path}: ${diagnostic}`)),
  ]
}

function matchedChunks(input: RetrieveInput, diagnostics: string[]) {
  return Object.entries(input.index.chunks)
    .flatMap(([key, chunk]) => validChunkEntry(key, chunk, diagnostics))
    .filter((chunk) => matchesPaths(chunk.filePath, input.input.paths))
}

function validChunkEntry(key: string, chunk: ChunkRecord, diagnostics: string[]) {
  if (key === chunk.id) {
    return [chunk]
  }
  diagnostics.push(`chunk key mismatch: ${key} contains ${chunk.id}; chunk skipped`)
  return []
}

function searchableVectors(chunks: ChunkRecord[]) {
  return chunks
    .filter((chunk): chunk is ChunkRecord & { embedding: number[] } => Boolean(chunk.embedding))
    .map((chunk) => ({ id: chunk.id, vector: chunk.embedding }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function vectorCandidateSearch(input: {
  input: RetrieveInput
  chunks: ChunkRecord[]
  chunksById: Record<string, ChunkRecord>
  vectors: Array<{ id: string; vector: number[] }>
  rankingTopK: number
  canUseHybrid: boolean
}) {
  const searchCandidateCount = candidateSearchCount(input)
  return async (vector: number[]) => {
    if (input.input.indexStore?.searchVectorCandidates) {
      const candidates = await input.input.indexStore.searchVectorCandidates(
        vector,
        searchCandidateCount,
        input.input.input.paths,
      )
      return candidates.filter((candidate) => input.chunksById[candidate.id])
    }
    return searchVectors(vector, input.vectors, searchCandidateCount)
  }
}

function candidateSearchCount(input: {
  input: RetrieveInput
  chunks: ChunkRecord[]
  vectors: Array<{ id: string; vector: number[] }>
  rankingTopK: number
  canUseHybrid: boolean
}) {
  const hybrid = input.input.options.hybrid
  const multiplier = input.canUseHybrid ? (hybrid?.vectorCandidateMultiplier ?? 1) : CANDIDATE_MULTIPLIER
  const count =
    input.canUseHybrid && hybrid?.mode === "vector-prefilter"
      ? Math.max(input.vectors.length, input.chunks.length)
      : input.rankingTopK * multiplier
  return Math.max(count, input.rankingTopK)
}

function hydeResults(
  input: RetrieveInput,
  initial: RankedResult[],
  bestScore: number | undefined,
  searchVectorCandidates: (vector: number[]) => Promise<RankedResult[]>,
) {
  if (!shouldUseHyde(input, bestScore)) {
    return { scored: initial, hydeUsed: false, diagnostics: [] }
  }
  return input
    .generateHyde(input.input.query)
    .then((text) => input.embed(text))
    .then(async (vector) => ({
      scored: await searchVectorCandidates(vector),
      hydeUsed: true,
      diagnostics: [] as string[],
    }))
    .catch((error) => failedHydeResult(error, initial))
}

function shouldUseHyde(input: RetrieveInput, bestScore: number | undefined) {
  return input.options.hyde.enabled && (bestScore ?? -1) < input.options.hyde.threshold
}

function failedHydeResult(error: unknown, initial: RankedResult[]) {
  if (isIndexUnavailableError(error)) {
    throw error
  }
  return {
    scored: initial,
    hydeUsed: false,
    diagnostics: [`HyDE failed: ${error instanceof Error ? error.message : String(error)}`],
  }
}

async function outputResults(input: {
  input: RetrieveInput
  results: RankedResult[]
  chunksById: Record<string, ChunkRecord>
  diagnostics: string[]
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
  const source = await sourceForChunk(input.input, chunk, input.diagnostics)
  const sourceMatches = source.ok && chunkMatchesSource(source.text, chunk)
  if (source.ok && !sourceMatches) {
    input.diagnostics.push(`source mismatch for ${chunk.filePath}:${chunk.id}; parent context omitted`)
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

function sourceForChunk(input: RetrieveInput, chunk: ChunkRecord, diagnostics: string[]) {
  return input
    .readSource(chunk.filePath)
    .then((text) => ({ text, ok: true }))
    .catch(() => {
      diagnostics.push(`source read failed for ${chunk.filePath}; parent context omitted`)
      return { text: "", ok: false }
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

function hybridResults(input: {
  query: string
  chunks: ChunkRecord[]
  lexical: CastIndex["lexical"]
  topK: number
  vectorCandidates: RankedResult[]
  hybrid: HybridRetrievalOptions
}) {
  const bm25CandidateCount = Math.max(input.topK * input.hybrid.bm25CandidateMultiplier, input.topK)
  const vectorCandidateCount = Math.max(input.topK * input.hybrid.vectorCandidateMultiplier, input.topK)
  const allBm25 = bm25Search(input.query, input.chunks, input.lexical, bm25CandidateCount)
  const vectorCandidates =
    input.hybrid.mode === "vector-prefilter"
      ? includeScoreTies(input.vectorCandidates, vectorCandidateCount)
      : input.vectorCandidates.slice(0, vectorCandidateCount)
  const bm25Candidates = candidatesForMode(input.hybrid.mode, {
    query: input.query,
    chunks: input.chunks,
    lexical: input.lexical,
    allBm25,
    vectorCandidates,
  })
  const filteredVectorCandidates = vectorCandidatesForMode(input.hybrid.mode, {
    vectorCandidates,
    bm25Candidates,
  })
  const results = reciprocalRankFusion({
    lists: [
      { weight: input.hybrid.vectorWeight, results: filteredVectorCandidates },
      { weight: input.hybrid.bm25Weight, results: bm25Candidates },
    ],
    rrfK: input.hybrid.rrfK,
    topK: input.topK,
  })
  const vectorRanks = rankMap(filteredVectorCandidates)
  const bm25Ranks = rankMap(bm25Candidates)
  const bm25Scores = new Map(bm25Candidates.map((result) => [result.id, result.score]))
  const retrieval = new Map(
    results.map((result) => [
      result.id,
      {
        mode: "hybrid" as const,
        hybridMode: input.hybrid.mode,
        vectorRank: vectorRanks.get(result.id),
        bm25Rank: bm25Ranks.get(result.id),
        bm25Score: bm25Scores.get(result.id),
      },
    ]),
  )

  return { results, retrieval }
}

function candidatesForMode(
  mode: HybridRetrievalMode,
  input: {
    query: string
    chunks: ChunkRecord[]
    lexical: CastIndex["lexical"]
    allBm25: RankedResult[]
    vectorCandidates: RankedResult[]
  },
) {
  if (mode !== "vector-prefilter") {
    return input.allBm25
  }
  const vectorIds = new Set(input.vectorCandidates.map((result) => result.id))
  return bm25Search(
    input.query,
    input.chunks.filter((chunk) => vectorIds.has(chunk.id)),
    input.lexical,
    input.allBm25.length,
  )
}

function vectorCandidatesForMode(
  mode: HybridRetrievalMode,
  input: {
    vectorCandidates: RankedResult[]
    bm25Candidates: RankedResult[]
  },
) {
  if (mode !== "bm25-prefilter") {
    return input.vectorCandidates
  }
  const bm25Ids = new Set(input.bm25Candidates.map((result) => result.id))
  return input.vectorCandidates.filter((result) => bm25Ids.has(result.id))
}

function rankMap(results: RankedResult[]) {
  return new Map(results.map((result, index) => [result.id, index + 1]))
}

function includeScoreTies(results: RankedResult[], limit: number) {
  const cutoffScore = results[limit - 1]?.score
  if (cutoffScore === undefined) {
    return results.slice()
  }
  return results.filter((result) => result.score >= cutoffScore)
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

  return reranked.flatMap((rerankedResult, index) => {
    const candidate = candidates[rerankedResult.index]
    if (!candidate) {
      return []
    }
    const existing = input.retrieval.get(candidate.result.id)
    input.retrieval.set(candidate.result.id, {
      ...(existing ?? { mode: "vector" }),
      rerankRank: index + 1,
      rerankScore: rerankedResult.score,
    })
    return [{ id: candidate.result.id, score: rerankedResult.score }]
  })
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
