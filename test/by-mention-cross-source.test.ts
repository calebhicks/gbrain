// LOCAL PATCH regression guard (mc-agents 2026-08-15): allowedTargetSources
// admits cross-source mentions for named target sources only. Default
// behavior (field omitted) must stay upstream-v1: suppress all cross-source.
import { describe, test, expect } from 'bun:test';
import { findMentionedEntities, type Gazetteer, type GazetteerEntry } from '../src/core/by-mention.ts';

function gz(entries: GazetteerEntry[]): Gazetteer {
  const m: Gazetteer = new Map();
  for (const e of entries) {
    const k = e.tokens[0];
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  return m;
}

const lambda: GazetteerEntry = {
  slug: 'companies/lambda-school', source_id: 'default',
  title: 'Lambda School', tokens: ['lambda', 'school'],
};
const other: GazetteerEntry = {
  slug: 'companies/acme', source_id: 'linear',
  title: 'Acme Corporation', tokens: ['acme', 'corporation'],
};

describe('cross-source mentions (local patch)', () => {
  const body = 'Notes on Lambda School and Acme Corporation from 2019.';

  test('omitted allowedTargetSources preserves v1: no cross-source links', () => {
    const out = findMentionedEntities(body, gz([lambda, other]), {
      fromSlug: 'craft/imported-notes/x', fromSourceId: 'craft',
    });
    expect(out).toHaveLength(0);
  });

  test('admits targets in the named source only', () => {
    const out = findMentionedEntities(body, gz([lambda, other]), {
      fromSlug: 'craft/imported-notes/x', fromSourceId: 'craft',
      allowedTargetSources: new Set(['default']),
    });
    expect(out.map(m => m.slug)).toEqual(['companies/lambda-school']);
  });

  test('same-source matching still works with the field set', () => {
    const out = findMentionedEntities(body, gz([{ ...lambda, source_id: 'craft' }]), {
      fromSlug: 'craft/imported-notes/x', fromSourceId: 'craft',
      allowedTargetSources: new Set(['default']),
    });
    expect(out.map(m => m.slug)).toEqual(['companies/lambda-school']);
  });

  test('self-link guard still wins over the allowance', () => {
    const out = findMentionedEntities('Lambda School notes', gz([lambda]), {
      fromSlug: 'companies/lambda-school', fromSourceId: 'default',
      allowedTargetSources: new Set(['default']),
    });
    expect(out).toHaveLength(0);
  });
});
