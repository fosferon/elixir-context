#!/usr/bin/env node

const chokidar = require('chokidar');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve('../orchestrator');
const dbFile = path.resolve('../.elixir_context/ec.sqlite');

console.log(`Watching ${root} for changes...`);

const watcher = chokidar.watch(['**/*.ex', '**/*.exs', '**/*.heex'], {
  cwd: root,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 }
});

let debounceTimer;

function updateIndex(filePath) {
  console.log(`File changed: ${filePath}`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    // Run export for single file
    const exportProcess = spawn('mix', ['run', 'priv/export.exs', '--file', filePath], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'inherit']
    });

    let jsonl = '';
    exportProcess.stdout.on('data', (data) => {
      jsonl += data.toString();
    });

    exportProcess.on('exit', (code) => {
      if (code === 0) {
        // Ingest
        const ingestProcess = spawn('node', ['scripts/ingest.js', '-', dbFile], {
          cwd: __dirname,
          stdio: ['pipe', 'inherit', 'inherit']
        });
        ingestProcess.stdin.write(jsonl);
        ingestProcess.stdin.end();
      }
    });
  }, 500);
}

watcher.on('change', updateIndex);
watcher.on('add', updateIndex);
watcher.on('unlink', updateIndex);

process.on('SIGINT', () => {
  watcher.close();
  process.exit(0);
});