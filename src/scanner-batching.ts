import type {
  CreateIndexerInput,
  EmbeddingBatcher,
  EmbeddingResult,
  ScannerFileResult as FileResult,
  FileResultWriter,
  IndexRunStore,
  ScannerStore as Store,
} from "./scanner-types.js"
import type { CastIndex, ChunkRecord, SymbolRecord } from "./types.js"

const DEFAULT_EMBEDDING_BATCH_SIZE = 16
const DEFAULT_EMBEDDING_BATCH_CONCURRENCY = 1
const DEFAULT_FILE_RESULT_WRITE_BATCH_SIZE = 32

function createFileResultWriter(input: {
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
}): FileResultWriter {
  const pending: FileResult[] = []
  let writeChain = Promise.resolve()

  const enqueue = (batch: FileResult[]) => {
    writeChain = writeChain.then(async () => {
      const run = input.run()
      const runStore = input.runStore
      if (!run) {
        return
      }
      if (!runStore) {
        return
      }
      if (hasBatchRunStore(runStore)) {
        await runStore.writeFileResults(run.runId, batch)
        return
      }
      for (const fileResult of batch) {
        await runStore.writeFileResult(run.runId, fileResult)
      }
    })
    return writeChain
  }

  const flushPending = () => {
    if (pending.length === 0) {
      return writeChain
    }
    return enqueue(pending.splice(0, pending.length))
  }

  return {
    add(fileResult) {
      const runStore = input.runStore
      if (!runStore) {
        return Promise.resolve()
      }
      const run = input.run()
      if (!run) {
        return Promise.resolve()
      }
      if (!hasBatchRunStore(runStore)) {
        return enqueue([fileResult])
      }
      pending.push(fileResult)
      return pending.length >= DEFAULT_FILE_RESULT_WRITE_BATCH_SIZE ? flushPending() : writeChain
    },
    flush() {
      return flushPending()
    },
  }
}

function createEmbeddingBatcher(input: CreateIndexerInput, signal?: AbortSignal): EmbeddingBatcher {
  type PendingEmbedding = {
    text: string
    resolve: (result: EmbeddingResult) => void
    reject: (error: unknown) => void
  }

  const batchSize = Math.max(1, input.options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE)
  const maxOutstanding = Math.max(1, input.options.embeddingBatchConcurrency ?? DEFAULT_EMBEDDING_BATCH_CONCURRENCY)
  const queue: PendingEmbedding[] = []
  const outstanding = new Set<Promise<void>>()
  let scheduled = false

  const rejectQueued = () => {
    const error = signal?.reason ?? new Error("This operation was aborted")
    for (const item of queue.splice(0)) {
      item.reject(error)
    }
  }

  const flush = () => {
    scheduled = false
    if (signal?.aborted) {
      rejectQueued()
      return
    }
    if (queue.length === 0 || outstanding.size >= maxOutstanding) {
      return
    }
    const batch = queue.splice(0, batchSize)
    const run = embedPendingBatch(input, batch, signal).finally(() => {
      outstanding.delete(run)
      if (queue.length > 0) {
        scheduleFlush()
      }
    })
    outstanding.add(run)
  }

  const scheduleFlush = () => {
    if (scheduled) {
      return
    }
    scheduled = true
    setTimeout(flush, 0)
  }

  return {
    embed(text) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        queue.push({ text, resolve, reject })
        if (queue.length >= batchSize) {
          flush()
          return
        }
        scheduleFlush()
      })
    },
    async drain() {
      while (queue.length > 0 || outstanding.size > 0) {
        if (signal?.aborted) {
          rejectQueued()
          signal.throwIfAborted()
        }
        flush()
        await Promise.all(Array.from(outstanding))
      }
    },
  }
}

async function embedPendingBatch(
  input: CreateIndexerInput,
  batch: { text: string; resolve(result: EmbeddingResult): void; reject(error: unknown): void }[],
  signal?: AbortSignal,
) {
  const errorResult = (error: unknown): EmbeddingResult => ({
    embeddingError: error instanceof Error ? error.message : String(error),
  })

  if (signal?.aborted) {
    for (const item of batch) {
      item.reject(signal.reason)
    }
    return
  }

  if (input.embedBatch) {
    await Promise.resolve()
      .then(
        () =>
          input.embedBatch?.(
            batch.map((item) => item.text),
            signal,
          ) ?? [],
      )
      .then((embeddings) => {
        for (const [index, item] of batch.entries()) {
          item.resolve(
            embeddings[index]
              ? { embedding: embeddings[index] }
              : { embeddingError: "embedding batch response omitted this input" },
          )
        }
      })
      .catch((error) => {
        const result = errorResult(error)
        for (const item of batch) {
          item.resolve(result)
        }
      })
    return
  }

  await Promise.all(
    batch.map(async (item) => {
      const result = await Promise.resolve()
        .then(() => input.embed(item.text, signal))
        .then((embedding) => ({ embedding }))
        .catch(errorResult)
      item.resolve(result)
    }),
  )
}

async function embedChunks(input: {
  input: CreateIndexerInput
  relativePath: string
  parsed: { language: string }
  chunks: ChunkRecord[]
  symbolsById: Record<string, SymbolRecord>
  fileDiagnostics: string[]
  embeddingBatcher: EmbeddingBatcher
}) {
  const fileChunks: CastIndex["chunks"] = {}
  const embeddedChunks: Array<{ chunk: ChunkRecord; embedded: EmbeddingResult }> = new Array(input.chunks.length)
  const concurrency =
    Math.max(1, input.input.options.embeddingBatchConcurrency ?? DEFAULT_EMBEDDING_BATCH_CONCURRENCY) *
    Math.max(1, input.input.options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE)
  await mapIndexesWithConcurrency(input.chunks.length, concurrency, async (index) => {
    const chunk = input.chunks[index]
    if (!chunk) {
      return
    }
    embeddedChunks[index] = {
      chunk,
      embedded: await input.embeddingBatcher.embed(
        embeddingText(
          input.relativePath,
          input.parsed.language,
          chunk,
          input.symbolsById,
          input.input.options.chunking.expansion,
        ),
      ),
    }
  })

  for (const { chunk, embedded } of embeddedChunks) {
    if ("embeddingError" in embedded) {
      input.fileDiagnostics.push(`embedding failed: ${embedded.embeddingError}`)
    }
    fileChunks[chunk.id] = { ...chunk, ...embedded }
  }
  return fileChunks
}

async function mapIndexesWithConcurrency(
  length: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
) {
  let next = 0
  let failed = false
  let firstError: unknown
  const workers = Array.from({ length: Math.min(concurrency, length) }, async () => {
    while (!failed && next < length) {
      const index = next
      next += 1
      try {
        await worker(index)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
  })
  await Promise.allSettled(workers)
  if (failed) {
    throw firstError
  }
}
function hasBatchRunStore(store: IndexRunStore): store is IndexRunStore & Required<Pick<Store, "writeFileResults">> {
  return Boolean(store.writeFileResults)
}
function embeddingText(
  filePath: string,
  language: string,
  chunk: CastIndex["chunks"][string],
  symbols: CastIndex["symbols"],
  expansion: boolean,
) {
  const fields = [`path: ${filePath}`, `language: ${language}`]
  if (expansion) {
    fields.push(`chunk:\nkind: ${chunk.kind}\nrange: ${chunk.range.lineStart}-${chunk.range.lineEnd}`)
  }
  fields.push(
    `symbols:\n${chunk.symbolIds
      .map((id) => symbols[id])
      .filter((symbol) => symbol)
      .map((symbol) => `${symbol.kind} ${symbol.name}`)
      .join("\n")}`,
  )
  fields.push(`text:\n${chunk.text}`)
  return fields.join("\n")
}

export { createEmbeddingBatcher, createFileResultWriter, embedChunks }
