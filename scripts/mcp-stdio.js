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
          name: "elixir_context_search",
          description: "Find Elixir functions by name, module, doc, or keywords. Returns module, function name, arity, kind, path, line, signature, and score. Use this as your first lookup — then use callers_of/calls_from to trace call chains, or pack_context to get full definitions. Query is auto-sanitized: dots, slashes, parens are fine (e.g. 'WorkflowEngine.advance_execution').",
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
          name: "elixir_context_pack_context",
          description: "Get full function definitions with doc, spec, and source code for a set of functions. Pass query: (same as search) or ids: (array of sha256 IDs from prior search results). Returns the actual code definitions ready to read — use this when you need to understand WHAT a function does, not just that it exists.",
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
          name: "elixir_context_callers_of",
          description: "Find all functions that call a given Module.function/arity. Queries the call-edge index for reverse lookups (who references this symbol). Target forms accepted: bare 'Module.function' (matches ALL arities), 'Module.function/2' (exact arity), or any wildcard form like 'WorkflowEngine.%', '%.advance_execution%', 'Repo.insert/%'. Bare form is auto-expanded to match every arity.",
          inputSchema: {
            type: "object",
            properties: {
              target: { type: "string", description: "Target function in Module.function/arity format. Use % as wildcard. Examples: 'WorkflowEngine.advance_execution/2', 'Repo.insert/%', '%.delete_workflow%'" },
              k: { type: "number", default: 30, description: "Max results" }
            },
            required: ["target"]
          }
        },
        {
          name: "elixir_context_calls_from",
          description: "Find all functions called BY a given function. Queries the call-edge index for forward lookups (what does this symbol invoke). Accepts: id (sha256), module+name as separate fields, or target as 'Module.function' dotted string.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Function ID from a prior search result" },
              target: { type: "string", description: "Dotted function reference: 'Module.function' or 'Module.function/arity'" },
              module: { type: "string", description: "Module name (alternative to target)" },
              name: { type: "string", description: "Function name (alternative to target)" },
              k: { type: "number", default: 50, description: "Max results" }
            }
          }
        },
        {
          name: "elixir_context_refresh",
          description: "Refresh the index",
          inputSchema: {
            type: "object",
            properties: {
              paths: { type: "array", items: { type: "string" } }
            }
          }
        },
        {
          name: "elixir_context_index_status",
          description: "Get index status",
          inputSchema: {
            type: "object",
            properties: {}
          }
        },
        {
          name: "elixir_context_health",
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
      case "elixir_context_search":
        result = await handleSearch(args);
        break;
      case "elixir_context_pack_context":
        result = handlePackContext(args);
        break;
      case "elixir_context_callers_of":
        result = handleCallersOf(args);
        break;
      case "elixir_context_calls_from":
        result = handleCallsFrom(args);
        break;
      case "elixir_context_refresh":
        result = handleRefresh(args);
        break;
      case "elixir_context_index_status":
        result = handleIndexStatus();
        break;
      case "elixir_context_health":
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

// Resolve the query string from tool arguments, checking canonical field and common aliases.
function resolveQuery(params) {
  return params.query || params.q || null;
}

// Sanitize a query string for FTS5 MATCH — strips special chars that cause syntax errors
// (dots, parens, slashes, colons, quotes, etc.) and returns space-separated tokens.
// Returns '' for non-string / empty input (never throws).
function sanitizeFtsQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[.(){}\[\]\/:"'@#!$%^&*+=|;<>?\\,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function handleSearch(params) {
  if (!db) throw new Error('Database not initialized');
  const query = resolveQuery(params);
  if (!query || typeof query !== 'string') {
    return { error: 'missing_query', message: 'A non-empty string "query" parameter is required.' };
  }
  const k = params.k || 10;
  const useRipgrep = params.use_ripgrep !== false; // Default true
  const minFtsResults = 2; // Low threshold — ripgrep catches fresh code not yet indexed

  const ftsSafeQuery = sanitizeFtsQuery(query);

  const ftsQuery = db.prepare(`
    SELECT f.id, f.module, f.name, f.arity, f.kind, f.path, f.start_line, f.end_line,
           f.signature, bm25(functions_fts) as score
    FROM functions_fts
    JOIN functions f ON functions_fts.id = f.id
    WHERE functions_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `);
  let ftsResults;
  try {
    ftsResults = ftsSafeQuery ? ftsQuery.all(ftsSafeQuery, k) : [];
  } catch (e) {
    // FTS5 can still choke on edge cases — fall through to ripgrep
    logger.warn('FTS5 query failed, falling back to ripgrep', { query: ftsSafeQuery, err: e.message });
    ftsResults = [];
  }

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
  if (params.ids && params.ids.length > 0) {
    const placeholders = params.ids.map(() => '?').join(',');
    const query = db.prepare(`SELECT * FROM functions WHERE id IN (${placeholders})`);
    results = query.all(params.ids);
  } else if (params.query) {
    const ftsSafeQuery = sanitizeFtsQuery(params.query);
    const ftsQuery = db.prepare(`
      SELECT f.* FROM functions_fts
      JOIN functions f ON functions_fts.id = f.id
      WHERE functions_fts MATCH ?
      ORDER BY bm25(functions_fts)
      LIMIT ?
    `);
    results = ftsSafeQuery ? ftsQuery.all(ftsSafeQuery, params.k || 10) : [];
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

// Normalize a callers_of target so a bare "Module.function" matches all arities.
// Stored dst_mfa is ALWAYS "Module.function/arity", so a bare target with no "/"
// would silently match nothing (the "dead code confirmed" trap). If the caller
// already supplied an arity or any wildcard, leave the target intact.
function normalizeCallersTarget(raw) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (t === '') return t;
  if (t.includes('/')) return t;   // explicit arity ("/2") or wildcard arity ("/%")
  return t + '/%';                 // bare Module.function -> all arities
}

function handleCallersOf(params) {
  if (!db) throw new Error('Database not initialized');
  const rawTarget = params.target;
  if (!rawTarget || typeof rawTarget !== 'string') {
    return { error: 'missing_target', message: 'A non-empty string "target" parameter is required.' };
  }
  const target = normalizeCallersTarget(rawTarget);
  const k = params.k || 30;

  // Query edges where dst_mfa matches (supports SQL LIKE wildcards)
  const q = db.prepare(`
    SELECT e.dst_mfa as target, f.id, f.module, f.name, f.arity, f.kind, f.path, f.start_line, f.signature
    FROM edges e
    JOIN functions f ON f.id = e.src_id
    WHERE e.dst_mfa LIKE ?
    ORDER BY f.module, f.name
    LIMIT ?
  `);
  const rows = q.all(target, k);

  // Group by target for readability
  const grouped = {};
  for (const r of rows) {
    const key = r.target;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({
      module: r.module, name: r.name, arity: r.arity, kind: r.kind,
      path: r.path, line: r.start_line, signature: r.signature
    });
  }

  return {
    query: rawTarget,
    resolved_pattern: target,
    total_matches: rows.length,
    targets: Object.entries(grouped).map(([target, callers]) => ({ target, callers }))
  };
}

function handleCallsFrom(params) {
  if (!db) throw new Error('Database not initialized');
  const k = params.k || 50;

  // Resolve function ID from id, module+name, or dotted "Module.function" string
  let funcId = params.id || null;
  if (!funcId && params.module && params.name) {
    const lookup = db.prepare(`
      SELECT id FROM functions WHERE module = ? AND name = ? LIMIT 1
    `);
    const row = lookup.get(params.module, params.name);
    funcId = row ? row.id : null;
  }
  if (!funcId && params.target) {
    // Parse "Module.function" or "Module.function/arity" dotted string
    const match = params.target.match(/^(.+)\.([^.\/]+)(?:\/(\d+))?$/);
    if (match) {
      const lookup = db.prepare(`
        SELECT id FROM functions WHERE module = ? AND name = ? ${match[3] ? 'AND arity = ?' : ''} LIMIT 1
      `);
      const row = match[3]
        ? lookup.get(match[1], match[2], parseInt(match[3]))
        : lookup.get(match[1], match[2]);
      funcId = row ? row.id : null;
    }
  }

  if (!funcId) {
    return { error: 'Function not found. Provide id, or module+name.', params };
  }

  // Get the function itself
  const funcRow = db.prepare('SELECT * FROM functions WHERE id = ?').get(funcId);

  // Get all outgoing edges
  const q = db.prepare(`
    SELECT e.dst_mfa as callee
    FROM edges e
    WHERE e.src_id = ?
    ORDER BY e.dst_mfa
    LIMIT ?
  `);
  const callees = q.all(funcId, k).map(r => r.callee);

  return {
    function: {
      module: funcRow.module, name: funcRow.name, arity: funcRow.arity,
      kind: funcRow.kind, path: funcRow.path, line: funcRow.start_line,
      signature: funcRow.signature
    },
    calls: callees,
    total: callees.length
  };
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
