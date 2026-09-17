/**
 * Scheduled autopilot -> runCycle -> extract_atoms integration.
 *
 * This deliberately drives the registered Minion handler and the real cycle
 * phase against PGLite. Only the final chat transport is mocked: no provider
 * or fake phase report is involved. The pack is synthetic and process-local;
 * activation is supplied by the test environment, never persisted.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';

let engine: PGLiteEngine;
let packHome: string;
let oldHome: string | undefined;
let oldPack: string | undefined;
let chatCalls = 0;

const SOURCE_ID = 'synthetic-source';
const PAGE_SLUG = 'notes/scheduled-learning';

const PACK = {
  api_version: 'gbrain-schema-pack-v1',
  name: 'synthetic-autopilot-extract',
  version: '1.0.0',
  description: 'test-only declaring pack',
  gbrain_min_version: '0.38.0',
  extends: null,
  borrow_from: [],
  page_types: [{
    name: 'note', primitive: 'entity', path_prefixes: ['notes/'],
    aliases: [], extractable: true, expert_routing: false,
  }],
  link_types: [],
  frontmatter_links: [],
  takes_kinds: ['fact', 'take', 'bet', 'hunch'],
  enrichable_types: [],
  filing_rules: [],
  phases: ['extract_atoms'],
};

const CHAT_RESULT: ChatResult = {
  text: JSON.stringify([{
    title: 'Small experiments beat abstract planning',
    atom_type: 'insight',
    body: 'Small experiments reveal constraints before a team invests in a large plan. This turns uncertainty into a sequence of cheap decisions.',
    source_quote: 'Small experiments reveal constraints before a team invests in a large plan.',
    lesson: 'Test the riskiest assumption with the smallest useful experiment.',
    concepts: ['small-experiments'],
    virality_score: 72,
    emotional_register: 'practical',
  }]),
  blocks: [],
  stopReason: 'end',
  usage: { input_tokens: 100, output_tokens: 80, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'mock:scheduled-extract',
  providerId: 'mock',
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  packHome = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-pack-'));
  const packDir = join(packHome, '.gbrain', 'schema-packs', PACK.name);
  mkdirSync(packDir, { recursive: true });
  const packPath = join(packDir, 'pack.json');
  writeFileSync(packPath, JSON.stringify(PACK) + '\n');
  oldHome = process.env.GBRAIN_HOME;
  oldPack = process.env.GBRAIN_SCHEMA_PACK;
  process.env.GBRAIN_HOME = packHome;
  process.env.GBRAIN_SCHEMA_PACK = PACK.name;
  __setPackLocatorForTests((name) => name === PACK.name ? packPath : null);
  _resetPackCacheForTests();
  chatCalls = 0;
  configureGateway({ chat_model: 'openai:gpt-5', env: { OPENAI_API_KEY: 'synthetic-test-key' } });
  __setChatTransportForTests(async () => {
    chatCalls++;
    return CHAT_RESULT;
  });
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  if (oldHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = oldHome;
  if (oldPack === undefined) delete process.env.GBRAIN_SCHEMA_PACK;
  else process.env.GBRAIN_SCHEMA_PACK = oldPack;
  rmSync(packHome, { recursive: true, force: true });
});

async function captureHandler(): Promise<(job: any) => Promise<any>> {
  const handlers = new Map<string, (job: any) => Promise<any>>();
  const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
  await registerBuiltinHandlers(fakeWorker as never, engine);
  return handlers.get('autopilot-cycle')!;
}

describe('autopilot-cycle scheduled extract_atoms integration', () => {
  test('declaring pack extracts a nondefault-source page once, then converges without LLM work', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, NULL, '{}'::jsonb)`,
      [SOURCE_ID, SOURCE_ID],
    );
    await engine.putPage(PAGE_SLUG, {
      type: 'note',
      title: 'Scheduled learning note',
      compiled_truth: 'Small experiments reveal constraints before a team invests in a large plan. This turns uncertainty into a sequence of cheap decisions. '.repeat(8),
      timeline: '',
      frontmatter: {},
    }, { sourceId: SOURCE_ID });

    const handler = await captureHandler();
    const job = () => handler({
      data: { source_id: SOURCE_ID, phases: ['extract_atoms'], pull: false },
      signal: { aborted: false } as any,
      job: { id: 77, name: 'autopilot-cycle' } as any,
    });

    const first = await job();
    expect(first.report.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'extract_atoms', status: 'ok' }),
    ]));
    expect(chatCalls).toBe(1);

    const atoms = await engine.executeRaw<{ source_id: string; slug: string; source_hash: string; type: string }>(
      `SELECT source_id, slug, frontmatter->>'source_hash' AS source_hash, type
         FROM pages WHERE type = 'atom'`,
    );
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toMatchObject({ source_id: SOURCE_ID, type: 'atom' });
    expect(atoms[0].slug).toContain('atoms/');
    expect(atoms[0].source_hash).toMatch(/^[0-9a-f]{16}$/);

    const second = await job();
    expect(second.report.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'extract_atoms', status: 'skipped' }),
    ]));
    expect(chatCalls).toBe(1);
    const atomsAfter = await engine.executeRaw(`SELECT slug FROM pages WHERE type = 'atom'`);
    expect(atomsAfter).toHaveLength(1);
  }, 30_000);
});
