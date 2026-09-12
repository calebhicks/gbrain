/**
 * T2 — applyTitleBoost stage unit tests (mutate-in-place post-fusion stage).
 * Verifies: title-match multiplies + stamps; non-match untouched; floor-gate
 * skips below-threshold results; idempotent factor stamping.
 */

import { describe, test, expect } from 'bun:test';
import { applyTitleBoost, DEFAULT_TITLE_BOOST } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function mk(slug: string, title: string, score: number, type = 'note'): SearchResult {
  return {
    slug, title, score,
    chunk_text: '', type, source_id: 'default',
    chunk_index: 0, chunk_id: 1,
  } as unknown as SearchResult;
}

describe('applyTitleBoost', () => {
  test('multiplies score and stamps title_match_boost on a title-phrase match', () => {
    const r = mk('projects/mingtang', 'The Mingtang — Indoor Greek Amphitheater', 0.8);
    applyTitleBoost([r], 'greek amphitheater', DEFAULT_TITLE_BOOST);
    expect(r.score).toBeCloseTo(0.8 * 1.25, 6);
    expect(r.title_match_boost).toBe(1.25);
  });

  test('leaves non-matching results untouched (no stamp)', () => {
    const r = mk('notes/other', 'Completely Unrelated Title', 0.8);
    applyTitleBoost([r], 'greek amphitheater', DEFAULT_TITLE_BOOST);
    expect(r.score).toBe(0.8);
    expect(r.title_match_boost).toBeUndefined();
  });

  test('floor-gate skips a matching result below threshold', () => {
    const strong = mk('projects/mingtang', 'Indoor Greek Amphitheater', 1.0);
    const weak = mk('notes/aside', 'A Greek Amphitheater Footnote', 0.50);
    // threshold = 0.85 * topScore(1.0) = 0.85; weak (0.50) is below.
    applyTitleBoost([strong, weak], 'greek amphitheater', DEFAULT_TITLE_BOOST, 0.85);
    expect(strong.title_match_boost).toBe(1.25);
    expect(weak.title_match_boost).toBeUndefined(); // gated out
    expect(weak.score).toBe(0.50);
  });

  test('factor <= 1.0 is a no-op (disabled)', () => {
    const r = mk('projects/mingtang', 'Greek Amphitheater', 0.8);
    applyTitleBoost([r], 'greek amphitheater', 1.0);
    expect(r.score).toBe(0.8);
    expect(r.title_match_boost).toBeUndefined();
  });

  test('empty query is a no-op', () => {
    const r = mk('projects/mingtang', 'Greek Amphitheater', 0.8);
    applyTitleBoost([r], '', DEFAULT_TITLE_BOOST);
    expect(r.score).toBe(0.8);
  });

  test('qualified title containment is opt-in and preserves named entities', () => {
    const off = mk('people/trevor-goertzen', 'Trevor Goertzen', 0.5, 'person');
    applyTitleBoost([off], 'Trevor Goertzen meetings', DEFAULT_TITLE_BOOST);
    expect(off.score).toBe(0.5);

    const on = mk('people/trevor-goertzen', 'Trevor Goertzen', 0.5, 'person');
    applyTitleBoost([on], 'Trevor Goertzen meetings', DEFAULT_TITLE_BOOST, undefined, true);
    expect(on.score).toBeCloseTo(0.625, 6);
  });

  test('qualified generic two-token concepts do not receive the production boost', () => {
    const r = mk('concepts/special-education', 'Special Education', 0.5, 'concept');
    applyTitleBoost([r], 'IEP special education product requests', DEFAULT_TITLE_BOOST, undefined, true);
    expect(r.score).toBe(0.5);
    expect(r.title_match_boost).toBeUndefined();
  });

  test('qualified opt-in does not bypass the floor for a legacy forward match', () => {
    const r = mk('people/trevor-goertzen', 'Trevor Goertzen Profile', 0.3, 'person');
    applyTitleBoost([r], 'Trevor Goertzen', DEFAULT_TITLE_BOOST, 0.85, true);
    expect(r.score).toBe(0.3);
    expect(r.title_match_boost).toBeUndefined();
  });
});
