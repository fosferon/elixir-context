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

// Export Elixir files
console.log(`[elixir-context] Exporting Elixir files from ${projectRoot}`);
const exportRes = spawnSync('bash', ['-lc', `cd ${projectRoot} && mix run --no-start '${exporter}' --quiet --out '${exportPath}'`], { stdio: 'inherit' });
if (exportRes.status !== 0) {
  console.error('[elixir-context] Elixir export failed');
  process.exit(exportRes.status || 1);
}

// Export .heex templates
console.log(`[elixir-context] Exporting .heex templates`);
const parseHeex = require('./parse-heex');

function findHeexFiles(dir, fileList = []) {
  try {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);

      try {
        const stat = fs.lstatSync(filePath); // Use lstat to not follow symlinks

        if (stat.isSymbolicLink()) {
          continue; // Skip symlinks
        }

        if (stat.isDirectory()) {
          // Skip deps, build, and node_modules directories
          if (!['deps', '_build', 'node_modules', '.git', '.elixir_ls', 'cover', 'doc'].includes(file)) {
            findHeexFiles(filePath, fileList);
          }
        } else if (file.endsWith('.heex')) {
          const relativePath = path.relative(projectRoot, filePath);
          fileList.push(relativePath);
        }
      } catch (err) {
        // Skip files/dirs that can't be accessed
        console.error(`Warning: Could not access ${filePath}: ${err.message}`);
        continue;
      }
    }
  } catch (err) {
    console.error(`Warning: Could not read directory ${dir}: ${err.message}`);
  }

  return fileList;
}

const heexFiles = findHeexFiles(projectRoot);
const heexExportPath = path.join(dataDir, 'heex_export.jsonl');
const heexStream = fs.createWriteStream(heexExportPath);

for (const heexFile of heexFiles) {
  try {
    const fullPath = path.join(projectRoot, heexFile);
    const content = fs.readFileSync(fullPath, 'utf8');
    const results = parseHeex.parseHeexFile(heexFile, content);

    for (const result of results) {
      heexStream.write(JSON.stringify(result) + '\n');
    }
  } catch (err) {
    console.error(`Failed to parse ${heexFile}:`, err.message);
  }
}

heexStream.end();
console.log(`[elixir-context] Exported ${heexFiles.length} template files`);

// Ingest everything
console.log(`[elixir-context] Ingesting into ${dbPath}`);
const ingestRes = spawnSync('node', [path.resolve(__dirname, 'ingest.js'), exportPath, dbPath], { stdio: 'inherit' });
if (ingestRes.status !== 0) {
  console.error('[elixir-context] Ingest failed');
  process.exit(ingestRes.status || 1);
}

// Ingest heex if file exists and has content
if (fs.existsSync(heexExportPath) && fs.statSync(heexExportPath).size > 0) {
  const heexIngestRes = spawnSync('node', [path.resolve(__dirname, 'ingest.js'), heexExportPath, dbPath], { stdio: 'inherit' });
  if (heexIngestRes.status !== 0) {
    console.error('[elixir-context] Heex ingest failed');
    process.exit(heexIngestRes.status || 1);
  }
}

console.log('[elixir-context] Build complete.');
