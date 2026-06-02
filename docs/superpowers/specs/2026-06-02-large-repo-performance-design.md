# Large Repo Performance Design

## Goal

Improve semantic indexing and retrieval behavior for large repositories by removing avoidable full-tree fanout, repeated per-file work, unbounded memory retention, and expensive output hydration where small, safe changes can produce measurable wins.

## Scope

This design covers a broad first performance pass across scanner traversal, refresh reuse, retrieval output, chunk lookup, embedding behavior, and startup freshness checks. The work should prefer low-risk changes that preserve the existing cache schema and public tool behavior.

The full store/indexing architecture rewrite that avoids `store.read()` hydrating the entire active index is explicitly deferred from this implementation batch. That rewrite needs new store APIs and broader tests than the rest of this batch combined.

## Current Bottlenecks

- `src/scanner.ts` walks directories recursively with `Promise.all()`, materializes all paths, then applies include and exclude filters afterward.
- `src/scanner.ts` recompiles minimatch patterns in hot traversal and filtering loops.
- Refresh reuse scans all symbols per file, creating `O(files * symbols)` behavior for mostly unchanged large repos.
- Search output reads the same source file once per result instead of sharing a per-query source cache.
- Duplicate parent suppression includes full `parentText` in the dedupe key, retaining large strings unnecessarily.
- `semantic_get_chunk` and store hydration can load more related children than the response returns.
- Embedding uses a single in-flight batch by default, has no exposed concurrency option, and lacks retry/backoff for transient provider errors.
- Startup readiness ignores some scanner-shape options, so option changes can leave a stale active index until a forced refresh.

## Design

### 1. Scanner And Path Filtering

Replace the recursive full-list directory walk with a bounded traversal that limits directory fanout and avoids deep recursive promise trees. The first implementation can still return a file list to the existing worker pool if fully streaming into `processScannedFiles` is too invasive, but it must remove unbounded recursive `Promise.all()` and nested `flat()` accumulation.

Compile include and exclude globs once per scan. Use reusable predicates for file inclusion, file exclusion, and excluded-directory pruning instead of calling `minimatch()` with raw patterns in every hot loop. Preserve current matching semantics, including dotfile behavior and directory exclusion checks.

### 2. Refresh Reuse Memory And CPU

Build a `symbolsByFilePath` map once per refresh and pass it into unchanged-file validation and reuse. This removes repeated `Object.values(index.symbols).filter(...)` calls for each file.

Reduce retained reused-result memory where possible without changing the store schema. If a run exists, reused file results should be written through the existing file-result writer in bounded batches instead of accumulating every reused result until the end. If no run exists, keep the existing in-memory behavior.

### 3. Retrieval And Output

Add a per-search source cache in `src/retriever.ts` so multiple results from the same file share one source read and validation input. This should mirror the existing lookup source cache pattern.

Change duplicate parent range suppression to key only on file path and byte range. The full parent text is not needed to identify duplicate ranges and should not be retained in the key set.

Bound related child lookup output work to the requested page size. Store-side hydration can keep loading topology with the current API in this batch, but the response assembly must not process or return children outside the requested page. Add a regression test documenting the remaining store-side over-hydration risk so the deferred store API rewrite has a precise target.

### 4. Embedding Behavior

Add an optional embedding concurrency setting to parsed options and scanner input. Keep the default conservative to avoid surprising provider rate-limit behavior, but allow users indexing large repos to opt into more than one in-flight batch.

Add bounded retry with exponential backoff and jitter for transient embedding HTTP failures such as `408`, `429`, and `5xx`. Do not retry validation errors, malformed responses, or permanent client configuration failures.

Add backpressure so a file with many chunks does not enqueue unbounded embedding texts while only a small number of batches drain. Replace `Promise.all(input.chunks.map(...))` with a bounded producer loop that keeps at most a configured number of unresolved embedding requests queued per file.

### 5. Startup Freshness

Extend startup readiness checks to compare all scanner-shape options that affect indexed coverage: `maxFileBytes`, `includeGlobs`, and `excludeGlobs`, in addition to existing chunking and worktree checks. If these values differ, queue the background refresh rather than silently using stale coverage.

## Error Handling

- Traversal errors should preserve existing behavior: non-`ENOENT` `.gitignore` read errors and filesystem traversal errors still fail refresh.
- Embedding retries should produce one final diagnostic per failed chunk after retries are exhausted, not one diagnostic per retry attempt.
- If a retryable embedding response remains failed, existing chunk-level `embeddingError` handling should remain intact.
- Source-cache failures should still produce source diagnostics, but repeated results from the same failed file should avoid duplicate filesystem work.

## Testing

Add focused tests before each behavior change:

- Scanner traversal indexes deep nested files without recursive fanout and preserves exclude/gitignore behavior.
- Scanner glob predicates preserve include/exclude semantics.
- Refresh reuse avoids repeated all-symbol scans by verifying symbol lookup behavior on many files or with an instrumented fixture.
- Search output reads a shared file once when multiple results come from that file.
- Duplicate parent suppression omits duplicate parent ranges without using parent text in the key.
- Chunk lookup child paging or hydration cap prevents returning or processing unrelated child entries beyond the requested page where implemented.
- Embedding concurrency respects the configured maximum in-flight batches.
- Embedding retry retries transient failures and does not retry permanent failures.
- Startup readiness queues refresh when `maxFileBytes`, `includeGlobs`, or `excludeGlobs` differ from metadata.

Run the existing focused suites after each task and final verification with `bun run typecheck`, `bun run lint`, `bun run build`, and `bun test --timeout 30000`.

## Non-Goals

- No cache schema migration in the first staged batch unless a narrow index addition is clearly required and fully tested.
- No full worker-thread or subprocess migration for indexing in this batch.
- No ANN/vector-store replacement.
- No broad public API redesign beyond optional embedding concurrency configuration.
