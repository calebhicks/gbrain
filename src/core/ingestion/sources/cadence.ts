/**
 * Native Cadence read source.
 *
 * This adapter consumes a complete, already-fetched Cadence snapshot. It does
 * not authenticate to Cadence, call a provider, write a brain, or run the
 * legacy transform/enrich scripts. A provider job may materialize a snapshot
 * and hand it to this source later; keeping that boundary explicit makes the
 * native source testable without Cadence content or credentials.
 *
 * The snapshot is intentionally emitted as JSON records. The adapter preserves
 * source fields and provenance; it does not turn status into a judgment or
 * synthesize narrative. Missing records are not tombstones: a complete
 * snapshot is an observation, and deletion/reconciliation belongs downstream.
 */
import { readFileSync } from 'node:fs';
import { computeContentHash, type IngestionEvent, type IngestionSource, type IngestionSourceContext, type IngestionSourceHealth } from '../types.ts';

export interface CadenceSnapshotSourceOpts {
  snapshotPath?: string;
  /** Synthetic/test seam and the native handoff boundary. */
  snapshot?: string | Record<string, unknown>;
  sourceId?: string;
  _readFile?: (path: string) => string;
}

type JsonObject = Record<string, unknown>;

// Personnel-grade families remain CEO-only and are deliberately not part of
// this organization source, even when present in a full provider snapshot.
const FAMILIES = ['aor_updates', 'groups', 'measurables', 'priorities', 'projects', 'tasks'] as const;
type Family = typeof FAMILIES[number];

/** Stable JSON representation used for content hashes and no-op detection. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as JsonObject;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredId(record: unknown, path: string): string {
  if (!isObject(record) || typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`CadenceSnapshotSource: ${path} requires a non-empty string id`);
  }
  return record.id;
}

function normalizeGroups(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('CadenceSnapshotSource: groups must be an array');
  // cadence-transform.py accepts this provider export shape. Preserve only
  // fields that the transform derives, and only when the provider supplied
  // them; no captain/team interpretation is added here.
  if (value.length > 0 && isObject(value[0]) && 'person_id' in value[0]) {
    const teams = new Map<string, JsonObject>();
    for (const [index, person] of value.entries()) {
      if (!isObject(person) || typeof person.person_id !== 'string') throw new Error(`CadenceSnapshotSource: groups[${index}] requires person_id`);
      const captaincies = Array.isArray(person.captaincies) ? person.captaincies : [];
      const memberships = Array.isArray(person.team_memberships) ? person.team_memberships : [];
      for (const captaincy of captaincies) {
        if (!isObject(captaincy) || typeof captaincy.group_id !== 'string') continue;
        if (!teams.has(captaincy.group_id)) teams.set(captaincy.group_id, {
          id: captaincy.group_id,
          title: captaincy.group_title ?? null,
          captain_id: person.person_id,
          captain_name: person.full_name ?? null,
        });
      }
      for (const membership of memberships) {
        if (!isObject(membership)) continue;
        const id = typeof membership.group_id === 'string' ? membership.group_id : membership.id;
        if (typeof id !== 'string' || teams.has(id)) continue;
        teams.set(id, { id, title: membership.group_title ?? membership.title ?? null, captain_id: null, captain_name: null });
      }
    }
    return [...teams.values()];
  }
  return value.map((record, index) => {
    requiredId(record, `groups[${index}]`);
    return record as JsonObject;
  });
}

interface SnapshotRecord { family: string; id: string; value: JsonObject; }

function parseSnapshot(input: string | Record<string, unknown>): { exportedAt: string; records: SnapshotRecord[]; fingerprint: string } {
  let raw: unknown;
  try { raw = typeof input === 'string' ? JSON.parse(input) : input; }
  catch (error) { throw new Error(`CadenceSnapshotSource: invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!isObject(raw) || typeof raw.exported_at !== 'string' || !raw.exported_at) {
    throw new Error('CadenceSnapshotSource: snapshot requires exported_at');
  }

  const records: SnapshotRecord[] = [];
  const groups = normalizeGroups(raw.groups ?? []);
  for (const family of FAMILIES) {
    const values = family === 'groups' ? groups : raw[family] ?? [];
    if (!Array.isArray(values)) throw new Error(`CadenceSnapshotSource: ${family} must be an array`);
    for (const [index, value] of values.entries()) {
      const id = requiredId(value, `${family}[${index}]`);
      records.push({ family, id, value: value as JsonObject });
    }
  }
  // Workspace metadata is a record because the provider fetch exports it as
  // one object rather than a family array.
  if (raw.workspace !== undefined) {
    const id = requiredId(raw.workspace, 'workspace');
    records.push({ family: 'workspace', id, value: raw.workspace as JsonObject });
  }
  records.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
  const fingerprint = computeContentHash(canonicalJson({ exported_at: raw.exported_at, records }));
  return { exportedAt: raw.exported_at, records, fingerprint };
}

export class CadenceSnapshotSource implements IngestionSource {
  readonly kind = 'cadence';
  readonly mode = 'migration' as const;
  readonly id: string;
  private readonly opts: { snapshot?: string | Record<string, unknown>; snapshotPath?: string; readFile: (path: string) => string };
  private lastFingerprint: string | null = null;
  private lastHealth: IngestionSourceHealth = { status: 'warn', message: 'not yet started' };

  constructor(opts: CadenceSnapshotSourceOpts = {}) {
    if (!opts.snapshot && !opts.snapshotPath) throw new Error('CadenceSnapshotSource: snapshot or snapshotPath is required');
    this.id = opts.sourceId ?? 'cadence';
    this.opts = { snapshot: opts.snapshot, snapshotPath: opts.snapshotPath, readFile: opts._readFile ?? ((path) => readFileSync(path, 'utf8')) };
  }

  async start(ctx: IngestionSourceContext): Promise<void> {
    let parsed: ReturnType<typeof parseSnapshot>;
    try {
      const input = this.opts.snapshot ?? this.opts.readFile(this.opts.snapshotPath!);
      parsed = parseSnapshot(input);
    } catch (error) {
      this.lastHealth = { status: 'fail', message: 'snapshot failed: no records emitted' };
      throw error;
    }
    if (parsed.fingerprint === this.lastFingerprint) {
      ctx.logger.info(`[cadence] no-op: complete snapshot ${parsed.fingerprint} already emitted`);
      this.lastHealth = { status: 'ok', message: `snapshot unchanged: ${parsed.records.length} records` };
      return;
    }
    // All validation and sorting happens before the first emit. A malformed
    // row therefore cannot leave a partial snapshot in the daemon queue.
    for (const record of parsed.records) {
      const content = canonicalJson(record.value);
      const event: IngestionEvent = {
        source_id: this.id,
        source_kind: this.kind,
        source_uri: `cadence://${record.family}/${encodeURIComponent(record.id)}`,
        received_at: parsed.exportedAt,
        content_type: 'application/json',
        content,
        content_hash: computeContentHash(content),
        metadata: { family: record.family, record_id: record.id, snapshot_at: parsed.exportedAt },
      };
      ctx.emit(event);
    }
    this.lastFingerprint = parsed.fingerprint;
    this.lastHealth = { status: 'ok', message: `snapshot emitted: ${parsed.records.length} records` };
    ctx.logger.info(`[cadence] emitted complete snapshot: ${parsed.records.length} records`);
  }

  async stop(): Promise<void> { /* one-shot source; no background work to drain */ }

  async healthCheck(): Promise<IngestionSourceHealth> { return this.lastHealth; }
}

export const __testing = { parseSnapshot, normalizeGroups };
