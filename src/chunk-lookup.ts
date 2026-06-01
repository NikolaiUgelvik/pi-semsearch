import {
  chunkBreadcrumbs,
  chunkMatchesSource,
  expandWithParentContext,
  summarizeChunk,
  summarizeTopology,
} from "./topology.js"
import type {
  CastIndex,
  ChunkLookupChildrenPage,
  ChunkLookupInput,
  ChunkLookupOutput,
  ChunkLookupRelatedChunk,
  ChunkRecord,
} from "./types.js"

async function getChunkById(input: {
  index: CastIndex
  input: ChunkLookupInput
  readSource(filePath: string): Promise<string>
}): Promise<ChunkLookupOutput> {
  const diagnostics = [...input.index.metadata.diagnostics]
  const diagnosticDetails = [...(input.index.metadata.diagnosticDetails ?? [])]
  const sourceCache = new Map<string, Promise<SourceReadResult>>()
  const getSource = (filePath: string) => readSourceCached(filePath, input.readSource, sourceCache)
  const chunk = input.index.chunks[input.input.id]
  if (!chunk) {
    if (input.index.metadata.status !== "ready") {
      return {
        status: input.index.metadata,
        diagnostics: [...diagnostics, `index unavailable: ${input.index.metadata.status}`],
        diagnosticDetails,
      }
    }
    return {
      status: input.index.metadata,
      diagnostics: [...diagnostics, `chunk not found: ${input.input.id}`],
      diagnosticDetails,
    }
  }

  const source = await getSource(chunk.filePath)
  const maxContextChars = input.input.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS

  const context = parentContext({
    chunk,
    diagnosticDetails,
    diagnostics,
    includeParents: input.input.includeParents,
    index: input.index,
    maxContextChars,
    source,
  })
  const related = await relatedChunks({
    chunk,
    childrenLimit: input.input.childrenLimit,
    childrenOffset: input.input.childrenOffset,
    chunks: input.index.chunks,
    diagnosticDetails,
    diagnostics,
    getSource,
    includeChildren: input.input.includeChildren,
    includeParents: input.input.includeParents,
    includeSiblings: input.input.includeSiblings,
    maxContextChars,
    symbols: input.index.symbols,
  })

  return chunkLookupOutput({ input, chunk, context, related, source, diagnostics, diagnosticDetails })
}

const DEFAULT_CHILDREN_LIMIT = 20
const DEFAULT_MAX_CONTEXT_CHARS = 12_000

type SourceReadResult = { text: string; ok: true } | { text: ""; ok: false }

function chunkLookupOutput(input: {
  input: { index: CastIndex; input: ChunkLookupInput }
  chunk: ChunkRecord
  context: { breadcrumbs: string[]; parentText?: string; parentRange?: ChunkRecord["range"] }
  related: NonNullable<ChunkLookupOutput["chunk"]>["related"]
  source: SourceReadResult
  diagnostics: string[]
  diagnosticDetails: NonNullable<ChunkLookupOutput["diagnosticDetails"]>
}): ChunkLookupOutput {
  return {
    status: input.input.index.metadata,
    chunk: {
      filePath: input.chunk.filePath,
      language: input.chunk.language,
      range: input.chunk.range,
      kind: input.chunk.kind,
      breadcrumbs: input.context.breadcrumbs,
      text: primaryChunkText(input.input.input, validatedChunkText({ ...input, omittedReason: "chunk text omitted" })),
      parentText: input.context.parentText,
      parentRange: input.context.parentRange,
      topology: summarizeTopology(input.chunk, input.input.index.chunks, input.input.index.symbols),
      related: input.related,
    },
    diagnostics: input.diagnostics,
    diagnosticDetails: input.diagnosticDetails,
  }
}

function primaryChunkText(input: ChunkLookupInput, text: string) {
  return input.maxContextChars === undefined ? text.slice(0, DEFAULT_MAX_CONTEXT_CHARS) : text
}

function parentContext(input: {
  chunk: ChunkRecord
  diagnosticDetails: NonNullable<ChunkLookupOutput["diagnosticDetails"]>
  diagnostics: string[]
  includeParents: boolean | undefined
  index: CastIndex
  maxContextChars: number | undefined
  source: SourceReadResult
}): { breadcrumbs: string[]; parentText?: string; parentRange?: ChunkRecord["range"] } {
  if (input.includeParents === false) {
    return { breadcrumbs: chunkBreadcrumbs(input.chunk, input.index.symbols) }
  }

  if (input.source.ok && chunkMatchesSource(input.source.text, input.chunk)) {
    return expandWithParentContext({
      chunk: input.chunk,
      symbols: input.index.symbols,
      source: input.source.text,
      maxContextChars: input.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS,
    })
  }
  if (input.source.ok) {
    addSourceDiagnostic(
      input,
      "source.mismatch",
      `source mismatch for ${input.chunk.filePath}:${input.chunk.id}; parent context omitted`,
    )
  } else {
    addSourceDiagnostic(
      input,
      "source.read_failed",
      `source read failed for ${input.chunk.filePath}; parent context omitted`,
    )
  }
  return { breadcrumbs: chunkBreadcrumbs(input.chunk, input.index.symbols) }
}

async function relatedChunks(input: {
  chunk: ChunkRecord
  childrenLimit: number | undefined
  childrenOffset: number | undefined
  chunks: CastIndex["chunks"]
  diagnosticDetails: NonNullable<ChunkLookupOutput["diagnosticDetails"]>
  diagnostics: string[]
  getSource(filePath: string): Promise<SourceReadResult>
  includeChildren: boolean | undefined
  includeParents: boolean | undefined
  includeSiblings: boolean | undefined
  maxContextChars: number | undefined
  symbols: CastIndex["symbols"]
}): Promise<NonNullable<ChunkLookupOutput["chunk"]>["related"]> {
  const childrenPage = childPage({
    childChunkIds: input.chunk.childChunkIds,
    includeChildren: input.includeChildren,
    limit: input.childrenLimit,
    offset: input.childrenOffset,
  })
  const [parent, previousSibling, nextSibling, children] = await relatedChunkGroup(input, childrenPage.childIds)
  return {
    parent,
    previousSibling,
    nextSibling,
    children: children.flatMap((child) => (child ? [child] : [])),
    childrenPage: childrenPage.page,
  }
}

function relatedChunkGroup(input: Parameters<typeof relatedChunks>[0], childIds: string[]) {
  const relatedInput = (chunk: ChunkRecord | undefined) =>
    relatedChunk({
      chunk,
      diagnosticDetails: input.diagnosticDetails,
      symbols: input.symbols,
      maxContextChars: input.maxContextChars,
      diagnostics: input.diagnostics,
      getSource: input.getSource,
    })
  return Promise.all([
    input.includeParents === false ? undefined : relatedInput(input.chunks[input.chunk.parentChunkId ?? ""]),
    input.includeSiblings === false ? undefined : relatedInput(input.chunks[input.chunk.previousSiblingChunkId ?? ""]),
    input.includeSiblings === false ? undefined : relatedInput(input.chunks[input.chunk.nextSiblingChunkId ?? ""]),
    Promise.all(childIds.map((id) => relatedInput(input.chunks[id]))),
  ])
}

function childPage(input: {
  childChunkIds: string[]
  includeChildren: boolean | undefined
  limit: number | undefined
  offset: number | undefined
}): { childIds: string[]; page: ChunkLookupChildrenPage } {
  const total = input.childChunkIds.length
  if (input.includeChildren === false) {
    return { childIds: [], page: { offset: 0, limit: 0, total, hasMore: false } }
  }

  const offset = Math.max(input.offset ?? 0, 0)
  const limit = Math.max(input.limit ?? DEFAULT_CHILDREN_LIMIT, 0)
  return {
    childIds: input.childChunkIds.slice(offset, offset + limit),
    page: { offset, limit, total, hasMore: offset + limit < total },
  }
}

async function relatedChunk(input: {
  chunk: ChunkRecord | undefined
  diagnosticDetails: NonNullable<ChunkLookupOutput["diagnosticDetails"]>
  symbols: CastIndex["symbols"]
  maxContextChars: number | undefined
  diagnostics: string[]
  getSource(filePath: string): Promise<SourceReadResult>
}): Promise<ChunkLookupRelatedChunk | undefined> {
  if (!input.chunk) {
    return
  }
  const source = await input.getSource(input.chunk.filePath)
  const text = validatedChunkText({
    chunk: input.chunk,
    source,
    diagnostics: input.diagnostics,
    diagnosticDetails: input.diagnosticDetails,
    omittedReason: "related chunk text omitted",
  })
  return {
    ...summarizeChunk(input.chunk, input.symbols),
    text: text.slice(0, input.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS),
  }
}

function validatedChunkText(input: {
  chunk: ChunkRecord
  source: SourceReadResult
  diagnostics: string[]
  diagnosticDetails: NonNullable<ChunkLookupOutput["diagnosticDetails"]>
  omittedReason: string
}) {
  if (!input.source.ok) {
    addSourceDiagnostic(
      input,
      "source.read_failed",
      `source read failed for ${input.chunk.filePath}:${input.chunk.id}; ${input.omittedReason}`,
    )
    return ""
  }
  if (!chunkMatchesSource(input.source.text, input.chunk)) {
    addSourceDiagnostic(
      input,
      "source.mismatch",
      `source mismatch for ${input.chunk.filePath}:${input.chunk.id}; ${input.omittedReason}`,
    )
    return ""
  }
  return input.chunk.text
}

function addSourceDiagnostic(
  input: {
    chunk: ChunkRecord
    diagnostics: string[]
    diagnosticDetails: NonNullable<ChunkLookupOutput["diagnosticDetails"]>
  },
  code: "source.read_failed" | "source.mismatch",
  message: string,
) {
  input.diagnostics.push(message)
  input.diagnosticDetails.push({ code, message, filePath: input.chunk.filePath, chunkId: input.chunk.id })
}

function readSourceCached(
  filePath: string,
  readSource: (filePath: string) => Promise<string>,
  sourceCache: Map<string, Promise<SourceReadResult>>,
) {
  const cached = sourceCache.get(filePath)
  if (cached) {
    return cached
  }
  const source = readSource(filePath)
    .then((text): SourceReadResult => ({ text, ok: true }))
    .catch((): SourceReadResult => ({ text: "", ok: false }))
  sourceCache.set(filePath, source)
  return source
}

export { getChunkById }
