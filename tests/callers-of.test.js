#!/usr/bin/env node

import { describe, it, expect } from 'vitest';

// --- Pure-function unit tests for normalizeCallersTarget ---
// Inline copy of the handler logic (mcp-stdio.js is not importable without side
// effects). Keep this in sync with scripts/mcp-stdio.js::normalizeCallersTarget.

function normalizeCallersTarget(raw) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (t === '') return t;
  if (t.includes('/')) return t;   // explicit arity or wildcard arity
  return t + '/%';                 // bare Module.function -> all arities
}

describe('normalizeCallersTarget', () => {
  it('expands a bare Module.function to match all arities', () => {
    expect(normalizeCallersTarget('Bee.Repo.enrich_issue')).toBe('Bee.Repo.enrich_issue/%');
    expect(normalizeCallersTarget('WorkflowEngine.advance_execution')).toBe('WorkflowEngine.advance_execution/%');
  });

  it('leaves an explicit arity intact', () => {
    expect(normalizeCallersTarget('Repo.insert/2')).toBe('Repo.insert/2');
    expect(normalizeCallersTarget('Bee.Repo.handle_call/3')).toBe('Bee.Repo.handle_call/3');
  });

  it('leaves a wildcard arity intact', () => {
    expect(normalizeCallersTarget('Repo.insert/%')).toBe('Repo.insert/%');
  });

  it('expands module/function wildcards (no slash) via /%', () => {
    expect(normalizeCallersTarget('WorkflowEngine.%')).toBe('WorkflowEngine.%/%');
    expect(normalizeCallersTarget('%.advance_execution')).toBe('%.advance_execution/%');
  });

  it('preserves wildcards that already carry a slash', () => {
    expect(normalizeCallersTarget('%.advance_execution/%')).toBe('%.advance_execution/%');
    expect(normalizeCallersTarget('Repo.%/2')).toBe('Repo.%/2');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCallersTarget('  Repo.insert/2  ')).toBe('Repo.insert/2');
    expect(normalizeCallersTarget('  Mod.fun  ')).toBe('Mod.fun/%');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(normalizeCallersTarget('')).toBe('');
    expect(normalizeCallersTarget('   ')).toBe('');
  });

  it('returns input unchanged for non-string types', () => {
    expect(normalizeCallersTarget(null)).toBe(null);
    expect(normalizeCallersTarget(undefined)).toBe(undefined);
    expect(normalizeCallersTarget(42)).toBe(42);
  });
});

// --- End-to-end integration: export.exs -> ingest.js -> sqlite ---
// Covers all three tiers. Skipped automatically when elixir isn't on PATH.

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const REPO = require('path').resolve(__dirname, '..');

function elixirAvailable() {
  return spawnSync('which', ['elixir'], { stdio: 'ignore' }).status === 0;
}

const FIXTURE = `defmodule Bee.Repo do
  use GenServer

  def handle_call(:conn, _from, state), do: {:reply, state.conn, state}
  def handle_call(:disconnect, _from, state), do: {:reply, :ok, state}
  def handle_call({:query, sql}, _from, state), do: {:reply, run(sql), state}

  def enrich_issue(issue), do: {:ok, issue}
  def sync(issue), do: enrich_issue(issue)
  defp totally_dead(x), do: x
  def run(sql), do: sql
end

defmodule GcDaemon do
  def route(:start), do: :ok
  def route({:advance, id}), do: {:ok, id}
  def route(other), do: {:error, other}

  def caller_a do
    route(:start)
    route({:advance, 42})
    route(:unknown)
  end

  def ping_conn, do: GenServer.call(Bee.Repo, :conn)
  def query(sql), do: GenServer.call(Bee.Repo, {:query, sql})
  def vague(msg), do: GenServer.call(Bee.Repo, msg)
end
`;

const describeIntegration = elixirAvailable() ? describe : describe.skip;

describeIntegration('export -> ingest -> query (all tiers)', () => {
  let tmpDir, dbPath;

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'ec-fix-'));
    mkdirSync(join(tmpDir, 'lib'));
    writeFileSync(join(tmpDir, 'lib', 'repro.ex'), FIXTURE);
    dbPath = join(tmpDir, 'ec.sqlite');
  }
  function teardown() { try { rmSync(tmpDir, { recursive: true }); } catch {} }

  function build() {
    const jsonl = join(tmpDir, 'export.jsonl');
    const e = spawnSync('elixir', [join(REPO, 'scripts', 'export.exs'), '--file', join(tmpDir, 'lib', 'repro.ex'), '--quiet', '--out', jsonl], { encoding: 'utf8' });
    if (e.status !== 0) throw new Error('export failed: ' + e.stderr);
    const i = spawnSync('node', [join(REPO, 'scripts', 'ingest.js'), jsonl, dbPath], { encoding: 'utf8' });
    if (i.status !== 0) throw new Error('ingest failed: ' + i.stderr);
  }
  function openDb() {
    const Database = require(join(REPO, 'node_modules', 'better-sqlite3'));
    return new Database(dbPath, { readonly: true });
  }
  function callersOf(db, rawTarget) {
    const t = normalizeCallersTarget(rawTarget);
    return db.prepare(`SELECT e.dst_mfa target, f.module m, f.name n, f.arity a
       FROM edges e JOIN functions f ON f.id = e.src_id WHERE e.dst_mfa LIKE ?`).all(t).map(r => `${r.m}.${r.n}/${r.a}`);
  }
  function attributedEdges(db, callerName, calleeMfa) {
    return db.prepare(`SELECT e.dst_clause clause, e.attribution attr, e.dispatch dispatch, e.call_line line
       FROM edges e JOIN functions f ON f.id = e.src_id
       WHERE f.name = ? AND e.dst_mfa = ? ORDER BY e.call_line`).all(callerName, calleeMfa);
  }

  // ---- Batch 1: stop lying ----

  it('self-edge fix: a genuinely dead function has ZERO callers', () => {
    setup(); try { build(); const db = openDb();
      expect(callersOf(db, 'Bee.Repo.totally_dead/%')).toEqual([]);
    db.close(); } finally { teardown(); }
  });

  it('self-edge fix: live function reports only its REAL caller, not itself', () => {
    setup(); try { build(); const db = openDb();
      expect(callersOf(db, 'Bee.Repo.enrich_issue/%')).toEqual(['Bee.Repo.sync/1']);
    db.close(); } finally { teardown(); }
  });

  it('dot-call fix: variable field access (state.conn) is not recorded as a call edge', () => {
    setup(); try { build(); const db = openDb();
      expect(db.prepare(`SELECT count(*) as c FROM edges WHERE dst_mfa LIKE '%state.conn%'`).get().c).toBe(0);
    db.close(); } finally { teardown(); }
  });

  it('bare-target fix: bare LIKE misses, normalization returns real callers', () => {
    setup(); try { build(); const db = openDb();
      expect(db.prepare(`SELECT count(*) as c FROM edges WHERE dst_mfa LIKE ?`).get('Bee.Repo.enrich_issue').c).toBe(0);
      expect(callersOf(db, 'Bee.Repo.enrich_issue')).toEqual(['Bee.Repo.sync/1']);
    db.close(); } finally { teardown(); }
  });

  // ---- Tier 1: clause enumeration ----

  it('clause enumeration: multi-clause function emits one clause row per clause', () => {
    setup(); try { build(); const db = openDb();
      const clauses = db.prepare(`SELECT c.signature s FROM clauses c JOIN functions f ON f.id = c.function_id
        WHERE f.name = ? ORDER BY c.ordinal`).all('handle_call').map(c => c.s);
      expect(clauses).toEqual([
        'handle_call(:conn, _from, state)',
        'handle_call(:disconnect, _from, state)',
        'handle_call({:query, sql}, _from, state)'
      ]);
    db.close(); } finally { teardown(); }
  });

  it('clause enumeration: single-clause function still records its one clause', () => {
    setup(); try { build(); const db = openDb();
      expect(db.prepare(`SELECT count(*) as c FROM clauses c JOIN functions f ON f.id = c.function_id WHERE f.name = ?`).get('enrich_issue').c).toBe(1);
    db.close(); } finally { teardown(); }
  });

  // ---- Tier 2: direct call-site clause attribution ----

  it('Tier 2: direct literal call attributes to the matching clause (first-match-wins)', () => {
    setup(); try { build(); const db = openDb();
      // Three call sites into route/1, each resolving to a distinct clause
      // despite the trailing var catch-all clause.
      const edges = attributedEdges(db, 'caller_a', 'GcDaemon.route/1');
      expect(edges.map(e => e.clause).sort((a, b) => a - b)).toEqual([1, 2, 3]);
      expect(edges.every(e => e.attr === 'direct')).toBe(true);
      expect(edges.every(e => e.dispatch === null)).toBe(true);
    db.close(); } finally { teardown(); }
  });

  // ---- Tier 3: OTP dispatch attribution ----

  it('Tier 3: GenServer.call attributes to the specific handle_call clause', () => {
    setup(); try { build(); const db = openDb();
      const conn = attributedEdges(db, 'ping_conn', 'Bee.Repo.handle_call/3');
      expect(conn).toHaveLength(1);
      expect(conn[0].clause).toBe(1);
      expect(conn[0].attr).toBe('dispatch');
      expect(conn[0].dispatch).toBe('GenServer.call');

      const q = attributedEdges(db, 'query', 'Bee.Repo.handle_call/3');
      expect(q).toHaveLength(1);
      expect(q[0].clause).toBe(3);
      expect(q[0].attr).toBe('dispatch');

      const v = attributedEdges(db, 'vague', 'Bee.Repo.handle_call/3');
      expect(v).toHaveLength(1);
      expect(v[0].attr).toBe('ambiguous'); // variable message -> can't tell
    db.close(); } finally { teardown(); }
  });

  it('Tier 3: dispatch edges all carry the dispatch label (no arity-level noise for handle_call)', () => {
    setup(); try { build(); const db = openDb();
      const noise = db.prepare(`SELECT count(*) as c FROM edges WHERE dst_mfa LIKE '%.handle_call/%' AND attribution IS NULL`).get().c;
      expect(noise).toBe(0);
    db.close(); } finally { teardown(); }
  });

  // ---- Backward compatibility ----

  it('legacy shape: exporter string calls still ingest as arity-level edges', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ec-legacy-'));
    try {
      const def = {
        id: 'legacy1', module: 'X', name: 'a', arity: 0, kind: 'function',
        path: 'lib/x.ex', start_line: 1, end_line: 1, signature: 'a()',
        spec: null, doc: null, lexical_text: 'X.a', struct_text: 'def a, do: b()',
        calls: ['X.b/0']
      };
      const jsonl = join(tmp, 'legacy.jsonl');
      writeFileSync(jsonl, JSON.stringify(def) + '\n');
      const dbPath = join(tmp, 'legacy.sqlite');
      const i = spawnSync('node', [join(REPO, 'scripts', 'ingest.js'), jsonl, dbPath], { encoding: 'utf8' });
      expect(i.status).toBe(0);
      const Database = require(join(REPO, 'node_modules', 'better-sqlite3'));
      const db = new Database(dbPath, { readonly: true });
      const edge = db.prepare('SELECT dst_mfa, dst_clause, attribution, dispatch, call_line FROM edges').get();
      expect(edge.dst_mfa).toBe('X.b/0');
      expect(edge.dst_clause).toBeNull();
      expect(edge.attribution).toBeNull();
      db.close();
    } finally { rmSync(tmp, { recursive: true }); }
  });
});
