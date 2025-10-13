#!/usr/bin/env node

const chokidar = require('chokidar');
const { spawn } = require('child_process');
const path = require('path');

// Args: --root <project_root> --db <db_file> --exporter <exporter_exs>
function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const root = getArg('--root', process.env.PROJECT_ROOT || path.resolve('..'));
const dbFile = getArg('--db', process.env.ELIXIR_CONTEXT_DB || path.resolve('../.elixir_context/ec.sqlite'));
const exporter = getArg('--exporter', process.env.EXPORTER || path.resolve(__dirname, 'export.exs'));

console.log(`Watching ${root} for changes...`);

const watcher = chokidar.watch(['**/*.ex', '**/*.exs', '**/*.heex'], {
  cwd: root,
  ignoreInitial: true,
  ignored: ['**/deps/**', '**/_build/**', '**/node_modules/**'],
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 }
});

let debounceTimer;

function updateIndex(filePath) {
  console.log(`File changed: ${filePath}`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const isHeex = filePath.endsWith('.heex');
    const fullPath = path.resolve(root, filePath);

    if (isHeex) {
      // Use Node.js heex parser
      const parseHeex = require('./parse-heex');
      const fs = require('fs');

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const results = parseHeex.parseHeexFile(filePath, content);
        const jsonl = results.map(r => JSON.stringify(r)).join('\n');

        // Ingest
        const ingestProcess = spawn('node', ['scripts/ingest.js', '-', dbFile], {
          cwd: __dirname,
          stdio: ['pipe', 'inherit', 'inherit']
        });
        ingestProcess.stdin.write(jsonl);
        ingestProcess.stdin.end();
      } catch (err) {
        console.error(`Failed to parse heex file ${filePath}:`, err.message);
      }
    } else {
      // Use Elixir export for .ex/.exs files
      const exportProcess = spawn('mix', ['run', exporter, '--file', fullPath, '--quiet'], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'inherit']
      });

      let jsonl = '';
      exportProcess.stdout.on('data', (data) => {
        jsonl += data.toString();
      });

      exportProcess.on('exit', (code) => {
        if (code === 0 && jsonl.trim()) {
          // Ingest
          const ingestProcess = spawn('node', ['scripts/ingest.js', '-', dbFile], {
            cwd: __dirname,
            stdio: ['pipe', 'inherit', 'inherit']
          });
          ingestProcess.stdin.write(jsonl);
          ingestProcess.stdin.end();
        }
      });
    }
  }, 500);
}

watcher.on('change', updateIndex);
watcher.on('add', updateIndex);
watcher.on('unlink', updateIndex);

process.on('SIGINT', () => {
  watcher.close();
  process.exit(0);
});