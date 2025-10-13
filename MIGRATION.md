# Migration Guide for mobus-super-agent

## Quick Start

Upgrade to the improved multi-index search in 3 steps:

### 1. Pull Latest Code

```bash
cd /Users/leonidas/Sites/mcp/elixir-context
git fetch origin
git checkout feature/multi-index-search
npm install
```

### 2. Rebuild Index

```bash
# Set your project paths
export PROJECT_ROOT=/Users/leonidas/Sites/mobus
export DATA_DIR=/Users/leonidas/Sites/mobus/.elixir_context

# Rebuild index with new features
npm run ec:build
```

This will:
- Extract all Elixir functions with enriched metadata
- Index all .heex templates
- Create FTS5 index with full-text content

### 3. Test It

Test searches that previously failed:

```bash
# Should now find results even if "directory_live" is only a variable
node scripts/query.js --db $DATA_DIR/ec.sqlite --q "directory_live" --k 5

# Should find templates using modal component
node scripts/query.js --db $DATA_DIR/ec.sqlite --q "modal" --k 5

# Should find by documentation content
node scripts/query.js --db $DATA_DIR/ec.sqlite --q "validates email" --k 5
```

## What Changed for You

### Search Behavior

**Before:** Searches only matched module/function names exactly
```
search("directory_live") → No results (unless in module name)
```

**After:** Searches match:
1. Module/function names (FTS - fast)
2. Documentation and specs (FTS - fast)
3. Function body keywords (FTS - fast)
4. Any code content (ripgrep fallback - thorough)

```
search("directory_live") → 8 results from various sources
```

### New Search Capabilities

You can now search for:

✅ **Pattern keywords:** "directory_live", "company_id", "vault_manager"
✅ **Documentation:** "validates format", "authenticates user"
✅ **Components:** "<.modal", "<.form_component"
✅ **Assigns:** "@user", "@socket", "@company"
✅ **Any text in code:** Full-text search as fallback

### API (No Changes Required!)

The MCP tool signature is unchanged:

```javascript
elixir_context.search({
  query: "your search",
  k: 10,              // Max results
  use_ripgrep: true   // NEW: Optional, defaults to true
})
```

## Recommended Configuration

### MCP Server Config

Update your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "elixir-context": {
      "command": "node",
      "args": [
        "/Users/leonidas/Sites/mcp/elixir-context/scripts/mcp-stdio.js",
        "--root", "/Users/leonidas/Sites/mobus",
        "--db", "/Users/leonidas/Sites/mobus/.elixir_context/ec.sqlite"
      ],
      "env": {
        "PROJECT_ROOT": "/Users/leonidas/Sites/mobus"
      }
    }
  }
}
```

### File Watcher (Recommended)

Keep your index automatically updated:

```bash
# Terminal 1: Start file watcher
cd /Users/leonidas/Sites/mcp/elixir-context
PROJECT_ROOT=/Users/leonidas/Sites/mobus \
DATA_DIR=/Users/leonidas/Sites/mobus/.elixir_context \
npm run ec:watch
```

Or run in background:
```bash
# Add to your shell startup (.zshrc / .bashrc)
alias mobus-watch="cd /Users/leonidas/Sites/mcp/elixir-context && PROJECT_ROOT=/Users/leonidas/Sites/mobus DATA_DIR=/Users/leonidas/Sites/mobus/.elixir_context npm run ec:watch &"
```

## Troubleshooting

### "Cannot find module 'ripgrep'"

```bash
cd /Users/leonidas/Sites/mcp/elixir-context
npm install
```

### "No results for queries that should work"

Index might be stale. Rebuild:

```bash
cd /Users/leonidas/Sites/mcp/elixir-context
rm -rf /Users/leonidas/Sites/mobus/.elixir_context/*
PROJECT_ROOT=/Users/leonidas/Sites/mobus DATA_DIR=/Users/leonidas/Sites/mobus/.elixir_context npm run ec:build
```

### "Searches are slow"

**Expected behavior:** First FTS query is fast (~100ms), ripgrep fallback adds ~500ms.

To disable ripgrep fallback (FTS only):
```javascript
elixir_context.search({
  query: "...",
  use_ripgrep: false  // Faster but less thorough
})
```

### "Templates not showing up"

Check that .heex files were indexed:

```bash
# Should see template entries
sqlite3 /Users/leonidas/Sites/mobus/.elixir_context/ec.sqlite \
  "SELECT COUNT(*) FROM functions WHERE name = 'template'"
```

If 0, rebuild with:
```bash
npm run ec:build
```

## Performance Expectations

| Operation | Time | Notes |
|-----------|------|-------|
| FTS query | ~100ms | Module/function names, docs, keywords |
| Hybrid query | ~100-600ms | + ripgrep fallback if needed |
| Initial build | 15-40s | One-time per rebuild |
| Watch update | <1s | Per file change |
| Index size | 2-8 MB | ~2x larger than before |

## Rollback Plan

If you need to rollback to the original version:

```bash
cd /Users/leonidas/Sites/mcp/elixir-context
git checkout master
npm install
PROJECT_ROOT=/Users/leonidas/Sites/mobus DATA_DIR=/Users/leonidas/Sites/mobus/.elixir_context npm run ec:build
```

Note: You'll lose the enhanced search capabilities.

## Testing Your Setup

Run this test script:

```bash
#!/bin/bash
# test-search.sh

DB="/Users/leonidas/Sites/mobus/.elixir_context/ec.sqlite"

echo "Test 1: Module name search (should be fast)"
time node scripts/query.js --db $DB --q "MobusWeb" --k 3

echo "\nTest 2: Pattern keyword search (will use ripgrep fallback)"
time node scripts/query.js --db $DB --q "directory_live" --k 3

echo "\nTest 3: Template search"
time node scripts/query.js --db $DB --q "modal" --k 3

echo "\nTest 4: Documentation search"
time node scripts/query.js --db $DB --q "validates" --k 3
```

Expected results:
- Test 1: ~100ms, results from FTS
- Test 2: ~500ms, results from ripgrep fallback
- Test 3: Results from template index
- Test 4: Results matching docs/comments

## Questions?

Check the detailed documentation:
- `IMPROVEMENTS.md` - Complete technical overview
- `SETUP.md` - Architecture and troubleshooting
- GitHub issues: https://github.com/fosferon/elixir-context/issues

## Next Steps

After confirming everything works:

1. Update your workflow to use the new search capabilities
2. Consider enabling file watcher for auto-updates
3. Share feedback on search quality and performance
4. Request additional features if needed

The enhanced search should dramatically improve your code discovery workflow!
