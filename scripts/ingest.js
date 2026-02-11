#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Parse args: node ingest.js <jsonl_file> <db_file> [--incremental]
const args = process.argv.slice(2);
const incrementalIdx = args.indexOf('--incremental');
const incremental = incrementalIdx !== -1;
if (incrementalIdx !== -1) args.splice(incrementalIdx, 1);

const jsonlFile = args[0];
const dbFile = args[1];

if (!jsonlFile || !dbFile) {
  console.error('Usage: node ingest.js <jsonl_file> <db_file> [--incremental]');
  process.exit(1);
}

const db = new Database(dbFile);

if (!incremental) {
  // Full rebuild: drop and recreate for clean state
  db.exec('DROP TABLE IF EXISTS functions');
  db.exec('DROP TABLE IF EXISTS edges');
  db.exec('DROP TABLE IF EXISTS functions_fts');

  db.exec('CREATE TABLE functions (id TEXT PRIMARY KEY, module TEXT, name TEXT, arity INTEGER, kind TEXT DEFAULT \'function\', path TEXT, start_line INTEGER, end_line INTEGER, signature TEXT, spec TEXT, doc TEXT, lexical_text TEXT, struct_text TEXT)');
  db.exec('CREATE TABLE edges (src_id TEXT, dst_mfa TEXT, kind TEXT, UNIQUE(src_id, dst_mfa, kind))');
  db.exec('CREATE VIRTUAL TABLE functions_fts USING fts5(id, module, lexical_text)');
  db.exec('CREATE INDEX idx_functions_module_name_arity ON functions(module, name, arity)');
  db.exec('CREATE INDEX idx_functions_path ON functions(path)');
  db.exec('CREATE INDEX idx_functions_kind ON functions(kind)');
  db.exec('CREATE INDEX idx_edges_dst ON edges(dst_mfa)');
} else {
  // Incremental: ensure tables exist (no-op if they do)
  try {
    db.prepare('SELECT count(*) FROM functions').get();
  } catch (err) {
    console.error('Database schema missing. Run a full rebuild first (without --incremental).');
    process.exit(1);
  }
}

// Prepare statements
const insertFunction = db.prepare(`
  INSERT OR REPLACE INTO functions (id, module, name, arity, kind, path, start_line, end_line, signature, spec, doc, lexical_text, struct_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertEdge = db.prepare(`
  INSERT OR IGNORE INTO edges (src_id, dst_mfa, kind)
  VALUES (?, ?, ?)
`);

const insertFts = db.prepare(`
  INSERT OR REPLACE INTO functions_fts (id, module, lexical_text)
  VALUES (?, ?, ?)
`);

// For incremental: clean stale entries by file path before re-inserting
const deleteByPath = incremental ? db.prepare('DELETE FROM functions WHERE path = ?') : null;
const deleteFtsByIds = incremental ? db.prepare('DELETE FROM functions_fts WHERE id IN (SELECT id FROM functions WHERE path = ?)') : null;
const deleteEdgesByPath = incremental ? db.prepare('DELETE FROM edges WHERE src_id IN (SELECT id FROM functions WHERE path = ?)') : null;

// Read and process JSONL
let jsonlContent;
if (jsonlFile === '-') {
  jsonlContent = '';
  process.stdin.on('data', (chunk) => {
    jsonlContent += chunk;
  });
  process.stdin.on('end', () => {
    processLines(jsonlContent.trim().split('\n'));
  });
} else {
  jsonlContent = fs.readFileSync(jsonlFile, 'utf8');
  processLines(jsonlContent.trim().split('\n'));
}

function processLines(lines) {

const transaction = db.transaction(() => {
  // For incremental mode: collect affected paths, purge old entries first
  if (incremental) {
    const affectedPaths = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const func = JSON.parse(line);
        if (func.path) affectedPaths.add(func.path);
      } catch (e) { /* skip malformed */ }
    }
    // Delete old entries for all affected files (order matters: FTS refs → edges → functions)
    for (const p of affectedPaths) {
      deleteFtsByIds.run(p);
      deleteEdgesByPath.run(p);
      deleteByPath.run(p);
    }
  }

  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const func = JSON.parse(line);

    // Ensure all fields are proper types (convert arrays/objects to strings or null)
    const spec = (typeof func.spec === 'string' || func.spec === null) ? func.spec : JSON.stringify(func.spec);
    const doc = (typeof func.doc === 'string' || func.doc === null) ? func.doc : JSON.stringify(func.doc);

    try {
      insertFunction.run(
        func.id,
        func.module,
        func.name,
        func.arity,
        func.kind || 'function',
        func.path,
        func.start_line,
        func.end_line || null,
        func.signature,
        spec,
        doc,
        func.lexical_text,
        func.struct_text
      );
    } catch (err) {
      console.error(`Error inserting ${func.kind || 'function'} ${func.module}.${func.name}/${func.arity}:`, err.message);
      throw err;
    }

    // Insert FTS
    insertFts.run(func.id, func.module, func.lexical_text);

    // Insert edges
    for (const call of func.calls || []) {
      insertEdge.run(func.id, call, 'call');
    }
    count++;
  }
  return count;
});

const count = transaction();

console.log(`${incremental ? 'Incrementally ingested' : 'Ingested'} ${count} entries`);

db.close();
}
