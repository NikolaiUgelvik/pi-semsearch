import path from "node:path";
import { indexFile } from "./scanner-index-file.js";
import { canReadFile, loadTextFileForIndexing, skipFileDiagnostic, statFileForIndexing, statIsOlderThanIndex, } from "./scanner-io.js";
import { canReuseCompletedFile, canReuseFile, canReuseFileWithStat, reuseCompletedFileRecords, reuseFileRecords, } from "./scanner-reuse.js";
const MAX_QUEUED_REUSED_FILE_RESULTS = 256;
async function processScannedFile(input) {
    input.signal?.throwIfAborted();
    const absolutePath = path.join(input.input.worktree, input.relativePath);
    const fileStat = await statFileForIndexing(absolutePath);
    const previousFile = input.index.files[input.relativePath];
    if (await reuseReadableStatFile(input, absolutePath, fileStat, previousFile)) {
        return input.state.changed;
    }
    if (await recordSkippedFile(input, absolutePath, fileStat)) {
        return input.state.changed;
    }
    const loaded = await loadTextFileForIndexing(absolutePath);
    input.signal?.throwIfAborted();
    if (await reuseLoadedFile(input, previousFile, loaded.fingerprint)) {
        return input.state.changed;
    }
    if (await reuseCompletedFileResult(input, loaded.fingerprint)) {
        return true;
    }
    await indexFile({ ...input, absolutePath, currentFingerprint: loaded.fingerprint, fileStat, text: loaded.text });
    return true;
}
async function reuseReadableStatFile(input, absolutePath, fileStat, previousFile) {
    if (!fileStat || fileStat.sizeBytes > input.input.options.maxFileBytes) {
        return false;
    }
    const canRead = await canReadFile(absolutePath);
    if (canRead && !statIsOlderThanIndex(fileStat, input.index.metadata.updatedAt)) {
        return false;
    }
    if (!(previousFile &&
        canReuseFileWithStat(input.index, input.state.symbolsByFilePath, previousFile, input.relativePath, fileStat, input.state.canReuseExistingRecords))) {
        return false;
    }
    await reuseScannedFile(input, previousFile);
    return true;
}
async function recordSkippedFile(input, absolutePath, fileStat) {
    const skipDiagnostic = await skipFileDiagnostic(input.relativePath, absolutePath, fileStat, input.input.options.maxFileBytes);
    if (!skipDiagnostic) {
        return false;
    }
    input.state.metadataDiagnostics.push(skipDiagnostic.message);
    input.state.metadataDiagnosticDetails.push(skipDiagnostic);
    return true;
}
async function reuseLoadedFile(input, previousFile, currentFingerprint) {
    if (!(previousFile &&
        canReuseFile(input.index, input.state.symbolsByFilePath, previousFile, input.relativePath, currentFingerprint, input.state.canReuseExistingRecords))) {
        return false;
    }
    await reuseScannedFile(input, previousFile);
    return true;
}
async function reuseCompletedFileResult(input, currentFingerprint) {
    const activeRun = await input.ensureRun();
    await flushQueuedReusedFileResults(input);
    const completed = activeRun
        ? await completedFileResult(input.runStore, activeRun.runId, input.relativePath, currentFingerprint)
        : undefined;
    if (!(completed && canReuseCompletedFile(input.index, completed, input.relativePath, currentFingerprint))) {
        return false;
    }
    reuseCompletedFileRecords(completed, input.state);
    return true;
}
async function reuseScannedFile(input, previousFile) {
    const reused = reuseFileRecords(input.index, previousFile, input.state);
    if (!input.runStore) {
        return;
    }
    if (input.run()) {
        await input.fileResultWriter.add(reused);
        return;
    }
    input.state.reusedFileResults.push(reused);
    if (input.state.reusedFileResults.length >= MAX_QUEUED_REUSED_FILE_RESULTS) {
        await flushQueuedReusedFileResults(input);
    }
}
async function flushQueuedReusedFileResults(input) {
    if (input.state.reusedFileResults.length === 0 || !input.runStore) {
        return;
    }
    await input.ensureRun();
    const queued = input.state.reusedFileResults.splice(0);
    for (const fileResult of queued) {
        await input.fileResultWriter.add(fileResult);
    }
    await input.fileResultWriter.flush();
}
function completedFileResult(runStore, runId, relativePath, currentFingerprint) {
    return runStore?.getCompletedFile(runId, relativePath, currentFingerprint);
}
export { flushQueuedReusedFileResults, processScannedFile };
