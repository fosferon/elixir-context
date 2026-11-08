# elixir-context

`elixir-context` gives coding CLIs project-wide context for Elixir codebases: it
indexes modules, functions, docs, specs, Phoenix templates, and call edges into
a local SQLite database, then serves search and call-graph queries over the
[Model Context Protocol](https://modelcontextprotocol.io/) (MCP).

## Why

An assistant editing one file can see that file but not the rest of the
project. Grep finds text; it cannot answer "who calls this function", "which
clause handles this message", or "show me the definitions that match this
concept". `elixir-context` answers those questions from an index that stays
local to your machine:

- Full-text search over module/function names, `@doc`, `@spec`, and body
  keywords, with a ripgrep fallback for code the index has not seen yet.
- Caller and callee queries with clause-level attribution, including
  `GenServer.call`/`cast` dispatch to the matching `handle_call`/`handle_cast`
  clause.
- One searchable entry per Phoenix `.heex` template (components, assigns,
  calls).
- An incremental watcher that re-indexes changed `.ex`/`.exs` files.
- No service, account, or network dependency: one SQLite file plus an MCP
  stdio server.

## Requirements

- Node.js 20 or newer.
- An Elixir project that builds with Mix (`mix` on `PATH`).
- The exporter uses `Jason`; it is installed through `Mix.install/1` if the
  target project does not already depend on it.

## Install

The package is not published on npm yet; install from the repository:

```bash
git clone https://github.com/fosferon/elixir-context.git
cd elixir-context
npm install
```

`npm install` also fetches the `better-sqlite3` native module and the ripgrep
binary used for the fallback path.

## Quick start

Build an index for an Elixir project:

```bash
node scripts/build.js \
  --project ~/code/my_app \
  --data ~/code/my_app/.elixir_context
```

Ask a question from the command line:

```bash
node scripts/query.js \
  --db ~/code/my_app/.elixir_context/ec.sqlite \
  --q "MyApp.Accounts" \
  --k 5
```

Register the MCP server with your coding CLI:

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

The server exposes `elixir_context_search`, `elixir_context_pack_context`,
`elixir_context_callers_of`, `elixir_context_calls_from`,
`elixir_context_refresh`, `elixir_context_index_status`, and
`elixir_context_health`.

Keep the index fresh while you work:

```bash
node scripts/watch.js \
  --root ~/code/my_app \
  --db ~/code/my_app/.elixir_context/ec.sqlite
```

The watcher tracks `.ex`/`.exs` changes. Rebuild after `.heex` template
changes.

## Configuration

Flags take precedence over environment variables. The most useful settings:

| Setting | Flag | Environment | Purpose |
| --- | --- | --- | --- |
| Project root | `--project`, `--root` | `PROJECT_ROOT` | Elixir project to index or serve. |
| Data directory | `--data` | `DATA_DIR` | Where the index files live (`build.js`, npm scripts). |
| Database | `--db` | `ELIXIR_CONTEXT_DB` | SQLite file used by query, watch, and the MCP server. |
| Exporter | `--exporter` | `EXPORTER` | Path to `export.exs` for custom export logic. |

See [docs/setup.md](docs/setup.md) for the full workflow, npm script variants,
and troubleshooting. [docs/design.md](docs/design.md) covers the search
pipeline and its trade-offs.

To use the locally linked CLI directly:

```bash
./bin/elixir-context.js --help
```

## Development

```bash
npm test                          # unit + integration tests
bash scripts/public_guard_test.sh # public-content guard fixtures
```

The integration tests need `elixir` on `PATH`; without it they are skipped and
the test run prints how many were skipped.

Enable the pre-push content guard once per clone:

```bash
git config core.hooksPath .githooks
```

The hook scans every commit being pushed. Built-in patterns always run. If
`PUBLIC_GUARD_EXTRA_FILE` is set, or `~/.config/fosferon/public-guard-extra.txt`
exists, the hook also checks those client-name extras and fails if they cannot
be loaded; otherwise it prints that extras were not checked. CI always supplies
the extras from a repository secret. Extra entries are extended regular
expressions, so escape any regex metacharacters in a name.

## License

[MIT](LICENSE) © 2025-2026 Fosferon
