#!/usr/bin/env node

const chokidar = require('chokidar');
const { spawn } = require('child_process');
const path = require('path');
const { logger } = require('./logger');

// Args: --root <project_root> --db <db_file> --exporter <exporter_exs> --debounce <ms>
function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const root = getArg('--root', process.env.PROJECT_ROOT || path.resolve('..'));
const dbFile = getArg('--db', process.env.ELIXIR_CONTEXT_DB || path.resolve('../.elixir_context/ec.sqlite'));
const exporter = getArg('--exporter', process.env.EXPORTER || path.resolve(__dirname, 'export.exs'));
const debounceMs = parseInt(getArg('--debounce', '5000'), 10); // 5s default — rebuild takes <1s with --no-compile
const ingestScript = path.resolve(__dirname, 'ingest.js');

logger.info('Watcher starting', { root, dbFile, debounceMs });

const watcher = chokidar.watch(['**/*.ex', '**/*.exs'], {
  cwd: root,
  ignoreInitial: true,
  ignored: ['**/deps/**', '**/_build/**', '**/node_modules/**', '**/.git/**', '**/.worktrees/**'],
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
});

// Batch: collect changed files, flush after debounce window
let pendingFiles = new Set();
let debounceTimer = null;
let rebuildInProgress = false;
let pendingWhileRebuilding = new Set();

function onFileChange(filePath) {
  const fullPath = path.resolve(root, filePath);

  if (rebuildInProgress) {
    // Queue for next batch — don't lose changes that arrive during rebuild
    pendingWhileRebuilding.add(fullPath);
    return;
  }

  pendingFiles.add(fullPath);

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushBatch, debounceMs);
}

function flushBatch() {
  if (pendingFiles.size === 0) return;

  const files = [...pendingFiles];
  pendingFiles = new Set();
  rebuildInProgress = true;

  logger.info(`Incremental rebuild: ${files.length} file(s)`, { files: files.map(f => path.relative(root, f)) });

  // Export only changed files — uses spawn (no shell injection risk)
  const exportArgs = ['run', '--no-compile', '--no-start', exporter, '--files', '--quiet', ...files];
  const exportProcess = spawn('mix', exportArgs, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let jsonl = '';
  let stderr = '';

  exportProcess.stdout.on('data', (data) => { jsonl += data.toString(); });
  exportProcess.stderr.on('data', (data) => { stderr += data.toString(); });

  exportProcess.on('exit', (code) => {
    if (code !== 0) {
      logger.error('Export failed', { code, stderr: stderr.slice(0, 500) });
      rebuildInProgress = false;
      drainPendingQueue();
      return;
    }

    if (!jsonl.trim()) {
      logger.info('Export returned no entries (files may have no Elixir defs)');
      rebuildInProgress = false;
      drainPendingQueue();
      return;
    }

    // Incremental ingest — uses spawn (no shell)
    const ingestProcess = spawn('node', [ingestScript, '-', dbFile, '--incremental'], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let ingestOut = '';
    let ingestErr = '';
    ingestProcess.stdout.on('data', (d) => { ingestOut += d.toString(); });
    ingestProcess.stderr.on('data', (d) => { ingestErr += d.toString(); });

    ingestProcess.stdin.write(jsonl);
    ingestProcess.stdin.end();

    ingestProcess.on('exit', (ingestCode) => {
      if (ingestCode !== 0) {
        logger.error('Incremental ingest failed', { ingestCode, stderr: ingestErr.slice(0, 500) });
      } else {
        logger.info('Incremental rebuild complete', { output: ingestOut.trim() });
      }
      rebuildInProgress = false;
      drainPendingQueue();
    });
  });
}

function drainPendingQueue() {
  // If files arrived during rebuild, schedule them
  if (pendingWhileRebuilding.size > 0) {
    for (const f of pendingWhileRebuilding) {
      pendingFiles.add(f);
    }
    pendingWhileRebuilding = new Set();
    debounceTimer = setTimeout(flushBatch, debounceMs);
  }
}

watcher.on('change', onFileChange);
watcher.on('add', onFileChange);
watcher.on('unlink', (filePath) => {
  // For deleted files: purge from index directly via SQLite
  const fullPath = path.resolve(root, filePath);
  logger.info('File deleted, purging from index', { file: filePath });

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbFile);
    const purgeFts = db.prepare('DELETE FROM functions_fts WHERE id IN (SELECT id FROM functions WHERE path = ?)');
    const purgeEdges = db.prepare('DELETE FROM edges WHERE src_id IN (SELECT id FROM functions WHERE path = ?)');
    const purgeFunctions = db.prepare('DELETE FROM functions WHERE path = ?');
    db.transaction(() => {
      purgeFts.run(fullPath);
      purgeEdges.run(fullPath);
      purgeFunctions.run(fullPath);
    })();
    db.close();
    logger.info('Purged deleted file from index', { file: filePath });
  } catch (err) {
    logger.error('Failed to purge deleted file', { file: filePath, err: err.message });
  }
});

process.on('SIGINT', () => {
  logger.info('Watcher shutting down');
  watcher.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Watcher shutting down');
  watcher.close();
  process.exit(0);
});

logger.info('Watcher ready');
