import { createHash } from 'node:crypto';

export type SourceQuoteRepair = 'unique_unicode_whitespace_v1' | 'unique_token_sequence_v1';

export interface SourceQuoteCandidate {
  title?: string;
  source_quote?: string;
  source_quote_repair?: SourceQuoteRepair;
  source_quote_candidate_sha256?: string;
}

export interface ExactSourceQuoteLocator {
  start: number;
  end: number;
  sha256: string;
}

export function invalidSourceQuotes(atoms: SourceQuoteCandidate[], sourceText: string): string | null {
  for (const atom of atoms) {
    const quote = atom.source_quote;
    const label = JSON.stringify(atom.title);
    if (!quote) return `atom ${label} omitted required source_quote`;
    if ([...quote].length > 200) return `atom ${label} source_quote exceeds 200 characters`;
    if (!sourceText.includes(quote)) return `atom ${label} source_quote is not an exact contiguous source span`;
    if (sourceText.indexOf(quote) !== sourceText.lastIndexOf(quote)) {
      return `atom ${label} source_quote is ambiguous within the selected source`;
    }
  }
  return null;
}

export function exactSourceQuoteLocator(sourceText: string, quote: string): ExactSourceQuoteLocator {
  const start = sourceText.indexOf(quote);
  if (start < 0 || start !== sourceText.lastIndexOf(quote)) {
    throw new Error('source_quote locator requires one exact unique source span');
  }
  return { start, end: start + quote.length, sha256: createHash('sha256').update(quote).digest('hex') };
}

interface NormalizedSourceText {
  text: string;
  starts: number[];
  ends: number[];
}

function normalizeSourceCharacters(value: string): NormalizedSourceText {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let priorSpace = false;
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset)!;
    const original = String.fromCodePoint(codePoint);
    const end = offset + original.length;
    const folded = original.normalize('NFKC')
      .replace(/[\u2018\u2019]/gu, "'")
      .replace(/[\u201c\u201d]/gu, '"')
      .replace(/[\u2013\u2014]/gu, '-')
      .toLowerCase();
    for (const character of folded) {
      if (/\s/u.test(character)) {
        if (characters.length > 0 && !priorSpace) {
          characters.push(' ');
          starts.push(offset);
          ends.push(end);
          priorSpace = true;
        }
      } else {
        characters.push(character);
        starts.push(offset);
        ends.push(end);
        priorSpace = false;
      }
    }
    offset = end;
  }
  while (characters.at(-1) === ' ') {
    characters.pop(); starts.pop(); ends.pop();
  }
  return { text: characters.join(''), starts, ends };
}

interface SourceToken {
  value: string;
  start: number;
  end: number;
}

function sourceTokens(value: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  const matcher = /[\p{L}\p{N}]+/gu;
  for (const match of value.matchAll(matcher)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    tokens.push({
      value: match[0].normalize('NFKC').toLowerCase(),
      start,
      end: start + match[0].length,
    });
  }
  return tokens;
}

function uniqueSequenceStart(source: readonly string[], candidate: readonly string[]): number {
  let match = -1;
  for (let index = 0; index <= source.length - candidate.length; index += 1) {
    if (!candidate.every((token, offset) => source[index + offset] === token)) continue;
    if (match >= 0) return -1;
    match = index;
  }
  return match;
}

function repairSourceQuote<T extends SourceQuoteCandidate>(atom: T, sourceText: string): T {
  const candidate = atom.source_quote;
  if (!candidate || candidate.length === 0 || sourceText.includes(candidate)) return atom;

  let start = -1;
  let end = -1;
  let repair: SourceQuoteRepair;
  const normalizedSource = normalizeSourceCharacters(sourceText);
  const normalizedCandidate = normalizeSourceCharacters(candidate).text;
  const normalizedStart = normalizedCandidate ? normalizedSource.text.indexOf(normalizedCandidate) : -1;
  if (normalizedStart >= 0 && normalizedStart === normalizedSource.text.lastIndexOf(normalizedCandidate)) {
    start = normalizedSource.starts[normalizedStart] ?? -1;
    end = normalizedSource.ends[normalizedStart + normalizedCandidate.length - 1] ?? -1;
    repair = 'unique_unicode_whitespace_v1';
  } else {
    const source = sourceTokens(sourceText);
    const candidateValues = sourceTokens(candidate).map(token => token.value);
    if (candidateValues.length < 4 || candidateValues.join(' ').length < 20) return atom;
    const tokenStart = uniqueSequenceStart(source.map(token => token.value), candidateValues);
    if (tokenStart < 0) return atom;
    start = source[tokenStart]!.start;
    end = source[tokenStart + candidateValues.length - 1]!.end;
    repair = 'unique_token_sequence_v1';
  }
  if (start < 0 || end <= start) return atom;
  const repaired = { ...atom, source_quote: sourceText.slice(start, end) };
  Object.defineProperties(repaired, {
    source_quote_repair: { value: repair, enumerable: false },
    source_quote_candidate_sha256: {
      value: createHash('sha256').update(candidate).digest('hex'),
      enumerable: false,
    },
  });
  return repaired;
}

export function repairSourceQuotes<T extends SourceQuoteCandidate>(atoms: T[], sourceText: string): T[] {
  return atoms.map(atom => repairSourceQuote(atom, sourceText));
}
