#!/usr/bin/env node

const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const readline = require('readline');

const dbFile = '../.elixir_context/ec.sqlite';
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
          description: "Search for Elixir functions using full-text search",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              k: { type: "number", default: 10 },
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

function handleToolsCall(id, method, params) {
  try {
    let result;
    switch (method) {
      case "elixir_context.search":
        result = handleSearch(params);
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

function handleSearch(params) {
  const query = params.query;
  const k = params.k || 10;
  const ftsQuery = db.prepare(`
    SELECT f.id, f.module, f.name, f.arity, f.path, f.start_line, f.end_line,
           bm25(functions_fts) as score
    FROM functions_fts
    JOIN functions f ON functions_fts.id = f.id
    WHERE functions_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `);
  return ftsQuery.all(query, k);
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