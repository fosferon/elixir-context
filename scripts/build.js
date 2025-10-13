#!/usr/bin/env node

// Build (export + ingest) an elixir-context index for a given project.
// Usage:
//   elixir-context build --project <project_root> --data <data_dir> [--exporter <export_exs>]
// Examples:
//   elixir-context build --project /Users/leonidas/Sites/mobus/mobus_umbrella --data /Users/leonidas/Sites/mobus/mobus_umbrella/.elixir_context
//   elixir-context build --project /Users/leonidas/Sites/VaultWise --data /Users/leonidas/Sites/VaultWise/.elixir_context --exporter /Users/leonidas/Sites/VaultWise/orchestrator/priv/export.exs

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const projectRoot = getArg('--project', process.env.PROJECT_ROOT || process.cwd());
const dataDir = getArg('--data', process.env.DATA_DIR || path.join(projectRoot, '.elixir_context'));
const exporter = getArg('--exporter', process.env.EXPORTER || path.resolve(__dirname, 'export.exs'));

if (!projectRoot || !dataDir) {
  console.error('Usage: elixir-context build --project <project_root> --data <data_dir> [--exporter <export_exs>]');
  process.exit(1);
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const exportPath = path.join(dataDir, 'export.jsonl');
const dbPath = path.join(dataDir, 'ec.sqlite');

console.log(`[elixir-context] Exporting from ${projectRoot}`);
const exportRes = spawnSync('bash', ['-lc', `cd ${projectRoot} && mix run '${exporter}' --quiet --out '${exportPath}'`], { stdio: 'inherit' });
if (exportRes.status !== 0) {
  console.error('[elixir-context] Export failed');
  process.exit(exportRes.status || 1);
}

console.log(`[elixir-context] Ingesting into ${dbPath}`);
const ingestRes = spawnSync('node', [path.resolve(__dirname, 'ingest.js'), exportPath, dbPath], { stdio: 'inherit' });
if (ingestRes.status !== 0) {
  console.error('[elixir-context] Ingest failed');
  process.exit(ingestRes.status || 1);
}

console.log('[elixir-context] Build complete.');
