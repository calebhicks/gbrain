import type { GranolaNote, RenderedGranolaPage } from './types.ts';

const SOURCE = 'granola';
const MIN_TRANSCRIPT_CHARS = 1;

function idOf(id: string): string | null {
  const value = id.trim();
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : null;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'null';
  return JSON.stringify(String(value));
}

function slugId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

export function granolaMeetingSlug(id: string): string {
  return `${SOURCE}/meetings/${slugId(id)}`;
}

function speaker(s: NonNullable<GranolaNote['transcript']>[number]): string {
  if (typeof s.speaker === 'string') return s.speaker;
  return s.speaker?.name ?? 'Speaker';
}

export function renderGranolaNote(note: GranolaNote): RenderedGranolaPage | null {
  const id = idOf(note.id);
  if (!id || note.access_revoked === true) return null;
  const segments = note.transcript ?? [];
  const transcript = segments
    .map((s) => ({ who: speaker(s), text: (s.text ?? '').trim() }))
    .filter((s) => s.text.length > 0)
    .map((s) => `**${s.who}:** ${s.text}`)
    .join('\n\n');
  if (transcript.length < MIN_TRANSCRIPT_CHARS) return null;
  const slug = granolaMeetingSlug(id);
  const attendees = (note.attendees ?? []).map((a) => a.name || a.email).filter(Boolean);
  const fields: Array<[string, unknown]> = [
    ['type', 'meeting'],
    ['source_system', SOURCE],
    ['source_object_id', id],
    ['granola_id', id],
    ['title', note.title ?? 'Granola meeting'],
    ['created_at', note.created_at ?? null],
    ['updated_at', note.updated_at ?? null],
    ['source_url', note.web_url ?? null],
    ['attendees', attendees],
    ['evidence_class', 'meeting_transcript'],
  ];
  const fm = ['---', ...fields.map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(scalar).join(', ')}]` : scalar(v)}`), '---'].join('\n');
  const notes = note.summary_markdown?.trim();
  const markdown = `${fm}\n\n# ${note.title ?? 'Granola meeting'}\n\n${transcript}\n${notes ? `\n## Granola notes (AI-generated, secondary)\n\n${notes}\n` : ''}`;
  return { relPath: `${slug}.md`, slug, markdown, id };
}
