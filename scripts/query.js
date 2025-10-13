#!/usr/bin/env node

const Database = require('better-sqlite3');

const args = process.argv.slice(2);
let query = '';
let k = 10;
let pack = false;
let anchorPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--q' && i + 1 < args.length) {
    query = args[i + 1];
    i++;
  } else if (args[i] === '--k' && i + 1 < args.length) {
    k = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === '--pack') {
    pack = true;
  } else if (args[i] === '--path' && i + 1 < args.length) {
    anchorPath = args[i + 1];
    i++;
  }
}

if (!query) {
  console.error('Usage: elixir-context query --q "query" [--k 10] [--pack] [--path anchor.ex]');
  process.exit(1);
}

function resolveDb() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--db');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  if (process.env.ELIXIR_CONTEXT_DB) return process.env.ELIXIR_CONTEXT_DB;
  return '../.elixir_context/ec.sqlite';
}

const dbFile = resolveDb();
const db = new Database(dbFile);

// FTS query
const ftsQuery = db.prepare(`
  SELECT f.id, f.module, f.name, f.arity, f.path, f.start_line, f.end_line, f.signature, f.spec, f.doc, f.lexical_text, f.struct_text,
         bm25(functions_fts) as score
  FROM functions_fts
  JOIN functions f ON functions_fts.id = f.id
  WHERE functions_fts MATCH ?
  ORDER BY score
  LIMIT ?
`);

const results = ftsQuery.all(query, k);

if (pack) {
  // Pack mode: return token-efficient bundle
  let text = '';
  const sources = [];

  for (const row of results) {
    text += `### ${row.module}.${row.name}/${row.arity}\n`;
    text += `Path: ${row.path}:${row.start_line}\n`;
    if (row.spec) text += `Spec: ${row.spec}\n`;
    if (row.doc) text += `Doc: ${row.doc}\n`;
    text += `Definition: ${row.struct_text}\n\n`;

    sources.push({ path: row.path, start_line: row.start_line, end_line: row.end_line || row.start_line });

    // Add 1-hop neighbors
    const neighborsQuery = db.prepare(`
      SELECT f.module, f.name, f.arity, f.path, f.start_line, f.struct_text
      FROM edges e
      JOIN functions f ON (e.src_id = f.id OR e.dst_mfa = ?)
      WHERE e.src_id = ? OR e.dst_mfa = ?
      LIMIT 5
    `);
    const mfa = `${row.module}.${row.name}/${row.arity}`;
    const neighbors = neighborsQuery.all(mfa, row.id, mfa);
    for (const n of neighbors) {
      if (n.module !== row.module || n.name !== row.name || n.arity !== row.arity) {
        text += `Neighbor: ${n.module}.${n.name}/${n.arity} at ${n.path}:${n.start_line}\n`;
        text += `${n.struct_text}\n\n`;
        sources.push({ path: n.path, start_line: n.start_line, end_line: n.start_line });
      }
    }
  }

  console.log(JSON.stringify({ text, sources }));
} else {
  // JSON mode
  const output = results.map(row => ({
    id: row.id,
    module: row.module,
    name: row.name,
    arity: row.arity,
    path: row.path,
    start_line: row.start_line,
    end_line: row.end_line,
    score: row.score
  }));
  console.log(JSON.stringify(output, null, 2));
}

db.close();