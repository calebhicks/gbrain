// The shared session corpus belongs to exactly one source. Per-source atom
// idempotency means discovering it in every drain would duplicate its atoms
// under each source, so only the configured brain default may discover it.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

let engine: PGLiteEngine;
let corpusDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  corpusDir = mkdtempSync(join(tmpdir(), 'corpus-scope-'));
  // discoverTranscripts drops files under minChars (default 2000).
  writeFileSync(join(corpusDir, 'meeting.txt'), 'transcript line. '.repeat(150));
}, 60000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(corpusDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const okChat = async (): Promise<ChatResult> => ({
  text: '[]',
  blocks: [{ type: 'text', text: '[]' }],
  stopReason: 'end',
  usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5',
  providerId: 'anthropic',
});

const loadCfg = async (): Promise<GBrainConfig> => ({
  engine: 'pglite',
  dream: { synthesize: { session_corpus_dir: corpusDir } },
});

describe('extract_atoms corpus scoping', () => {
  test('a per-source drain does NOT discover the shared corpus', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'notion',
      brainDir: corpusDir,
      _loadConfig: loadCfg,
      _chat: okChat,
    });
    expect(result.details.transcripts_processed).toBe(0);
  });

  test('the default-source run still discovers the corpus', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      brainDir: corpusDir,
      _loadConfig: loadCfg,
      _chat: okChat,
    });
    expect(result.details.transcripts_processed).toBe(1);
  });

  test('a pinned non-"default" brain default still gets the corpus', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('main', 'main', '{}'::jsonb)`,
    );
    await engine.setConfig('sources.default', 'main');
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'main',
      brainDir: corpusDir,
      _loadConfig: loadCfg,
      _chat: okChat,
    });
    expect(result.details.transcripts_processed).toBe(1);
  });

  test('a configured non-default owner excludes the seeded default source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('main', 'main', '{}'::jsonb)`,
    );
    await engine.setConfig('sources.default', 'main');
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      brainDir: corpusDir,
      _loadConfig: loadCfg,
      _chat: okChat,
    });
    expect(result.details.transcripts_processed).toBe(0);
  });

  test('explicit transcript inputs remain source-scoped test/caller data', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'work',
      _transcripts: [{ filePath: 'provided.txt', content: 'provided', contentHash: 'abc123' }],
      _pages: [],
      _chat: okChat,
    });
    expect(result.details.transcripts_processed).toBe(1);
  });
});
