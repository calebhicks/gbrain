/** Synthetic-only native Granola adapter tests. No provider, credentials, or live corpus. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { granolaMeetingSlug, renderGranolaNote } from '../src/core/granola/granola-render.ts';
import { parseGranolaSourceConfig, readGranolaState, runGranolaSync, type GranolaSourceConfig } from '../src/core/granola/granola-source.ts';

let engine: PGLiteEngine;
let version: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = (await engine.getConfig('version')) ?? '7'; });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', version); });
function dir(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }
function note(id: string, title: string, text = 'A synthetic transcript line.'): Record<string, unknown> {
  return { id, title, created_at: '2026-09-17T00:00:00Z', updated_at: '2026-09-17T01:00:00Z', attendees: [{ name: 'Alice Example' }], transcript: [{ speaker: 'Alice Example', text }] };
}
async function addSource(id: string, managed: string, mirror: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`, [id, id, managed, JSON.stringify({ kind: 'granola', gr_mirror_dir: mirror, gr_dir: managed })]);
}
const opts = (sourceId: string) => ({ sourceId, noEmbed: true, noExtract: true });

describe('native Granola renderer', () => {
  test('uses provider ID for a stable, title-independent page identity', () => {
    expect(granolaMeetingSlug('meeting:ABC-7')).toBe('granola/meetings/meeting:abc-7');
    const page = renderGranolaNote(note('meeting:ABC-7', 'Renamed title') as any);
    expect(page?.slug).toBe('granola/meetings/meeting:abc-7');
    expect(page?.markdown).toContain('granola_id: "meeting:ABC-7"');
  });
});

describe('native Granola source sync', () => {
  test('uses a generic operator account when no personal account is configured', () => {
    expect(parseGranolaSourceConfig({ kind: 'granola' }, '/tmp/granola')).toMatchObject({ account: 'operator' });
  });

  test('discovers a late-shared note during a full census and is a no-op afterward', async () => {
    const mirror = dir('granola-mirror-'); const managed = dir('granola-managed-');
    try {
      writeFileSync(join(mirror, 'notes.jsonl'), JSON.stringify(note('late-1', 'Late share')) + '\n');
      await addSource('granola-src', managed, mirror);
      const first = await runGranolaSync(engine, 'granola-src', { mirrorDir: mirror, dir: managed, batchSize: 2 }, opts('granola-src'));
      expect(first.status).toBe('first_sync'); expect(first.added).toBe(1);
      const second = await runGranolaSync(engine, 'granola-src', { mirrorDir: mirror, dir: managed, batchSize: 2 }, opts('granola-src'));
      expect(second.status).toBe('up_to_date'); expect(second.added + second.modified + second.deleted).toBe(0);
      writeFileSync(join(mirror, 'notes.jsonl'), [note('late-1', 'Renamed after share'), note('late-2', 'Shared later')].map((value) => JSON.stringify(value)).join('\n') + '\n');
      const late = await runGranolaSync(engine, 'granola-src', { mirrorDir: mirror, dir: managed, batchSize: 2 }, opts('granola-src'));
      expect(late.added).toBe(1); expect(readFileSync(join(managed, 'granola/meetings/late-1.md'), 'utf8')).toContain('Renamed after share');
      expect(readGranolaState(managed).access_ledger['late-2']?.first_access_seen_at).toBeTruthy();
    } finally { rmSync(mirror, { recursive: true, force: true }); rmSync(managed, { recursive: true, force: true }); }
  });

  test('runs the native provider fixture through PGLite: edit, no-op, late share, revoke and partial census', async () => {
    const managed = dir('granola-api-managed-'); const original = process.env.GRANOLA_FIXTURE_TOKEN;
    const records: Record<string, any> = { 'api-1': note('api-1', 'Original') };
    const requests: string[] = [];
    process.env.GRANOLA_FIXTURE_TOKEN = 'fixture-token';
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fixture-token');
      const path = new URL(url).pathname;
      requests.push(new URL(url).pathname + new URL(url).search);
      if (path === '/v1/notes') return Response.json({ notes: Object.values(records).map(({ id, title, created_at, updated_at }) => ({ id, title, created_at, updated_at })), hasMore: false });
      const id = decodeURIComponent(path.split('/').pop()!);
      return Response.json(records[id]);
    };
    try {
      await addSource('granola-api', managed, '');
      const cfg: GranolaSourceConfig = { mirrorDir: '', dir: managed, batchSize: 2, access: 'env', tokenEnv: 'GRANOLA_FIXTURE_TOKEN', apiBase: 'https://fixture/v1', target: 'ceo' };
      const first = await runGranolaSync(engine, 'granola-api', cfg, opts('granola-api'), fetchImpl);
      expect(first.status).toBe('first_sync'); expect(first.added).toBe(1);
      expect(requests.slice(0, 2)).toEqual(['/v1/notes?page_size=30', '/v1/notes/api-1?include=transcript']);
      const noop = await runGranolaSync(engine, 'granola-api', cfg, opts('granola-api'), fetchImpl);
      expect(noop.status).toBe('up_to_date');
      records['api-1'] = { ...records['api-1'], title: 'Edited' }; records['api-2'] = note('api-2', 'Late shared');
      const edited = await runGranolaSync(engine, 'granola-api', cfg, opts('granola-api'), fetchImpl);
      expect(edited.modified).toBe(1); expect(edited.added).toBe(1);
      records['api-1'] = { ...records['api-1'], access_revoked: true }; delete records['api-2'];
      const revoked = await runGranolaSync(engine, 'granola-api', cfg, opts('granola-api'), fetchImpl);
      expect(revoked.deleted).toBe(2);
      const abort = new AbortController(); abort.abort(); records['api-3'] = note('api-3', 'Partial');
      const partial = await runGranolaSync(engine, 'granola-api', cfg, { ...opts('granola-api'), signal: abort.signal }, fetchImpl);
      expect(partial.status).toBe('partial'); expect(readGranolaState(managed).last_complete_reconcile_at).toBeNull();
    } finally { if (original === undefined) delete process.env.GRANOLA_FIXTURE_TOKEN; else process.env.GRANOLA_FIXTURE_TOKEN = original; rmSync(managed, { recursive: true, force: true }); }
  });

  test('matches deployed transcript fallback request shapes after TRANSCRIPT_TOO_LARGE', async () => {
    const managed = dir('granola-api-transcript-'); const original = process.env.GRANOLA_FIXTURE_TOKEN;
    process.env.GRANOLA_FIXTURE_TOKEN = 'fixture-token'; const requests: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fixture-token');
      const u = new URL(url); requests.push(u.pathname + u.search);
      if (u.pathname === '/v1/notes') return Response.json({ notes: [{ id: 'large-1' }], hasMore: false });
      if (u.pathname === '/v1/notes/large-1' && u.search === '?include=transcript') return new Response(JSON.stringify({ code: 'TRANSCRIPT_TOO_LARGE' }), { status: 413, headers: { 'content-type': 'application/json' } });
      if (u.pathname === '/v1/notes/large-1') return Response.json({ ...note('large-1', 'Large transcript'), transcript: undefined });
      if (u.pathname === '/v1/notes/large-1/transcript') return Response.json({ transcript: [{ speaker: 'Alice Example', text: 'paged transcript' }], hasMore: false });
      throw new Error(`unexpected fixture request ${url}`);
    };
    try {
      const cfg: GranolaSourceConfig = { mirrorDir: '', dir: managed, batchSize: 2, access: 'env', tokenEnv: 'GRANOLA_FIXTURE_TOKEN', apiBase: 'https://fixture/v1', target: 'ceo' };
      await addSource('granola-api-transcript', managed, '');
      const result = await runGranolaSync(engine, 'granola-api-transcript', cfg, opts('granola-api-transcript'), fetchImpl);
      expect(result.added).toBe(1);
      expect(requests).toEqual(['/v1/notes?page_size=30', '/v1/notes/large-1?include=transcript', '/v1/notes/large-1', '/v1/notes/large-1/transcript?page_size=100']);
    } finally { if (original === undefined) delete process.env.GRANOLA_FIXTURE_TOKEN; else process.env.GRANOLA_FIXTURE_TOKEN = original; rmSync(managed, { recursive: true, force: true }); }
  });

  test('persists imported pages but leaves freshness incomplete when a later detail fetch fails', async () => {
    const managed = dir('granola-api-partial-'); const original = process.env.GRANOLA_FIXTURE_TOKEN;
    process.env.GRANOLA_FIXTURE_TOKEN = 'fixture-token';
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fixture-token');
      const u = new URL(url);
      if (u.pathname === '/v1/notes') return Response.json({ notes: [{ id: 'ok-1' }, { id: 'broken-2' }], hasMore: false });
      if (u.pathname.endsWith('/ok-1')) return Response.json(note('ok-1', 'Imported before failure'));
      return new Response(JSON.stringify({ code: 'TEMPORARY_FAILURE' }), { status: 503, headers: { 'content-type': 'application/json' } });
    };
    try {
      const cfg: GranolaSourceConfig = { mirrorDir: '', dir: managed, batchSize: 2, access: 'env', tokenEnv: 'GRANOLA_FIXTURE_TOKEN', apiBase: 'https://fixture/v1', target: 'ceo' };
      await addSource('granola-api-partial', managed, '');
      const partial = await runGranolaSync(engine, 'granola-api-partial', cfg, opts('granola-api-partial'), fetchImpl);
      expect(partial.status).toBe('partial');
      const state = readGranolaState(managed);
      expect(state.access_ledger['ok-1']?.disposition).toBe('imported');
      expect(state.last_complete_reconcile_at).toBeNull();
    } finally { if (original === undefined) delete process.env.GRANOLA_FIXTURE_TOKEN; else process.env.GRANOLA_FIXTURE_TOKEN = original; rmSync(managed, { recursive: true, force: true }); }
  });

  test('revokes provider access and removes only the Granola source page', async () => {
    const mirror = dir('granola-revoke-mirror-'); const managed = dir('granola-revoke-managed-');
    try {
      writeFileSync(join(mirror, 'notes.jsonl'), JSON.stringify(note('revoke-1', 'Revocable')) + '\n');
      await addSource('granola-revoke', managed, mirror);
      await runGranolaSync(engine, 'granola-revoke', { mirrorDir: mirror, dir: managed, batchSize: 2 }, opts('granola-revoke'));
      writeFileSync(join(mirror, 'notes.jsonl'), JSON.stringify({ ...note('revoke-1', 'Revocable'), access_revoked: true }) + '\n');
      const revoked = await runGranolaSync(engine, 'granola-revoke', { mirrorDir: mirror, dir: managed, batchSize: 2 }, opts('granola-revoke'));
      expect(revoked.deleted).toBe(1); expect(await engine.getPage('granola/meetings/revoke-1', { sourceId: 'granola-revoke' })).toBeNull();
      expect(readGranolaState(managed).access_ledger['revoke-1']?.disposition).toBe('revoked');
    } finally { rmSync(mirror, { recursive: true, force: true }); rmSync(managed, { recursive: true, force: true }); }
  });
});
