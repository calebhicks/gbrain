import { describe, expect, test } from 'bun:test';
import {
  exactSourceQuoteLocator,
  invalidSourceQuotes,
  repairSourceQuotes,
  type SourceQuoteCandidate,
} from '../src/core/cycle/source-quote-grounding.ts';

describe('source quote grounding', () => {
  test('repairs normalized punctuation and whitespace to exact source bytes and UTF-16 offsets', () => {
    const source = 'Before. Buyer said, “We\u00a0need this—by Friday.”\nAfter.';
    const candidate = 'buyer said "we need this - by friday"';
    const [atom] = repairSourceQuotes<SourceQuoteCandidate>([
      { title: 'deadline', source_quote: candidate },
    ], source);

    expect(atom.source_quote).toBe('Buyer said, “We\u00a0need this—by Friday');
    expect(atom.source_quote_repair).toBe('unique_token_sequence_v1');
    expect(atom.source_quote_candidate_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(invalidSourceQuotes([atom], source)).toBeNull();
    expect(exactSourceQuoteLocator(source, atom.source_quote!)).toEqual({
      start: 8,
      end: 43,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('does not repair ambiguous, short, or paraphrased candidates', () => {
    const source = 'The team needs a clear next step. Later, the team needs a clear next step.';
    const candidates = [
      'team needs a clear next step',
      'clear next step',
      'the group requires a definite follow-up action',
    ];

    for (const sourceQuote of candidates) {
      const [atom] = repairSourceQuotes<SourceQuoteCandidate>([
        { title: 'unsafe', source_quote: sourceQuote },
      ], source);
      expect(atom.source_quote).toBe(sourceQuote);
      expect(atom.source_quote_repair).toBeUndefined();
      expect(invalidSourceQuotes([atom], source)).not.toBeNull();
    }
  });
});
