# Search design

## Overview

`elixir-context` answers search queries from a local SQLite index and falls back
to ripgrep for code that the index has not seen yet. A separate pass indexes
Phoenix `.heex` templates. This document describes how those pieces fit
together and what the trade-offs are.

## What the index contains

The Elixir exporter records, for each module and function:

- module and function names, arity, kind, path, and line range;
- `@doc` text and `@spec` signatures;
- a lexical text field combining the signature, docs, spec, and up to 30
  selected body keywords;
- call edges, including clause-level attribution where the call target can be
  resolved.

A JavaScript pass then adds one searchable entry per `.heex` template, with
component references, assigns, function calls, and module context derived from
the file path.

## Search flow

1. The query is sanitised for FTS5 syntax.
2. SQLite FTS5 ranks matches with `bm25` and returns up to `k` results.
3. If FTS returns fewer than 2 results and `use_ripgrep` is not `false`, the
   server runs ripgrep over the project and merges the matches with the FTS
   results.
4. Results are deduplicated. Each result carries a `source` field:
   `"fts"`, `"ripgrep"`, or `"template"`.

FTS is the fast path. The ripgrep fallback costs more on large trees; callers
that need predictable latency can disable it with `use_ripgrep: false`. No
benchmark is committed for this repository, so timings depend on the project
size and machine.

## Result shape

A search result identifies where it came from and where the code lives:

```javascript
{
  path: "lib/app_web/live/user_live/index.ex",
  module: "AppWeb.UserLive.Index",
  name: "mount",
  start_line: 42,
  source: "fts"  // or "ripgrep" or "template"
}
```

Callers and callees are queried separately with `callers_of` and `calls_from`,
which return the call sites and clause attribution where available.

## Trade-offs and limits

- The ripgrep fallback trades latency for recall on code that has not been
  indexed or that does not match the FTS tokenizer.
- Template entries are built by a full pass over `.heex` files. The watcher only
  tracks `.ex` and `.exs`; rebuild the index after template changes.
- This is lexical search, not semantic embedding search. Struct field indexing,
  macro expansion, cross-project search, and incremental template parsing are
  not implemented.
- The index is local: one SQLite file plus the MCP stdio server, with no service
  or network dependency.

## Checking the behaviour

Build an index, then use `scripts/query.js` or the MCP tools:

```bash
# Enriched FTS text: docs, specs, and body keywords
node scripts/query.js --db ~/code/my_app/.elixir_context/ec.sqlite --q "validate email" --k 5

# Ripgrep fallback: a term that only appears in a function body
node scripts/query.js --db ~/code/my_app/.elixir_context/ec.sqlite --q "user_live" --k 5

# Template indexing: component usage
node scripts/query.js --db ~/code/my_app/.elixir_context/ec.sqlite --q "modal component" --k 5
```

The `source` field in each result shows which path produced it. The fallback
threshold and the `use_ripgrep` switch are in `scripts/mcp-stdio.js`.
