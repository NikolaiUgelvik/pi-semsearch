import path from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { loadPiSemsearchOptions } from "./config.js"
import { IndexUnavailableError } from "./errors.js"
import { INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC } from "./index-ready.js"
import { unavailableToolResult } from "./output.js"
import type { RuntimeDependencies as SemsearchRuntimeDependencies } from "./runtime.js"
import { SemsearchRuntime } from "./runtime.js"

const SEMSEARCH_STATUS_KEY = "semsearch"
const SEMSEARCH_INDEXING_STATUS = "pi-semsearch indexing"

function createRegisteredPiSemsearchExtensionForTest(dependencies: SemsearchRuntimeDependencies = {}) {
  return function semsearchExtension(pi: ExtensionAPI) {
    const runtimes = new Map<string, SemsearchRuntime>()
    const runtimeFor = createRuntimeResolver(runtimes, dependencies)
    registerLifecycle(pi, runtimes, runtimeFor)
    registerRefreshCommand(pi, runtimeFor)
    registerFileMutationIndexHooks(pi, runtimeFor)
    registerSearchTool(pi, runtimeFor)
    registerChunkLookupTool(pi, runtimeFor)
  }
}

function createRuntimeResolver(runtimes: Map<string, SemsearchRuntime>, dependencies: SemsearchRuntimeDependencies) {
  return async (ctx: Pick<ExtensionContext, "cwd" | "ui">) => {
    const worktree = path.resolve(ctx.cwd)
    const existing = runtimes.get(worktree)
    if (existing) {
      return existing
    }
    const runtime = new SemsearchRuntime({ worktree, options: await loadPiSemsearchOptions(worktree), dependencies })
    runtimes.set(worktree, runtime)
    await runtime.start()
    return runtime
  }
}

type RuntimeResolver = ReturnType<typeof createRuntimeResolver>

function registerLifecycle(pi: ExtensionAPI, runtimes: Map<string, SemsearchRuntime>, runtimeFor: RuntimeResolver) {
  pi.on("session_start", async (_event, ctx) => {
    const runtime = await runtimeFor(ctx)
    trackIndexingStatus(ctx, runtime, runtime.currentRefresh())
  })

  pi.on("session_shutdown", () => {
    for (const runtime of runtimes.values()) {
      runtime.dispose()
    }
    runtimes.clear()
  })
}

function registerRefreshCommand(pi: ExtensionAPI, runtimeFor: RuntimeResolver) {
  pi.registerCommand("semsearch-refresh", {
    description: "Refresh the pi-semsearch code index for the current project",
    handler: async (_args, ctx) => {
      const runtime = await runtimeFor(ctx)
      const refresh = runtime.queueRefresh({ forced: true })
      trackIndexingStatus(ctx, runtime, refresh)
      await refresh
      ctx.ui.notify("pi-semsearch index refreshed", "info")
    },
  })
}

function registerFileMutationIndexHooks(pi: ExtensionAPI, runtimeFor: RuntimeResolver) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isFileMutationToolEvent(event)) {
      return
    }
    const runtime = await runtimeFor(ctx)
    runtime.trackPendingWrite(event.toolCallId, event.input.path)
  })

  pi.on("tool_result", async (event, ctx) => {
    if (!isFileMutationToolEvent(event)) {
      return
    }
    const runtime = await runtimeFor(ctx)
    const refresh = runtime.completePendingWrite(event.toolCallId, event.input.path, event.isError !== true)
    trackIndexingStatus(ctx, runtime, refresh)
  })

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!isFileMutationToolName(event.toolName)) {
      return
    }
    const runtime = await runtimeFor(ctx)
    runtime.resolveUnseenPendingWrite(event.toolCallId)
  })
}

function trackIndexingStatus(
  ctx: Pick<ExtensionContext, "ui">,
  runtime: SemsearchRuntime,
  refresh: Promise<unknown> | undefined,
) {
  if (!refresh) {
    return
  }
  ctx.ui.setStatus(SEMSEARCH_STATUS_KEY, SEMSEARCH_INDEXING_STATUS)
  refresh
    .finally(() => {
      if (!runtime.currentRefresh()) {
        ctx.ui.setStatus(SEMSEARCH_STATUS_KEY, undefined)
      }
    })
    .catch(() => undefined)
}

function registerSearchTool(pi: ExtensionAPI, runtimeFor: RuntimeResolver) {
  pi.registerTool({
    name: "semantic_search_code",
    label: "Semantic Search Code",
    description: `Find relevant code in the current repository by meaning instead of exact text, symbol, or implementation intent.

Use this as the default first tool for code discovery in this repository, including when the user asks how something works, where behavior, features, APIs, errors, data flow, or relevant code lives, or asks about a known class, function, method, type, test, or feature name. Prefer this before grep/glob/read because it returns ranked, syntax-aware matches with surrounding implementation context and file/line references.

Search results are compact ranked matches by default. Each result includes matched chunk text, scores, breadcrumbs, retrieval details, and topology IDs/labels. Parent body text is returned only when includeParents is true. Use semantic_get_chunk with topology IDs for expanded parent/sibling/child context.

Use grep only when you need exhaustive literal matching, occurrence counts, mechanical text replacement preparation, or matches in files that are not meaningfully represented as code chunks. Use read after this tool returns candidates when you need larger surrounding context or exact verification. Use paths to restrict the search area. Use refresh if files may have changed since the index was built.`,
    promptSnippet: "Find relevant code by semantic meaning with syntax-aware chunks and topology IDs.",
    promptGuidelines: [
      "Use semantic_search_code as the default first tool for code discovery unless exact literal matching is required.",
      "Use semantic_get_chunk with IDs from semantic_search_code when expanded parent, sibling, or child context is needed.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language repository search query." }),
      topK: Type.Optional(Type.Number({ description: "Number of final results. Defaults to 5." })),
      minFinalScore: Type.Optional(Type.Number({ description: "Minimum final retrieval score. Defaults to 0.01." })),
      maxContextChars: Type.Optional(Type.Number({ description: "Context budget. Defaults to 12000." })),
      includeParents: Type.Optional(Type.Boolean({ description: "Include expanded parent body text." })),
      refresh: Type.Optional(Type.Boolean({ description: "Force an index refresh before searching." })),
      paths: Type.Optional(
        Type.Array(Type.String(), { description: "Path filters: exact paths, directory prefixes, or globs." }),
      ),
    }),
    async execute(...args) {
      const [, params, signal, onUpdate, ctx] = args
      const runtime = await runtimeFor(ctx)
      const unavailable = runtime.semanticSearchUnavailable()
      if (unavailable) {
        return piToolResult(unavailable)
      }
      onUpdate?.({ content: [{ type: "text", text: "Searching semantic code index..." }], details: {} })
      try {
        const output = await runtime.semanticSearchOutput(params, signal, ctx)
        return piToolResult(runtime.searchToolResult(params.query, output))
      } catch (error) {
        if (!(error instanceof IndexUnavailableError)) {
          throw error
        }
        return piToolResult(
          unavailableToolResult("Semantic code search index unavailable", INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC),
        )
      }
    },
  })
}

function registerChunkLookupTool(pi: ExtensionAPI, runtimeFor: RuntimeResolver) {
  pi.registerTool({
    name: "semantic_get_chunk",
    label: "Semantic Get Chunk",
    description:
      "Fetch an indexed semantic code chunk by a topology node ID returned from semantic_search_code, with optional parent, sibling, and child topology context.",
    promptSnippet: "Fetch exact semantic chunk context by topology node ID from semantic_search_code.",
    parameters: Type.Object({
      id: Type.String({
        description:
          "A topology node id returned from semantic_search_code, such as topology.current.id, topology.parent.id, a sibling id, or a child id.",
      }),
      includeParents: Type.Optional(Type.Boolean()),
      includeSiblings: Type.Optional(Type.Boolean()),
      includeChildren: Type.Optional(Type.Boolean()),
      childrenOffset: Type.Optional(Type.Number()),
      childrenLimit: Type.Optional(Type.Number()),
      maxContextChars: Type.Optional(Type.Number()),
    }),
    async execute(...args) {
      const [, params, , onUpdate, ctx] = args
      const runtime = await runtimeFor(ctx)
      onUpdate?.({ content: [{ type: "text", text: `Fetching semantic chunk ${params.id}...` }], details: {} })
      return piToolResult(await runtime.lookupChunk(params))
    },
  })
}

function piToolResult(result: { title: string; output: string; metadata?: unknown }) {
  return {
    content: [{ type: "text" as const, text: `${result.title}\n\n${result.output}` }],
    details: result.metadata && typeof result.metadata === "object" ? result.metadata : { metadata: result.metadata },
  }
}

function isFileMutationToolEvent(event: { toolName?: unknown; input?: unknown; toolCallId?: unknown }): event is {
  toolName: "edit" | "write"
  toolCallId: string
  input: { path: string }
} {
  return (
    isFileMutationToolName(event.toolName) &&
    typeof event.toolCallId === "string" &&
    typeof event.input === "object" &&
    event.input !== null &&
    "path" in event.input &&
    typeof event.input.path === "string"
  )
}

function isFileMutationToolName(toolName: unknown): toolName is "edit" | "write" {
  return toolName === "edit" || toolName === "write"
}

export { createRegisteredPiSemsearchExtensionForTest }
