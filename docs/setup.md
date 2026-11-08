# Setup and operation

`elixir-context` has two halves: a one-time exporter/ingester that turns an
Elixir project into a SQLite index, and a long-running MCP server that answers
queries from a coding CLI over stdio.

## Requirements

- Node.js 20 or newer.
- An Elixir project that builds with Mix (`mix` on `PATH`).
- The exporter uses `Jason`; if it is not already a dependency of the target
  project, the exporter installs it with `Mix.install/1` on first run.

## What gets indexed

The Elixir exporter reads `apps/`, `lib/`, `test/`, `config/`, `priv/` and
top-level `.ex`/`.exs` files. It records modules, public and private functions,
macros, selected macro calls (Ecto schema macros, Phoenix `plug`, router
verbs, and similar), specs, docs, body keywords, call edges, and multi-clause
manifests. A JavaScript pass adds one searchable entry per Phoenix `.heex`
template.

## Build an index

From the `elixir-context` checkout:

```bash
npm install
node scripts/build.js \
  --project ~/code/my_app \
  --data ~/code/my_app/.elixir_context
```

`--data` defaults to `<project>/.elixir_context`; `--exporter` defaults to this
repository's `scripts/export.exs`. The build writes `export.jsonl`,
`heex_export.jsonl`, and `ec.sqlite` into the data directory.

To build through npm instead, set the project and data paths explicitly. The
exporter path must point at this repository, not at the target project:

```bash
PROJECT_ROOT=~/code/my_app \
DATA_DIR=~/code/my_app/.elixir_context \
EXPORTER="$PWD/scripts/export.exs" \
npm run ec:build
```

## Query from the command line

```bash
node scripts/query.js \
  --db ~/code/my_app/.elixir_context/ec.sqlite \
  --q "MyApp.Accounts" \
  --k 5
```

Add `--pack` to return full definitions and one-hop neighbours as JSON.

## Run the MCP server

```bash
node scripts/mcp-stdio.js \
  --root ~/code/my_app \
  --db ~/code/my_app/.elixir_context/ec.sqlite
```

The server speaks JSON-RPC on stdin/stdout and logs to stderr. Point your MCP
client at it:

```json
{
  "mcpServers": {
    "elixir-context": {
      "command": "node",
      "args": [
        "/absolute/path/to/elixir-context/scripts/mcp-stdio.js",
        "--root", "/absolute/path/to/my_app",
        "--db", "/absolute/path/to/my_app/.elixir_context/ec.sqlite"
      ]
    }
  }
}
```

Tools exposed: `elixir_context_search`, `elixir_context_pack_context`,
`elixir_context_callers_of`, `elixir_context_calls_from`,
`elixir_context_refresh`, `elixir_context_index_status`, and
`elixir_context_health`.

## Keep the index fresh

```bash
node scripts/watch.js \
  --root ~/code/my_app \
  --db ~/code/my_app/.elixir_context/ec.sqlite
```

The watcher re-exports changed `.ex`/`.exs` files after a debounce (5 seconds
by default) and re-ingests only the affected files. `.heex` templates are not
watched; rebuild the index after template changes.

`scripts/start-with-watch.sh` starts the watcher and the MCP server together
for a checkout whose parent directory is the target project.

## Configuration

| Variable | Used by | Meaning |
| --- | --- | --- |
| `PROJECT_ROOT` | npm scripts, `build.js`, `watch.js`, `mcp-stdio.js` | Target Elixir project root. Flags `--project`/`--root` take precedence. |
| `DATA_DIR` | npm scripts, `build.js` | Directory for the index files. `--data` takes precedence. |
| `ELIXIR_CONTEXT_DB` | `query.js`, `watch.js`, `mcp-stdio.js` | SQLite file to read/write. A `--db` flag takes precedence. |
| `EXPORTER` | npm scripts, `watch.js`, `build.js` | Path to `export.exs`. |

## Troubleshooting

- **No results**: confirm the database exists and `index_status` reports rows.
  Rebuild with `scripts/build.js`.
- **`mix` not found**: run the build from a shell where the target project can
  run `mix`.
- **`better-sqlite3` load error**: reinstall dependencies so the native module
  matches your Node version (`npm ci`).
- **Ripgrep fallback missing**: `@vscode/ripgrep` ships the binary during
  `npm install`; search still works from FTS alone if it is unavailable.
- **Stale templates**: restart the build; the watcher only tracks `.ex`/`.exs`.
