#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const Database = require('better-sqlite3');
const readline = require('readline');
const { ripgrepSearch } = require('./ripgrep-search');
const { logger } = require('./logger');
const {
  resolveDbPath,
  resolveProjectRoot,
  extractModuleFromPath,
  extractFunctionFromLine,
  dedupeResults
} = require('./utils');

let dbFile = resolveDbPath();
let projectRoot = resolveProjectRoot();
let db;

function initDB() {
  try {
    if (!fs.existsSync(dbFile)) {
      logger.warn('Database file does not exist; some tools may not work until index is built', { dbFile });
    }
    db = new Database(dbFile);
  } catch (err) {
    logger.error('Failed to open database', { dbFile, err: err.message });
    db = null;
  }
}

function sendMessage(message) {
  // IMPORTANT: Always write MCP protocol messages to stdout only
  process.stdout.write(JSON.stringify(message) + '\n');
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
        },
        {
          name: "elixir_context.health",
          description: "Health/status of the MCP server and index",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    }
  });
}

async function handleToolsCall(id, toolName, args) {
  try {
    let result;
    switch (toolName) {
      case "elixir_context.search":
        result = await handleSearch(args);
        break;
      case "elixir_context.pack_context":
        result = handlePackContext(args);
        break;
      case "elixir_context.refresh":
        result = handleRefresh(args);
        break;
      case "elixir_context.index_status":
        result = handleIndexStatus();
        break;
      case "elixir_context.health":
        result = handleHealth();
        break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
    sendMessage({
      jsonrpc: "2.0",
      id: id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      }
    });
  } catch (error) {
    logger.error('tools/call failed', { toolName, err: error.message });
    sendMessage({
      jsonrpc: "2.0",
      id: id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
        isError: true
      }
    });
  }
}

async function handleSearch(params) {
  if (!db) throw new Error('Database not initialized');
  const query = params.query;
  const k = params.k || 10;
  const useRipgrep = params.use_ripgrep !== false; // Default true
  const minFtsResults = 2; // Low threshold — ripgrep catches fresh code not yet indexed

  const ftsQuery = db.prepare(`
    SELECT f.id, f.module, f.name, f.arity, f.kind, f.path, f.start_line, f.end_line,
           f.signature, bm25(functions_fts) as score
    FROM functions_fts
    JOIN functions f ON functions_fts.id = f.id
    WHERE functions_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `);
  const ftsResults = ftsQuery.all(query, k);

  if (ftsResults.length >= minFtsResults || !useRipgrep) {
    return ftsResults.map(r => ({ ...r, source: 'fts' }));
  }

  try {
    const rgResults = await ripgrepSearch(query, projectRoot, k);

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

    const merged = [...ftsResults.map(r => ({ ...r, source: 'fts' })), ...rgFormatted];
    const deduped = dedupeResults(merged);

    return deduped.slice(0, k);
  } catch (err) {
    logger.warn('Ripgrep fallback failed', { err: err.message });
    return ftsResults.map(r => ({ ...r, source: 'fts' }));
  }
}


function handlePackContext(params) {
  if (!db) throw new Error('Database not initialized');
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
  const paths = params.paths || [];
  const isIncremental = paths.length > 0;
  const exporterPath = require('path').resolve(__dirname, 'export.exs');
  const ingestPath = require('path').resolve(__dirname, 'ingest.js');

  if (isIncremental) {
    // Incremental: export only specified files, ingest with --incremental
    logger.info('Starting incremental refresh', { files: paths.length });
    const exportArgs = ['run', '--no-compile', '--no-start', exporterPath, '--files', '--quiet', ...paths];
    const exportProcess = spawn('mix', exportArgs, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let jsonl = '';
    exportProcess.stdout.on('data', (d) => { jsonl += d.toString(); });
    exportProcess.stderr.on('data', (d) => { logger.warn('export stderr', { data: d.toString().slice(0, 200) }); });

    exportProcess.on('exit', (code) => {
      if (code !== 0) {
        logger.error('Incremental export failed', { code });
        return;
      }
      if (!jsonl.trim()) {
        logger.info('Incremental export returned no entries');
        return;
      }
      const ingestProcess = spawn('node', [ingestPath, '-', dbFile, '--incremental'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      ingestProcess.stdin.write(jsonl);
      ingestProcess.stdin.end();
      ingestProcess.stdout.on('data', (d) => { logger.info('ingest', { msg: d.toString().trim() }); });
      ingestProcess.stderr.on('data', (d) => { logger.warn('ingest stderr', { data: d.toString().slice(0, 200) }); });
      ingestProcess.on('exit', (ingestCode) => {
        if (ingestCode !== 0) {
          logger.error('Incremental ingest failed', { ingestCode });
        } else {
          logger.info('Incremental refresh completed');
          // Reopen DB to pick up changes
          try { if (db) db.close(); } catch(e) {}
          initDB();
        }
      });
    });
  } else {
    // Full rebuild: export everything, full ingest (drops and recreates tables)
    logger.info('Starting full refresh');
    const exportProcess = spawn('mix', ['run', '--no-compile', '--no-start', exporterPath, '--quiet'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let jsonl = '';
    exportProcess.stdout.on('data', (d) => { jsonl += d.toString(); });
    exportProcess.stderr.on('data', (d) => { logger.warn('export stderr', { data: d.toString().slice(0, 200) }); });

    exportProcess.on('exit', (code) => {
      if (code !== 0) {
        logger.error('Full export failed', { code });
        return;
      }
      const ingestProcess = spawn('node', [ingestPath, '-', dbFile], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      ingestProcess.stdin.write(jsonl);
      ingestProcess.stdin.end();
      ingestProcess.stdout.on('data', (d) => { logger.info('ingest', { msg: d.toString().trim() }); });
      ingestProcess.stderr.on('data', (d) => { logger.warn('ingest stderr', { data: d.toString().slice(0, 200) }); });
      ingestProcess.on('exit', (ingestCode) => {
        if (ingestCode !== 0) {
          logger.error('Full ingest failed', { ingestCode });
        } else {
          logger.info('Full refresh completed');
          try { if (db) db.close(); } catch(e) {}
          initDB();
        }
      });
    });
  }

  return { started: true, mode: isIncremental ? 'incremental' : 'full', files: paths.length };
}

function handleIndexStatus() {
  if (!db) {
    return { functions: 0, edges: 0, updated_at: null, db_connected: false, db_path: dbFile };
  }
  try {
    const functionsCount = db.prepare('SELECT count(*) as count FROM functions').get().count;
    const edgesCount = db.prepare('SELECT count(*) as count FROM edges').get().count;
    return {
      functions: functionsCount,
      edges: edgesCount,
      updated_at: new Date().toISOString(),
      db_connected: true,
      db_path: dbFile
    };
  } catch (err) {
    // Tables missing or DB not yet initialized
    return {
      functions: 0,
      edges: 0,
      updated_at: null,
      db_connected: true,
      db_path: dbFile,
      warning: 'index schema missing'
    };
  }
}

function handleHealth() {
  const status = handleIndexStatus();
  return {
    ok: !!status.db_connected,
    project_root: projectRoot,
    ...status
  };
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

initDB();

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse((line || '').trim());
  } catch (error) {
    // Log but do not write to stdout to avoid protocol corruption
    logger.warn('Received invalid JSON on stdin', { err: error.message });
    return;
  }

  try {
    // Notifications (no id) — acknowledge silently
    if (!message.id && message.method && message.method.startsWith('notifications/')) {
      return;
    }

    if (message.method === "initialize") {
      handleInitialize(message.id);
    } else if (message.method === "tools/list") {
      handleToolsList(message.id);
    } else if (message.method === "tools/call") {
      // MCP spec: params.name + params.arguments (not params.method + params.params)
      const toolName = message.params.name || message.params.method;
      const args = message.params.arguments || message.params.params || {};
      handleToolsCall(message.id, toolName, args);
    } else if (message.id) {
      // Unknown method with an id — respond with method not found
      sendMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  } catch (err) {
    logger.error('Failed to handle message', { err: err.message });
    if (message.id) {
      sendMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: err.message } });
    }
  }
});

function safeClose() {
  try {
    if (db) db.close();
  } catch (err) {
    // ignore
  }
}

process.on('SIGINT', () => { logger.info('SIGINT received, shutting down'); safeClose(); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down'); safeClose(); process.exit(0); });
process.on('uncaughtException', (err) => { logger.error('uncaughtException', { err: err.message }); safeClose(); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error('unhandledRejection', { err: String(reason) }); });
