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
    // The regression: stored dst_mfa is always "Mod.fun/arity", so a bare
    // "Mod.fun" with no slash silently matched NOTHING. This is the fix.
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

  it('leaves module/function wildcards (no slash) expanded via /%', () => {
    // Module-wildcard with no slash still gets /% appended; LIKE semantics
    // make this match any arity because % spans slashes.
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

// --- End-to-end integration test: export.exs -> ingest.js -> sqlite ---
// Verifies the two indexer-level fixes (self-edge removal + dot-call filter)
// against the real toolchain. Skipped automatically when elixir isn't on PATH
// so this doesn't break environments without Elixir installed.

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const REPO = require('path').resolve(__dirname, '..');

function elixirAvailable() {
  const r = spawnSync('which', ['elixir'], { stdio: 'ignore' });
  return r.status === 0;
}

const FIXTURE = `defmodule Bee.Repo do
  use GenServer

  # Multi-clause handle_call — the surface gc_daemon reportedly hits
  def handle_call(:conn, _from, state), do: {:reply, state.conn, state}
  def handle_call(:disconnect, _from, state), do: {:reply, :ok, state}
  def handle_call({:query, sql}, _from, state), do: {:reply, run(sql), state}

  # A function that IS called from elsewhere
  def enrich_issue(issue), do: {:ok, issue}

  # A function that calls enrich_issue
  def sync(issue), do: enrich_issue(issue)

  # A genuinely DEAD function (defined, never called anywhere)
  defp totally_dead(x), do: x

  def run(sql), do: sql
end
`;

const describeIntegration = elixirAvailable() ? describe : describe.skip;

describeIntegration('export -> ingest -> query (indexer fixes)', () => {
  let tmpDir, dbPath;

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'ec-fix-'));
    mkdirSync(join(tmpDir, 'lib'));
    writeFileSync(join(tmpDir, 'lib', 'repro.ex'), FIXTURE);
    dbPath = join(tmpDir, 'ec.sqlite');
  }

  function teardown() {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }

  function build() {
    const exportScript = join(REPO, 'scripts', 'export.exs');
    const ingestScript = join(REPO, 'scripts', 'ingest.js');
    const jsonl = join(tmpDir, 'export.jsonl');
    const e = spawnSync('elixir', [exportScript, '--file', join(tmpDir, 'lib', 'repro.ex'), '--quiet', '--out', jsonl], { encoding: 'utf8' });
    if (e.status !== 0) throw new Error('export failed: ' + e.stderr);
    expect(existsSync(jsonl)).toBe(true);
    const i = spawnSync('node', [ingestScript, jsonl, dbPath], { encoding: 'utf8' });
    if (i.status !== 0) throw new Error('ingest failed: ' + i.stderr);
  }

  function openDb() {
    const Database = require(join(REPO, 'node_modules', 'better-sqlite3'));
    return new Database(dbPath, { readonly: true });
  }

  function callersOf(db, rawTarget) {
    const t = normalizeCallersTarget(rawTarget);
    return db.prepare(
      `SELECT e.dst_mfa target, f.module m, f.name n, f.arity a
       FROM edges e JOIN functions f ON f.id = e.src_id
       WHERE e.dst_mfa LIKE ?`
    ).all(t).map(r => `${r.m}.${r.n}/${r.a}`);
  }

  it('self-edge fix: a genuinely dead function has ZERO callers', () => {
    setup();
    try {
      build();
      const db = openDb();
      // totally_dead/1 is defined but called from nowhere. Before the fix it
      // reported exactly one caller — itself — making it indistinguishable
      // from live code. Now it must report zero.
      const callers = callersOf(db, 'Bee.Repo.totally_dead/%');
      expect(callers).toEqual([]);
      db.close();
    } finally { teardown(); }
  });

  it('self-edge fix: live function reports only its REAL caller, not itself', () => {
    setup();
    try {
      build();
      const db = openDb();
      const callers = callersOf(db, 'Bee.Repo.enrich_issue/%');
      expect(callers).toEqual(['Bee.Repo.sync/1']);
      db.close();
    } finally { teardown(); }
  });

  it('dot-call fix: variable field access (state.conn) is not recorded as a call edge', () => {
    setup();
    try {
      build();
      const db = openDb();
      const bad = db.prepare(`SELECT count(*) as c FROM edges WHERE dst_mfa LIKE '%state.conn%'`).get().c;
      expect(bad).toBe(0);
      db.close();
    } finally { teardown(); }
  });

  it('bare-target fix: callers_of "Module.function" (no arity) returns real callers, not zero', () => {
    // Guards against the silent-zero regression end-to-end through the
    // exported data shape (dst_mfa is always "Mod.fun/arity").
    setup();
    try {
      build();
      const db = openDb();
      // Without normalization, the bare LIKE would match nothing.
      const bare = db.prepare(
        `SELECT count(*) as c FROM edges WHERE dst_mfa LIKE ?`
      ).get('Bee.Repo.enrich_issue').c;
      expect(bare).toBe(0); // raw LIKE still misses — proves why normalization is required
      const normalized = callersOf(db, 'Bee.Repo.enrich_issue');
      expect(normalized).toEqual(['Bee.Repo.sync/1']);
      db.close();
    } finally { teardown(); }
  });
});
