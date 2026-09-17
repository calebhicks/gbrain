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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../engine.ts';
import type { SyncOpts, SyncResult } from '../../../commands/sync.ts';
import { importFromContent } from '../../import-file.ts';
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



/** DB-source sync adapter. This is the production-wired path; unlike the
 * IngestionSource wrapper it awaits every import before advancing the cursor. */
export type CadenceTarget = 'organization' | 'personnel';
export interface CadenceSourceConfig {
  kind: 'cadence';
  target: CadenceTarget;
  account?: string;
  organization?: string;
  personnelTarget?: 'ceo';
  dir: string;
  snapshotPath?: string;
  /** Name of the runtime environment variable containing the token. */
  tokenEnv?: string;
  /** Reserved runtime vault reference; the secret itself is never persisted. */
  tokenVault?: string;
  endpoint?: string;
}

export interface CadenceReadResult {
  snapshot: Record<string, unknown>;
  nextCursor?: string | null;
}
export interface CadenceProvider {
  read(config: CadenceSourceConfig, cursor: string | null, opts?: { signal?: AbortSignal }): Promise<CadenceReadResult>;
}
export interface CadenceSyncDeps { provider?: CadenceProvider; readFile?: (path: string) => string; }

const PERSONNEL_FAMILIES = ['people', 'pulse_reflections', 'checkins'] as const;
const MAX_PROVIDER_PAGES = 100;

export function parseCadenceSourceConfig(config: Record<string, unknown>, fallbackDir: string): CadenceSourceConfig {
  if (config.kind !== 'cadence') throw new Error('Cadence source requires config.kind="cadence"');
  const target = config.c_target === 'personnel' || config.cadence_target === 'personnel' || config.target === 'personnel' ? 'personnel' : 'organization';
  const personnelTarget = config.c_personnel_target ?? config.cadence_personnel_target;
  if (target === 'personnel' && personnelTarget !== 'ceo') {
    throw new Error('Cadence personnel target is restricted to explicit CEO target');
  }
  const dir = typeof config.c_dir === 'string' && config.c_dir.length > 0 ? config.c_dir : fallbackDir;
  const account = config.c_account ?? config.cadence_account;
  const organization = config.c_organization ?? config.cadence_organization ?? config.organization_id;
  return {
    kind: 'cadence', target, dir,
    ...(typeof account === 'string' ? { account } : {}),
    ...(typeof organization === 'string' ? { organization } : {}),
    ...(target === 'personnel' ? { personnelTarget: 'ceo' as const } : {}),
    ...(typeof config.c_snapshot === 'string' ? { snapshotPath: config.c_snapshot } : {}),
    ...(Object.prototype.hasOwnProperty.call(config, 'c_token')
      ? (() => { throw new Error('Cadence c_token inline secret config is rejected; use c_token_env or c_token_vault'); })()
      : {}),
    ...(typeof config.c_token_env === 'string' && config.c_token_env.length > 0 ? { tokenEnv: config.c_token_env } : {}),
    ...(typeof config.c_token_vault === 'string' && config.c_token_vault.length > 0 ? { tokenVault: config.c_token_vault } : {}),
    ...(typeof config.c_endpoint === 'string' ? { endpoint: config.c_endpoint } : {}),
  };
}

export function cadenceStateFile(dir: string): string { return join(dir, '.cadence-source.json'); }
function readCadenceState(dir: string): { cursor: string | null; fingerprint: string | null } {
  const file = cadenceStateFile(dir);
  if (!existsSync(file)) return { cursor: null, fingerprint: null };
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as Partial<{ cursor: string | null; fingerprint: string | null }>;
    return { cursor: state.cursor ?? null, fingerprint: state.fingerprint ?? null };
  } catch (error) {
    throw new Error(`Cadence state is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function writeCadenceState(dir: string, state: { cursor: string | null; fingerprint: string }): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${cadenceStateFile(dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, cadenceStateFile(dir));
}

function recordsForTarget(snapshot: Record<string, unknown>, target: CadenceTarget): SnapshotRecord[] {
  if (target === 'organization') return parseSnapshot(snapshot).records.filter((r) => !PERSONNEL_FAMILIES.includes(r.family as typeof PERSONNEL_FAMILIES[number]));
  if (snapshot.personnel === undefined && !PERSONNEL_FAMILIES.some((family) => snapshot[family] !== undefined)) {
    throw new Error('Cadence CEO personnel read returned no personnel families');
  }
  const personnel = (isObject(snapshot.personnel) ? snapshot.personnel : snapshot) as Record<string, unknown>;
  const out: SnapshotRecord[] = [];
  for (const family of PERSONNEL_FAMILIES) {
    const values = personnel[family] ?? [];
    if (!Array.isArray(values)) throw new Error(`CadenceSnapshotSource: ${family} must be an array`);
    for (const [index, value] of values.entries()) out.push({ family, id: requiredId(value, `${family}[${index}]`), value: value as JsonObject });
  }
  out.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
  return out;
}

function cadenceMarkdown(record: SnapshotRecord, exportedAt: string): string {
  return `---\ntitle: ${JSON.stringify(`${record.family} ${record.id}`)}\ncadence_family: ${record.family}\ncadence_record_id: ${JSON.stringify(record.id)}\ncadence_exported_at: ${JSON.stringify(exportedAt)}\n---\n\n${canonicalJson(record.value)}\n`;
}

export async function findCadencePage(engine: BrainEngine, slug: string, sourceId: string): Promise<Array<{ slug: string }>> {
  return engine.executeRaw<{ slug: string }>(
    'SELECT slug FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL',
    [slug, sourceId],
  );
}

/** Minimal MCP read client modeled on cadence-fetch.ts. Tests should inject a
 * provider; this default has no credential lookup and never writes snapshots. */
export function createCadenceProvider(fetchImpl: typeof fetch = fetch): CadenceProvider {
  return { async read(config, cursor, opts) {
    const endpoint = config.endpoint ?? 'https://cadence.schoolai.com/api/mcp';
    const token = config.tokenEnv ? process.env[config.tokenEnv] ?? '' : '';
    if (config.tokenVault) throw new Error('Cadence vault token references require a configured runtime vault resolver');
    if (!token) throw new Error('Cadence provider token is not configured');
    let callId = 0;
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const response = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++callId, method: 'tools/call', params: { name, arguments: args } }), signal: opts?.signal });
      if (!response.ok) throw new Error(`Cadence ${name} failed: HTTP ${response.status}`);
      const rpc = await response.json() as { error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      if (rpc.error) throw new Error(`Cadence ${name} failed: ${rpc.error.message ?? 'RPC error'}`);
      const text = rpc.result?.content?.[0]?.text;
      if (!text || rpc.result?.isError) throw new Error(`Cadence ${name} returned no readable result`);
      return JSON.parse(text);
    };
    const family = async (name: string, args: Record<string, unknown> = {}): Promise<unknown[]> => {
      const rows: unknown[] = [];
      const seenPages = new Set<string>();
      const seenCursors = new Set<string>();
      for (let pageNumber = 0, offset = 0; pageNumber < MAX_PROVIDER_PAGES; pageNumber++, offset += 100) {
        const value = await call(name, { ...args, offset, limit: 100 });
        const page = Array.isArray(value) ? value : ((value as Record<string, unknown>).items ?? (value as Record<string, unknown>)[name] ?? []) as unknown[];
        const pageKey = canonicalJson(page);
        if (page.length > 0 && seenPages.has(pageKey)) throw new Error(`Cadence ${name} returned a repeated page`);
        seenPages.add(pageKey);
        const nextCursor = isObject(value) && typeof (value.nextCursor ?? value.next_cursor ?? value.cursor) === 'string'
          ? String(value.nextCursor ?? value.next_cursor ?? value.cursor) : null;
        if (nextCursor !== null && seenCursors.has(nextCursor)) throw new Error(`Cadence ${name} returned a repeated cursor`);
        if (nextCursor !== null) seenCursors.add(nextCursor);
        rows.push(...page); if (page.length === 0 || (isObject(value) && value.hasMore === false)) return rows;
      }
      throw new Error(`Cadence ${name} exceeded the ${MAX_PROVIDER_PAGES}-page limit`);
    };
    const snapshot: Record<string, unknown> = { exported_at: new Date().toISOString(), workspace: await call('workspace_metadata', {}) };
    snapshot.groups = await family('people_read', { method: 'list_groups' });
    snapshot.priorities = await family('rock_read', { method: 'list' });
    snapshot.projects = await family('project_read', { method: 'list' });
    snapshot.measurables = await family('measurable_read', { method: 'list' });
    snapshot.tasks = await family('task_read', { method: 'list' });
    snapshot.aor_updates = await family('people_read', { method: 'list_aor_updates', days: 30 });
    if (config.target === 'personnel') {
      snapshot.people = await family('people_read', { method: 'list_people', account: config.account ?? 'ceo' });
      snapshot.checkins = await family('checkin_read', { method: 'latest_all', account: config.account ?? 'ceo', cursor });
      snapshot.pulse_reflections = await family('pulse_read', { method: 'list', account: config.account ?? 'ceo', cursor });
    }
    return { snapshot, nextCursor: new Date().toISOString() };
  } };
}

export async function runCadenceSync(
  engine: BrainEngine,
  sourceId: string,
  cfg: CadenceSourceConfig,
  opts: SyncOpts,
  deps: CadenceSyncDeps = {},
): Promise<SyncResult> {
  if (cfg.target === 'personnel' && cfg.personnelTarget !== 'ceo') throw new Error('Cadence personnel sync denied: only explicit CEO target is permitted');
  const state = readCadenceState(cfg.dir);
  let result: CadenceReadResult;
  if (cfg.snapshotPath) result = { snapshot: JSON.parse((deps.readFile ?? ((path) => readFileSync(path, 'utf8')))(cfg.snapshotPath)), nextCursor: state.cursor };
  else result = await (deps.provider ?? createCadenceProvider()).read(cfg, state.cursor, { signal: opts.signal });
  const raw = result.snapshot;
  if (!isObject(raw) || typeof raw.exported_at !== 'string') throw new Error('Cadence provider returned an invalid complete snapshot');
  const records = recordsForTarget(raw, cfg.target);
  const fingerprint = computeContentHash(canonicalJson({ exported_at: raw.exported_at, records }));
  if (fingerprint === state.fingerprint) return { status: 'up_to_date', fromCommit: state.cursor, toCommit: result.nextCursor ?? state.cursor ?? '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
  let added = 0, modified = 0, chunksCreated = 0; const pagesAffected: string[] = [];
  for (const record of records) {
    const slug = `cadence/${cfg.target}/${record.family}/${record.id}`;
    const existing = await findCadencePage(engine, slug, sourceId);
    const imported = await importFromContent(engine, slug, cadenceMarkdown(record, raw.exported_at), { noEmbed: opts.noEmbed ?? true, sourceId, sourcePath: `${record.family}/${record.id}.md` });
    if (imported.status === 'error') throw new Error(imported.error ?? `Cadence import failed for ${slug}`);
    if (imported.status === 'imported') { pagesAffected.push(imported.slug); chunksCreated += imported.chunks; if (existing.length) modified++; else added++; }
  }
  // Cursor/fingerprint is committed only after every page import succeeds.
  writeCadenceState(cfg.dir, { cursor: result.nextCursor ?? state.cursor, fingerprint });
  return { status: 'synced', fromCommit: state.cursor, toCommit: result.nextCursor ?? state.cursor ?? '', added, modified, deleted: 0, renamed: 0, chunksCreated, embedded: 0, pagesAffected };
}
