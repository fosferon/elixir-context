#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const jsonlFile = process.argv[2];
const dbFile = process.argv[3];

if (!jsonlFile || !dbFile) {
  console.error('Usage: node ingest.js <jsonl_file> <db_file>');
  process.exit(1);
}

const db = new Database(dbFile);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS functions (
    id TEXT PRIMARY KEY,
    module TEXT,
    name TEXT,
    arity INTEGER,
    path TEXT,
    start_line INTEGER,
    end_line INTEGER,
    signature TEXT,
    spec TEXT,
    doc TEXT,
    lexical_text TEXT,
    struct_text TEXT
  );

  CREATE TABLE IF NOT EXISTS edges (
    src_id TEXT,
    dst_mfa TEXT,
    kind TEXT,
    UNIQUE(src_id, dst_mfa, kind)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS functions_fts USING fts5(id, lexical_text);

  CREATE INDEX IF NOT EXISTS idx_functions_module_name_arity ON functions(module, name, arity);
  CREATE INDEX IF NOT EXISTS idx_functions_path ON functions(path);
`);

// Prepare statements
const insertFunction = db.prepare(`
  INSERT OR REPLACE INTO functions (id, module, name, arity, path, start_line, end_line, signature, spec, doc, lexical_text, struct_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertEdge = db.prepare(`
  INSERT OR IGNORE INTO edges (src_id, dst_mfa, kind)
  VALUES (?, ?, ?)
`);

const insertFts = db.prepare(`
  INSERT OR REPLACE INTO functions_fts (id, lexical_text)
  VALUES (?, ?)
`);

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
  for (const line of lines) {
    if (!line.trim()) continue;
    const func = JSON.parse(line);

    // Insert function
    insertFunction.run(
      func.id,
      func.module,
      func.name,
      func.arity,
      func.path,
      func.start_line,
      func.end_line || null,
      func.signature,
      func.spec,
      func.doc,
      func.lexical_text,
      func.struct_text
    );

    // Insert FTS
    insertFts.run(func.id, func.lexical_text);

    // Insert edges
    for (const call of func.calls || []) {
      insertEdge.run(func.id, call, 'call');
    }
  }
});

transaction();

console.log(`Ingested ${lines.length} functions`);

db.close();
}
