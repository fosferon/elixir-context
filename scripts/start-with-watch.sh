#!/bin/bash
# Start elixir-context MCP server with automatic file watching

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INDEX_DIR="$(cd "$PROJECT_ROOT/.." && pwd)/.elixir_context"

cd "$PROJECT_ROOT"

# Ensure index directory exists
mkdir -p "$INDEX_DIR"

# Build initial index if database doesn't exist
if [ ! -f "$INDEX_DIR/ec.sqlite" ]; then
    echo "Building initial index..."
    npm run ec:build
fi

# Start watcher in background
echo "Starting file watcher..."
npm run ec:watch &
WATCHER_PID=$!

# Start MCP server in foreground
echo "Starting MCP server..."
npm run ec:serve

# Cleanup on exit
trap "kill $WATCHER_PID 2>/dev/null" EXIT
