/** Synthetic Granola registration integration: CLI -> source row -> performSync. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-granola-registration-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

describe('native Granola registration', () => {
  test('registers through CLI, persists pointers only, then performs fixture sync', async () => {
    const managed = join(root, 'managed');
    const originalFetch = globalThis.fetch;
    process.env.TEST_GRANOLA_TOKEN = 'synthetic-secret-must-not-persist';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-secret-must-not-persist');
      if (u.pathname === '/v1/notes') {
        return Response.json({ notes: [{ id: 'fixture-1' }], hasMore: false });
      }
      return Response.json({ id: 'fixture-1', title: 'Synthetic meeting', created_at: '2026-09-17T00:00:00Z', updated_at: '2026-09-17T01:00:00Z', transcript: [{ speaker: 'Synthetic Speaker', text: 'Synthetic transcript.' }] });
    }) as typeof fetch;
    try {
      await runSources(engine, ['add', 'granola-ceo', '--kind', 'granola', '--target', 'ceo', '--account', 'ceo', '--access', 'env', '--token-env', 'TEST_GRANOLA_TOKEN', '--dir', managed, '--api-base', 'https://fixture/v1']);
      const rows = await engine.executeRaw<{ local_path: string; config: unknown }>('SELECT local_path, config FROM sources WHERE id = $1', ['granola-ceo']);
      expect(rows[0]?.local_path).toBe(managed);
      const serialized = JSON.stringify(rows[0]?.config);
      expect(serialized).toContain('TEST_GRANOLA_TOKEN');
      expect(serialized).not.toContain('synthetic-secret-must-not-persist');
      const result = await performSync(engine, { sourceId: 'granola-ceo', noEmbed: true, noExtract: true });
      expect(result.added).toBe(1);
      expect(await engine.getPage('granola/meetings/fixture-1', { sourceId: 'granola-ceo' })).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TEST_GRANOLA_TOKEN;
    }
  });

  test('rejects a customer target before registration', async () => {
    const originalExit = process.exit;
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as never;
    try {
      await expect(runSources(engine, ['add', 'granola-customer', '--kind', 'granola', '--target', 'customer', '--account', 'customer', '--access', 'env', '--token-env', 'TEST_GRANOLA_TOKEN', '--dir', join(root, 'customer')])).rejects.toThrow('exit:2');
    } finally {
      process.exit = originalExit;
    }
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id = $1', ['granola-customer'])).toEqual([]);
  });

  test('rejects overlapping managed paths', async () => {
    const managed = join(root, 'overlap');
    await runSources(engine, ['add', 'granola-one', '--kind', 'granola', '--account', 'ceo', '--access', 'env', '--token-env', 'TEST_GRANOLA_TOKEN', '--dir', managed]);
    await expect(runSources(engine, ['add', 'granola-two', '--kind', 'granola', '--account', 'ceo', '--access', 'env', '--token-env', 'TEST_GRANOLA_TOKEN', '--dir', managed])).rejects.toThrow(/overlaps with existing source/);
  });
});
