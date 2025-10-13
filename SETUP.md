# elixir-context MCP Setup Guide

## Architecture Overview

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  Elixir Files   │────▶│ File Watcher │────▶│   SQLite    │
│  (.ex/.exs)     │     │  (chokidar)  │     │   Index     │
└─────────────────┘     └──────────────┘     └─────────────┘
                                                     │
                                                     ▼
                                              ┌─────────────┐
                                              │ MCP Server  │
                                              │   (stdio)   │
                                              └─────────────┘
                                                     │
                                                     ▼
                                              ┌─────────────┐
                                              │ Claude Code │
                                              └─────────────┘
```

## Current Issue ⚠️

**The file watcher is NOT running**, which means:
- Index is NOT automatically updated when code changes
- Search results will be stale or missing
- Manual rebuilds required

## Solution: Start File Watcher

### Option 1: Automatic (Recommended)

```bash
cd /Users/leonidas/Sites/mcp/elixir-context

# Build initial index
npm run ec:build

# Start file watcher (keep this running)
npm run ec:watch
```

**Watches for changes to:**
- `**/*.ex` - Elixir modules
- `**/*.exs` - Elixir scripts
- `**/*.heex` - Phoenix templates

**Auto-updates index on:**
- File changes
- File additions
- File deletions

### Option 2: Use Wrapper Script

```bash
cd /Users/leonidas/Sites/mcp/elixir-context

# Starts BOTH watcher and server
./scripts/start-with-watch.sh
```

### Option 3: Manual Updates

```bash
cd /Users/leonidas/Sites/mcp/elixir-context

# Rebuild index manually when code changes
npm run ec:build
```

## Verify Setup

### 1. Check if index exists
```bash
ls -la /Users/leonidas/Sites/.elixir_context/
# Should see: ec.sqlite
```

### 2. Check file watcher is running
```bash
ps aux | grep watch.js
# Should see node process running watch.js
```

### 3. Test search
In Claude Code:
```elixir
mcp__elixir-context__elixir_context_search(query: "VaultManager")
# Should return results
```

## Troubleshooting

### "No results found"
- Index doesn't exist or is empty
- Run: `npm run ec:build`

### "Stale results" (missing recent code)
- File watcher not running
- Start: `npm run ec:watch`
- Or rebuild: `npm run ec:build`

### "Tool errors"
- MCP server not configured correctly
- Check Claude Code MCP settings

## How It Works

### 1. Export Phase
```bash
cd ../orchestrator
mix run priv/export.exs
```
- Parses Elixir AST
- Extracts functions, modules, docs
- Outputs JSONL format

### 2. Ingest Phase
```bash
node scripts/ingest.js export.jsonl ec.sqlite
```
- Reads JSONL
- Stores in SQLite
- Creates search indexes

### 3. Watch Phase
```bash
node scripts/watch.js
```
- Monitors file changes
- Re-exports changed files
- Re-ingests incrementally

### 4. Serve Phase
```bash
node scripts/mcp-stdio.js --db ec.sqlite
```
- Runs MCP server
- Responds to search queries
- Returns code context

## Recommended Workflow

### Startup (once per session)
```bash
cd /Users/leonidas/Sites/mcp/elixir-context
npm run ec:build     # Initial index
npm run ec:watch &   # Background watcher
```

### Daily Use
- File watcher keeps index fresh automatically
- No manual intervention needed
- Search always returns current results

### When Things Go Wrong
```bash
# Kill all processes
pkill -f "watch.js"

# Rebuild from scratch
npm run ec:build

# Restart watcher
npm run ec:watch
```

## Performance Notes

- **Initial build**: ~10-30 seconds (full codebase scan)
- **Incremental update**: <1 second (single file)
- **Query latency**: <100ms (SQLite lookup)
- **Index size**: ~1-5 MB (typical Elixir project)

## Integration with Claude Code

Claude Code should automatically use elixir-context for:
- Finding function definitions
- Locating module usages
- Understanding code patterns
- Discovering similar implementations

See `.claude/claude.md` for usage guidelines.
