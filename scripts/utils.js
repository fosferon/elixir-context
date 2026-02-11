#!/usr/bin/env node

const path = require('path');

function resolveDbPath(argv = process.argv.slice(2)) {
  const dbFlagIndex = argv.indexOf('--db');
  if (dbFlagIndex !== -1 && argv[dbFlagIndex + 1]) return argv[dbFlagIndex + 1];
  if (process.env.ELIXIR_CONTEXT_DB) return process.env.ELIXIR_CONTEXT_DB;
  return require('path').resolve(__dirname, '..', '../.elixir_context/ec.sqlite');
}

function resolveProjectRoot(argv = process.argv.slice(2)) {
  const rootFlagIndex = argv.indexOf('--root');
  if (rootFlagIndex !== -1 && argv[rootFlagIndex + 1]) return argv[rootFlagIndex + 1];
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  return require('path').resolve(__dirname, '..', '..');
}

function extractModuleFromPath(filePath) {
  const match = filePath.match(/lib\/([^\/]+)\/(.+)\.ex$/);
  if (!match) return 'Unknown';
  const parts = [match[1], ...match[2].split('/')];
  return parts.map(p => p.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')).join('.');
}

function extractFunctionFromLine(line) {
  const match = line.match(/def[p]?\s+([a-z_][a-z0-9_]*)/);
  return match ? match[1] : null;
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = `${r.path}:${r.start_line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  resolveDbPath,
  resolveProjectRoot,
  extractModuleFromPath,
  extractFunctionFromLine,
  dedupeResults
};