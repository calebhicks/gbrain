/** Native Granola provider and retained mirror-bootstrap contracts. */
export interface GranolaManifest { schema?: string; as_of?: string; complete?: boolean; files?: { notes?: string; deletes?: string }; }
export type GranolaAccessMode = 'vault' | 'env' | 'command';
export interface GranolaSourceConfig {
  mirrorDir: string;
  dir: string;
  batchSize: number;
  account?: string;
  target?: 'ceo';
  apiBase?: string;
  access?: GranolaAccessMode;
  credentialId?: string;
  tokenEnv?: string;
  tokenCommand?: string;
}
export type GranolaDisposition = 'imported' | 'thin' | 'revoked' | 'excluded';
export interface GranolaAccessEntry { first_access_seen_at: string; provider_created_at?: string; provider_updated_at?: string; disposition: GranolaDisposition; }
export interface GranolaSourceState { cursor: string | null; access_ledger: Record<string, GranolaAccessEntry>; last_complete_reconcile_at: string | null; }
export interface GranolaNote {
  id: string; title?: string; created_at?: string; updated_at?: string; web_url?: string;
  attendees?: Array<{ name?: string; email?: string }>;
  transcript?: Array<{ speaker?: string | { name?: string }; text?: string }>;
  summary_markdown?: string; access_revoked?: boolean;
  owner?: { name?: string; email?: string }; calendar_event?: Record<string, unknown>;
  folder_membership?: unknown[];
}
export interface RenderedGranolaPage { relPath: string; slug: string; markdown: string; id: string; }
