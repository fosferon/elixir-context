import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const REPO = require('path').resolve(__dirname, '..');

function query(dbPath) {
  return spawnSync(process.execPath, [join(REPO, 'scripts', 'query.js'), '--db', dbPath, '--q', 'anything'], { encoding: 'utf8' });
}

function expectMissingIndex(result, dbPath) {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`no index found at ${dbPath}; run \`elixir-context build\` first`);
  expect(result.stderr).not.toMatch(/SqliteError|query\.js:\d+/);
}

describe('query CLI without a built index', () => {
  it('reports a missing database in one line without a stack trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ec-query-'));
    try {
      expectMissingIndex(query(join(dir, 'missing.sqlite')), join(dir, 'missing.sqlite'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an existing but schema-less database in one line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ec-query-'));
    try {
      const dbPath = join(dir, 'empty.sqlite');
      writeFileSync(dbPath, '');
      expectMissingIndex(query(dbPath), dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
