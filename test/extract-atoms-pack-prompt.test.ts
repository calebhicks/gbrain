import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { SchemaPackManifestSchema, type SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { _resetPackCacheForTests, resolvePack } from '../src/core/schema-pack/registry.ts';
import { resolveExtractablePrompt } from '../src/core/schema-pack/prompt-template.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const roots: string[] = [];
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  _resetPackCacheForTests();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function manifest(name: string, version: string, extendsName: string | null, pageTypes: unknown[]): SchemaPackManifest {
  return SchemaPackManifestSchema.parse({
    api_version: 'gbrain-schema-pack-v1',
    name,
    version,
    extends: extendsName,
    page_types: pageTypes,
  });
}

async function inheritedPack(
  promptPath = 'prompts/experience.md',
  prompt = 'Find bounded visible change.',
  childVersion = '1.0.0',
) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-pack-prompt-'));
  roots.push(root);
  const parentRoot = join(root, 'parent');
  const childRoot = join(root, 'child');
  mkdirSync(join(parentRoot, 'prompts'), { recursive: true });
  mkdirSync(childRoot, { recursive: true });
  const parentPath = join(parentRoot, 'pack.json');
  const childPath = join(childRoot, 'pack.json');
  writeFileSync(parentPath, '{}');
  writeFileSync(childPath, '{}');
  writeFileSync(join(parentRoot, 'prompts', 'experience.md'), prompt);
  const parent = manifest('parent-pack', '1.0.0', null, [{
    name: 'experience', primitive: 'entity', path_prefixes: ['experiences/'], aliases: [],
    extractable: { prompt_template: promptPath, eval_dimensions: ['source-closure'] },
  }]);
  const child = manifest('child-pack', childVersion, 'parent-pack', []);
  const byName = new Map([[parent.name, parent], [child.name, child]]);
  const paths = new Map([[parent.name, parentPath], [child.name, childPath]]);
  const resolved = await resolvePack(child, async name => byName.get(name)!, {
    loadByPath: name => paths.get(name) ?? null,
  });
  return { root, parentRoot, resolved };
}

describe('pack-owned extract_atoms prompt', () => {
  test('resolves an inherited winning declaration inside the declaring pack', async () => {
    const { resolved } = await inheritedPack();
    expect(resolved.page_type_declaration_origins.experience.pack_name).toBe('parent-pack');
    const lens = resolveExtractablePrompt(resolved, 'experience');
    expect(lens?.prompt).toBe('Find bounded visible change.');
    expect(lens?.declaring_pack).toBe('parent-pack');
    expect(lens?.prompt_sha256).toHaveLength(64);
  });

  test('rejects absolute paths, traversal, symlinks, and missing files', async () => {
    for (const unsafe of ['/tmp/prompt.md', '../prompt.md', 'prompts/missing.md']) {
      const { resolved } = await inheritedPack(unsafe);
      expect(() => resolveExtractablePrompt(resolved, 'experience')).toThrow();
      _resetPackCacheForTests();
    }
    const fixture = await inheritedPack('prompts/link.md');
    symlinkSync(join(fixture.parentRoot, 'prompts', 'experience.md'), join(fixture.parentRoot, 'prompts', 'link.md'));
    expect(() => resolveExtractablePrompt(fixture.resolved, 'experience')).toThrow(/symlink/i);
  });

  test('keeps source content in the user message and composes the lens with the fixed output contract', async () => {
    const { resolved } = await inheritedPack();
    const captured: { value?: ChatOpts } = {};
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      captured.value = opts;
      return {
        text: '[{"title":"Visible retry","atom_type":"insight","body":"The response changed."}]',
        blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      };
    };
    await runPhaseExtractAtoms(engine, {
        sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
        _pages: [{ slug: 'experiences/one', pageType: 'experience', content: 'UNTRUSTED_SOURCE_BODY', contentHash: '1234567890abcdef' }],
        _chat: chat,
      });
      expect(captured.value).toBeDefined();
      const call = captured.value!;
      expect(call.system).toContain('Find bounded visible change.');
      expect(call.system).toContain('Output ONLY the JSON array');
      expect(call.system).not.toContain('UNTRUSTED_SOURCE_BODY');
      expect(call.messages[0]?.content).toContain('UNTRUSTED_SOURCE_BODY');
      const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
        `SELECT frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL`,
      );
      expect(rows[0].frontmatter.extraction_profile_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rows[0].frontmatter.extraction_declaring_pack).toBe('parent-pack');
    expect(rows[0].frontmatter.extraction_profile_state).toBe('active');
  }, 60_000);

  test('a changed prompt profile re-extracts and supersedes only after the replacement is complete', async () => {
    const first = await inheritedPack('prompts/experience.md', 'Find the initial state.', '1.0.0');
    _resetPackCacheForTests();
    const second = await inheritedPack('prompts/experience.md', 'Find the later visible state.', '1.0.1');
    await engine.putPage('experiences/replay', {
      type: 'experience' as never, title: 'Replay', compiled_truth: 'e'.repeat(800),
      timeline: '', frontmatter: {}, content_hash: 'profile-source-hash-1234',
    });
    let title = 'Initial atom';
    const chat = async (_opts: ChatOpts): Promise<ChatResult> => ({
      text: `[{"title":"${title}","atom_type":"insight","body":"A bounded observation."}]`,
      blocks: [{ type: 'text', text: '' }], stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
    });
    const firstRun = await runPhaseExtractAtoms(engine, {
        _resolvedPack: first.resolved, _transcripts: [], _chat: chat,
      });
      expect(firstRun.details?.pages_processed).toBe(1);
      const replay = await runPhaseExtractAtoms(engine, {
        _resolvedPack: first.resolved, _transcripts: [], _chat: chat,
      });
      expect(replay.details?.pages_processed).toBe(0);
      title = 'Replacement atom';
      const replacement = await runPhaseExtractAtoms(engine, {
        _resolvedPack: second.resolved, _transcripts: [], _chat: chat,
      });
      expect(replacement.details?.pages_processed).toBe(1);
      const rows = await engine.executeRaw<{ slug: string; deleted_at: string | null; state: string }>(
        `SELECT slug, deleted_at, frontmatter->>'extraction_profile_state' AS state
           FROM pages WHERE type='atom' ORDER BY slug`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.filter(row => row.deleted_at === null).map(row => row.state)).toEqual(['active']);
    expect(rows.filter(row => row.deleted_at !== null).map(row => row.state)).toEqual(['superseded']);
  }, 60_000);
});
