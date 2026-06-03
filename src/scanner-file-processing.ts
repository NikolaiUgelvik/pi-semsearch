import path from "node:path"
import { indexFile } from "./scanner-index-file.js"
import {
  canReadFile,
  loadTextFileForIndexing,
  skipFileDiagnostic,
  statFileForIndexing,
  statIsOlderThanIndex,
} from "./scanner-io.js"
import {
  canReuseCompletedFile,
  canReuseFile,
  canReuseFileWithStat,
  reuseCompletedFileRecords,
  reuseFileRecords,
} from "./scanner-reuse.js"
import type {
  CreateIndexerInput,
  EmbeddingBatcher,
  FileResultWriter,
  FileStatMetadata,
  IndexRunStore,
  RefreshState,
} from "./scanner-types.js"
import type { CastIndex, FileRecord } from "./types.js"

const MAX_QUEUED_REUSED_FILE_RESULTS = 256

interface ScannedFileInput {
  input: CreateIndexerInput
  index: CastIndex
  state: RefreshState
  relativePath: string
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  ensureRun: () => Promise<{ runId: string } | undefined>
  embeddingBatcher: EmbeddingBatcher
  fileResultWriter: FileResultWriter
  signal?: AbortSignal
}

async function processScannedFile(input: ScannedFileInput) {
  input.signal?.throwIfAborted()
  const absolutePath = path.join(input.input.worktree, input.relativePath)
  const fileStat = await statFileForIndexing(absolutePath)
  const previousFile = input.index.files[input.relativePath]

  if (await reuseReadableStatFile(input, absolutePath, fileStat, previousFile)) {
    return input.state.changed
  }
  if (await recordSkippedFile(input, absolutePath, fileStat)) {
    return input.state.changed
  }

  const loaded = await loadTextFileForIndexing(absolutePath)
  input.signal?.throwIfAborted()
  if (await reuseLoadedFile(input, previousFile, loaded.fingerprint)) {
    return input.state.changed
  }
  if (await reuseCompletedFileResult(input, loaded.fingerprint)) {
    return true
  }

  await indexFile({ ...input, absolutePath, currentFingerprint: loaded.fingerprint, fileStat, text: loaded.text })
  return true
}

async function reuseReadableStatFile(
  input: ScannedFileInput,
  absolutePath: string,
  fileStat: FileStatMetadata | undefined,
  previousFile: FileRecord | undefined,
) {
  if (!fileStat || fileStat.sizeBytes > input.input.options.maxFileBytes) {
    return false
  }
  const canRead = await canReadFile(absolutePath)
  if (canRead && !statIsOlderThanIndex(fileStat, input.index.metadata.updatedAt)) {
    return false
  }
  if (
    !(
      previousFile &&
      canReuseFileWithStat(
        input.index,
        input.state.symbolsByFilePath,
        previousFile,
        input.relativePath,
        fileStat,
        input.state.canReuseExistingRecords,
      )
    )
  ) {
    return false
  }
  await reuseScannedFile(input, previousFile)
  return true
}

async function recordSkippedFile(
  input: ScannedFileInput,
  absolutePath: string,
  fileStat: FileStatMetadata | undefined,
) {
  const skipDiagnostic = await skipFileDiagnostic(
    input.relativePath,
    absolutePath,
    fileStat,
    input.input.options.maxFileBytes,
  )
  if (!skipDiagnostic) {
    return false
  }
  input.state.metadataDiagnostics.push(skipDiagnostic.message)
  input.state.metadataDiagnosticDetails.push(skipDiagnostic)
  return true
}

async function reuseLoadedFile(
  input: ScannedFileInput,
  previousFile: FileRecord | undefined,
  currentFingerprint: string,
) {
  if (
    !(
      previousFile &&
      canReuseFile(
        input.index,
        input.state.symbolsByFilePath,
        previousFile,
        input.relativePath,
        currentFingerprint,
        input.state.canReuseExistingRecords,
      )
    )
  ) {
    return false
  }
  await reuseScannedFile(input, previousFile)
  return true
}

async function reuseCompletedFileResult(input: ScannedFileInput, currentFingerprint: string) {
  const activeRun = await input.ensureRun()
  await flushQueuedReusedFileResults(input)
  const completed = activeRun
    ? await completedFileResult(input.runStore, activeRun.runId, input.relativePath, currentFingerprint)
    : undefined
  if (!(completed && canReuseCompletedFile(input.index, completed, input.relativePath, currentFingerprint))) {
    return false
  }
  reuseCompletedFileRecords(completed, input.state)
  return true
}

async function reuseScannedFile(
  input: {
    index: CastIndex
    state: RefreshState
    run: () => { runId: string } | undefined
    ensureRun: () => Promise<{ runId: string } | undefined>
    runStore: IndexRunStore | undefined
    fileResultWriter: FileResultWriter
  },
  previousFile: FileRecord,
) {
  const reused = reuseFileRecords(input.index, previousFile, input.state)
  if (!input.runStore) {
    return
  }
  if (input.run()) {
    await input.fileResultWriter.add(reused)
    return
  }
  input.state.reusedFileResults.push(reused)
  if (input.state.reusedFileResults.length >= MAX_QUEUED_REUSED_FILE_RESULTS) {
    await flushQueuedReusedFileResults(input)
  }
}

async function flushQueuedReusedFileResults(input: {
  state: RefreshState
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  ensureRun: () => Promise<{ runId: string } | undefined>
  fileResultWriter: FileResultWriter
}) {
  if (input.state.reusedFileResults.length === 0 || !input.runStore) {
    return
  }
  await input.ensureRun()
  const queued = input.state.reusedFileResults.splice(0)
  for (const fileResult of queued) {
    await input.fileResultWriter.add(fileResult)
  }
  await input.fileResultWriter.flush()
}

function completedFileResult(
  runStore: IndexRunStore | undefined,
  runId: string,
  relativePath: string,
  currentFingerprint: string,
) {
  return runStore?.getCompletedFile(runId, relativePath, currentFingerprint)
}

export type { ScannedFileInput }
export { flushQueuedReusedFileResults, processScannedFile }
