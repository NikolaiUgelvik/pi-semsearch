import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import type { FileStatMetadata, LoadedFile } from "./scanner-types.js"
import type { DiagnosticRecord } from "./types.js"

const BINARY_SAMPLE_BYTES = Number("16") * Number("1024")
const BYTE_NUL = 0
const BYTE_BACKSPACE = 8
const BYTE_TAB = 9
const BYTE_LINE_FEED = 10
const BYTE_FORM_FEED = 12
const BYTE_CARRIAGE_RETURN = 13
const CONTROL_BYTE_LIMIT = 32
const BINARY_CONTROL_RATIO = 0.3
const STAT_FAST_PATH_SETTLE_MS = 1000

async function skipFileDiagnostic(
  relativePath: string,
  filePath: string,
  fileStat: FileStatMetadata | undefined,
  maxFileBytes: number,
): Promise<DiagnosticRecord | undefined> {
  if (!fileStat) {
    return
  }
  if (fileStat.sizeBytes > maxFileBytes) {
    return {
      code: "index.skipped_file",
      message: `${relativePath}: skipped file over maxFileBytes (${fileStat.sizeBytes} > ${maxFileBytes})`,
      filePath: relativePath,
    }
  }
  const sample = new Uint8Array(
    (await readFile(filePath)).subarray(0, Math.min(fileStat.sizeBytes, BINARY_SAMPLE_BYTES)),
  )
  if (isProbablyBinary(sample)) {
    return { code: "index.skipped_file", message: `${relativePath}: skipped binary file`, filePath: relativePath }
  }
}

function isProbablyBinary(bytes: Uint8Array) {
  if (bytes.length === 0) {
    return false
  }
  let suspicious = 0
  for (const byte of bytes) {
    if (byte === BYTE_NUL) {
      return true
    }
    if (byte < CONTROL_BYTE_LIMIT && !isTextControlByte(byte)) {
      suspicious++
    }
  }
  return suspicious / bytes.length > BINARY_CONTROL_RATIO
}

function isTextControlByte(byte: number) {
  return TEXT_CONTROL_BYTES.has(byte)
}

const TEXT_CONTROL_BYTES = new Set([BYTE_BACKSPACE, BYTE_TAB, BYTE_LINE_FEED, BYTE_FORM_FEED, BYTE_CARRIAGE_RETURN])
async function loadTextFileForIndexing(filePath: string): Promise<LoadedFile> {
  const bytes = await readFile(filePath)
  return {
    fingerprint: fingerprintBytes(bytes),
    text: new TextDecoder().decode(bytes),
  }
}

async function statFileForIndexing(filePath: string): Promise<FileStatMetadata | undefined> {
  try {
    const fileStat = await stat(filePath)
    return { sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs, ctimeMs: fileStat.ctimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return
    }
    throw error
  }
}

async function canReadFile(filePath: string) {
  try {
    await access(filePath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function statIsOlderThanIndex(fileStat: FileStatMetadata, updatedAt: number) {
  return (
    updatedAt - fileStat.mtimeMs >= STAT_FAST_PATH_SETTLE_MS && updatedAt - fileStat.ctimeMs >= STAT_FAST_PATH_SETTLE_MS
  )
}

function fingerprintBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

export { canReadFile, loadTextFileForIndexing, skipFileDiagnostic, statFileForIndexing, statIsOlderThanIndex }
