import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CadenceSnapshotSource, canonicalJson, createCadenceProvider, findCadencePage, parseCadenceSourceConfig, runCadenceSync, cadenceStateFile } from '../../../src/core/ingestion/sources/cadence.ts';
import { IngestionTestHarness } from '../../../src/core/ingestion/test-harness.ts';

const snapshot = {
  exported_at: '2026-09-17T12:00:00.000Z',
  workspace: { id: 'workspace-1', name: 'Synthetic Workspace' },
  groups: [
    { id: 'group-2', title: 'Beta', captain_id: null, captain_name: null },
    { id: 'group-1', title: 'Alpha', captain_id: 'person-1', captain_name: 'Example Captain' },
  ],
  priorities: [{ id: 'rock-1', title: 'Synthetic Rock', status: 'on_track', state: 'active' }],
  aor_updates: [{ id: 'update-1', group: 'Alpha', progress: 'Reported progress' }],
};

const run = async (source: CadenceSnapshotSource) => {
  const harness = new IngestionTestHarness();
  await harness.run(source);
  return { harness, events: [...harness.events] };
};

describe('CadenceSnapshotSource', () => {
  test('emits a deterministic complete snapshot with stable record identities', async () => {
    const { harness, events } = await run(new CadenceSnapshotSource({
      snapshot: JSON.stringify(snapshot),
      sourceId: 'cadence:synthetic',
    }));

    expect(harness.validationErrors).toEqual([]);
    expect(events.map((event) => event.source_uri)).toEqual([
      'cadence://aor_updates/update-1',
      'cadence://groups/group-1',
      'cadence://groups/group-2',
      'cadence://priorities/rock-1',
      'cadence://workspace/workspace-1',
    ]);
    expect(events.every((event) => event.content_type === 'application/json')).toBe(true);
    expect(new Set(events.map((event) => event.content_hash)).size).toBe(events.length);
    expect(JSON.parse(events[0]!.content)).toEqual(snapshot.aor_updates[0]);
    expect(events[0]!.metadata).toMatchObject({ family: 'aor_updates', record_id: 'update-1', snapshot_at: snapshot.exported_at });
    expect(await harness.healthCheck()).toEqual({ status: 'ok', message: 'snapshot emitted: 5 records' });
    await harness.stop();
  });

  test('normalizes provider people-shaped groups without inventing fields', async () => {
    const providerSnapshot = {
      exported_at: snapshot.exported_at,
      groups: [{ person_id: 'person-1', full_name: 'Example Captain', captaincies: [{ group_id: 'group-1', group_title: 'Alpha' }] }],
      aor_updates: [], priorities: [],
    };
    const { events } = await run(new CadenceSnapshotSource({ snapshot: JSON.stringify(providerSnapshot) }));
    const group = events.find((event) => event.source_uri === 'cadence://groups/group-1');
    expect(group).toBeDefined();
    expect(JSON.parse(group!.content)).toEqual({ id: 'group-1', title: 'Alpha', captain_id: 'person-1', captain_name: 'Example Captain' });
  });

  test('does not emit personnel-grade families from a full provider snapshot', async () => {
    const full = { ...snapshot, checkins: [{ id: 'checkin-1' }], pulse_reflections: [{ id: 'reflection-1' }], people: [{ id: 'person-1' }] };
    const { events } = await run(new CadenceSnapshotSource({ snapshot: JSON.stringify(full) }));
    expect(events.some((event) => ['checkins', 'pulse_reflections', 'people'].includes(String(event.metadata?.family)))).toBe(false);
  });

  test('is a no-op when the same complete snapshot is started again', async () => {
    const source = new CadenceSnapshotSource({ snapshot: JSON.stringify(snapshot) });
    const first = await run(source);
    await first.harness.stop();
    const second = await run(source);
    expect(second.events).toEqual([]);
    expect(second.harness.logs.some((log) => log.msg.includes('no-op'))).toBe(true);
    await second.harness.stop();
  });

  test('fails closed before emitting anything when one record is malformed', async () => {
    const bad = { ...snapshot, priorities: [{ title: 'missing stable id' }] };
    const source = new CadenceSnapshotSource({ snapshot: JSON.stringify(bad) });
    const harness = new IngestionTestHarness();
    await expect(harness.run(source)).rejects.toThrow(/priorities\[0\].*id/);
    expect(harness.events).toHaveLength(0);
    expect(await source.healthCheck()).toEqual({ status: 'fail', message: 'snapshot failed: no records emitted' });
  });
});

describe('canonicalJson', () => {
  test('sorts object keys recursively for stable hashes', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('routes organization and explicitly CEO-targeted personnel sources', () => {
    expect(parseCadenceSourceConfig({ kind: 'cadence', c_target: 'organization' }, '/tmp/org').target).toBe('organization');
    expect(parseCadenceSourceConfig({ kind: 'cadence', c_target: 'personnel', c_personnel_target: 'ceo' }, '/tmp/people')).toMatchObject({ target: 'personnel', personnelTarget: 'ceo' });
    expect(() => parseCadenceSourceConfig({ kind: 'cadence', c_target: 'personnel', c_personnel_target: 'other' }, '/tmp/no')).toThrow(/CEO/);
  });

  test('provider failure does not advance or create a cursor', async () => {
    const dir = mkdtempSync(`${tmpdir()}/cadence-failure-`);
    try {
      const cfg = parseCadenceSourceConfig({ kind: 'cadence', c_target: 'organization', c_dir: dir }, dir);
      const provider = { read: async () => { throw new Error('synthetic provider outage'); } };
      await expect(runCadenceSync({} as never, 'cadence-test', cfg, { noEmbed: true }, { provider })).rejects.toThrow('synthetic provider outage');
      expect(existsSync(cadenceStateFile(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects inline tokens and only carries a runtime environment pointer', () => {
    expect(() => parseCadenceSourceConfig({ kind: 'cadence', c_token: 'synthetic-not-a-token' }, '/tmp/cadence')).toThrow(/inline secret config/);
    const cfg = parseCadenceSourceConfig({ kind: 'cadence', c_token_env: 'GBRAIN_TEST_CADENCE_TOKEN' }, '/tmp/cadence');
    expect(cfg).not.toHaveProperty('token');
    expect(cfg).toMatchObject({ tokenEnv: 'GBRAIN_TEST_CADENCE_TOKEN' });
  });

  test('bounds a provider that never signals the end of pagination', async () => {
    process.env.GBRAIN_TEST_CADENCE_TOKEN = 'synthetic-token';
    let groupCalls = 0;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: { name: string } };
      if (body.params.name === 'workspace_metadata') return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ id: 'w' }) }] } }));
      groupCalls++;
      return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify([{ id: `group-${groupCalls}` }]) }] } }));
    };
    await expect(createCadenceProvider(fetchImpl as typeof fetch).read(parseCadenceSourceConfig({ kind: 'cadence', c_token_env: 'GBRAIN_TEST_CADENCE_TOKEN' }, '/tmp/cadence'), null)).rejects.toThrow(/page limit/);
    expect(groupCalls).toBe(100);
    delete process.env.GBRAIN_TEST_CADENCE_TOKEN;
  });

  test('scopes same-slug existence checks to the source', async () => {
    const calls: unknown[][] = [];
    const engine = { executeRaw: async (_sql: string, params: unknown[]) => { calls.push(params); return params[1] === 'source-a' ? [{ slug: 'same-slug' }] : []; } } as never;
    expect(await findCadencePage(engine, 'same-slug', 'source-a')).toEqual([{ slug: 'same-slug' }]);
    expect(await findCadencePage(engine, 'same-slug', 'source-b')).toEqual([]);
    expect(calls).toEqual([['same-slug', 'source-a'], ['same-slug', 'source-b']]);
  });
});
