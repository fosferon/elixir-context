#!/usr/bin/env node

const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const readline = require('readline');
const { ripgrepSearch } = require('./ripgrep-search');

// Resolve DB path from CLI or env, fallback to repo-local default
function resolveDbPath() {
  const args = process.argv.slice(2);
  const dbFlagIndex = args.indexOf('--db');
  if (dbFlagIndex !== -1 && args[dbFlagIndex + 1]) return args[dbFlagIndex + 1];
  if (process.env.ELIXIR_CONTEXT_DB) return process.env.ELIXIR_CONTEXT_DB;
  return require('path').resolve(__dirname, '..', '../.elixir_context/ec.sqlite');
}

// Resolve project root path from CLI or env
function resolveProjectRoot() {
  const args = process.argv.slice(2);
  const rootFlagIndex = args.indexOf('--root');
  if (rootFlagIndex !== -1 && args[rootFlagIndex + 1]) return args[rootFlagIndex + 1];
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  return require('path').resolve(__dirname, '..', '..');
}

let dbFile = resolveDbPath();
let projectRoot = resolveProjectRoot();
let db;

function initDB() {
  db = new Database(dbFile);
}

function sendMessage(message) {
  console.log(JSON.stringify(message));
}

function handleInitialize(id) {
  sendMessage({
    jsonrpc: "2.0",
    id: id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "elixir-context",
        version: "0.1.0"
      }
    }
  });
}

function handleToolsList(id) {
  sendMessage({
    jsonrpc: "2.0",
    id: id,
    result: {
      tools: [
        {
          name: "elixir_context.search",
          description: "Search for Elixir functions using hybrid FTS + ripgrep search. FTS is tried first for speed, ripgrep fallback provides full-text coverage.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query (supports FTS syntax and plain text)" },
              k: { type: "number", default: 10, description: "Max results to return" },
              use_ripgrep: { type: "boolean", default: true, description: "Enable ripgrep fallback if FTS returns < 3 results" },
              anchor: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  line: { type: "number" }
                }
              }
            },
            required: ["query"]
          }
        },
        {
          name: "elixir_context.pack_context",
          description: "Pack context for Elixir functions",
          inputSchema: {
            type: "object",
            properties: {
              ids: { type: "array", items: { type: "string" } },
              query: { type: "string" },
              k: { type: "number", default: 10 },
              anchor: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  line: { type: "number" }
                }
              }
            }
          }
        },
        {
          name: "elixir_context.refresh",
          description: "Refresh the index",
          inputSchema: {
            type: "object",
            properties: {
              paths: { type: "array", items: { type: "string" } }
            }
          }
        },
        {
          name: "elixir_context.index_status",
          description: "Get index status",
          inputSchema: {
            type: "object",
            properties: {}
          }
        }
      ]
    }
  });
}

async function handleToolsCall(id, method, params) {
  try {
    let result;
    switch (method) {
      case "elixir_context.search":
        result = await handleSearch(params);
        break;
      case "elixir_context.pack_context":
        result = handlePackContext(params);
        break;
      case "elixir_context.refresh":
        result = handleRefresh(params);
        break;
      case "elixir_context.index_status":
        result = handleIndexStatus();
        break;
      default:
        throw new Error(`Unknown tool: ${method}`);
    }
    sendMessage({
      jsonrpc: "2.0",
      id: id,
      result: result
    });
  } catch (error) {
    sendMessage({
      jsonrpc: "2.0",
      id: id,
      error: {
        code: -32000,
        message: error.message
      }
    });
  }
}

async function handleSearch(params) {
  const query = params.query;
  const k = params.k || 10;
  const useRipgrep = params.use_ripgrep !== false; // Default true
  const minFtsResults = 3; // Threshold for triggering ripgrep fallback

  // Try FTS first (fast path)
  const ftsQuery = db.prepare(`
    SELECT f.id, f.module, f.name, f.arity, f.path, f.start_line, f.end_line,
           bm25(functions_fts) as score
    FROM functions_fts
    JOIN functions f ON functions_fts.id = f.id
    WHERE functions_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `);
  const ftsResults = ftsQuery.all(query, k);

  // If we got enough FTS results or ripgrep is disabled, return them
  if (ftsResults.length >= minFtsResults || !useRipgrep) {
    return ftsResults.map(r => ({ ...r, source: 'fts' }));
  }

  // Otherwise, try ripgrep fallback for better coverage
  try {
    const rgResults = await ripgrepSearch(query, projectRoot, k);

    // Convert ripgrep results to same format as FTS
    const rgFormatted = rgResults.map(rg => ({
      id: null,
      module: extractModuleFromPath(rg.path),
      name: extractFunctionFromLine(rg.line_text),
      arity: null,
      path: rg.path,
      start_line: rg.line_number,
      end_line: rg.line_number,
      score: rg.score,
      source: 'ripgrep',
      context: rg.line_text
    }));

    // Merge FTS and ripgrep results, dedupe by path+line
    const merged = [...ftsResults.map(r => ({ ...r, source: 'fts' })), ...rgFormatted];
    const deduped = dedupeResults(merged);

    return deduped.slice(0, k);
  } catch (err) {
    // If ripgrep fails, just return FTS results
    console.error('Ripgrep fallback failed:', err.message);
    return ftsResults.map(r => ({ ...r, source: 'fts' }));
  }
}

function extractModuleFromPath(filePath) {
  // Extract module name from file path like lib/mobus_web/live/company_live/index.ex -> MobusWeb.CompanyLive.Index
  const match = filePath.match(/lib\/([^\/]+)\/(.+)\.ex$/);
  if (!match) return 'Unknown';

  const parts = [match[1], ...match[2].split('/')];
  return parts.map(p => p.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')).join('.');
}

function extractFunctionFromLine(line) {
  // Try to extract function name from line like "  def mount(params, session, socket) do"
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

function handlePackContext(params) {
  let results;
  if (params.ids) {
    const placeholders = params.ids.map(() => '?').join(',');
    const query = db.prepare(`SELECT * FROM functions WHERE id IN (${placeholders})`);
    results = query.all(params.ids);
  } else if (params.query) {
    const ftsQuery = db.prepare(`
      SELECT f.* FROM functions_fts
      JOIN functions f ON functions_fts.id = f.id
      WHERE functions_fts MATCH ?
      ORDER BY bm25(functions_fts)
      LIMIT ?
    `);
    results = ftsQuery.all(params.query, params.k || 10);
  } else {
    results = [];
  }

  let text = '';
  const sources = [];
  for (const row of results) {
    text += `### ${row.module}.${row.name}/${row.arity}\n`;
    text += `Path: ${row.path}:${row.start_line}\n`;
    if (row.spec) text += `Spec: ${row.spec}\n`;
    if (row.doc) text += `Doc: ${row.doc}\n`;
    text += `Definition: ${row.struct_text}\n\n`;
    sources.push({ path: row.path, start_line: row.start_line, end_line: row.end_line || row.start_line });
  }
  return { text, sources };
}

function handleRefresh(params) {
  // Run export and ingest
  const exportProcess = spawn('bash', ['-lc', 'cd ../orchestrator && mix run priv/export.exs > ../.elixir_context/export.jsonl'], { stdio: 'inherit' });
  exportProcess.on('exit', (code) => {
    if (code === 0) {
      const ingestProcess = spawn('node', ['scripts/ingest.js', '../.elixir_context/export.jsonl', '../.elixir_context/ec.sqlite'], { stdio: 'inherit' });
      ingestProcess.on('exit', (ingestCode) => {
        // For simplicity, assume success
      });
    }
  });
  return { updated: 1 }; // Placeholder
}

function handleIndexStatus() {
  const functionsCount = db.prepare('SELECT count(*) as count FROM functions').get().count;
  const edgesCount = db.prepare('SELECT count(*) as count FROM edges').get().count;
  return {
    functions: functionsCount,
    edges: edgesCount,
    updated_at: new Date().toISOString()
  };
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

initDB();

rl.on('line', (line) => {
  try {
    const message = JSON.parse(line.trim());
    if (message.method === "initialize") {
      handleInitialize(message.id);
    } else if (message.method === "tools/list") {
      handleToolsList(message.id);
    } else if (message.method === "tools/call") {
      handleToolsCall(message.id, message.params.method, message.params.params);
    }
  } catch (error) {
    // Ignore invalid JSON
  }
});