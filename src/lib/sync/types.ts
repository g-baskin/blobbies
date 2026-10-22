/** Provider-agnostic contracts for end-to-end encrypted sync. */

export interface RemoteStore {
  get(name: string): Promise<{ bytes: Uint8Array; version: string } | null>;
  /** `ifVersion: null` = create-only; `undefined` = unconditional. */
  put(
    name: string,
    bytes: Uint8Array,
    ifVersion?: string | null,
  ): Promise<{ version: string } | "conflict">;
  delete?(name: string): Promise<void>;
}

export interface LocalStore {
  list(): Promise<string[]>;
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
}

export interface SliceBase {
  /** Hash of the value both sides last agreed on. */
  hash: string;
  /** That agreed value: the merge base. */
  value: unknown;
}

export interface SyncState {
  slices: Record<string, SliceBase>;
}

export interface SyncStateStore {
  load(): Promise<SyncState | null>;
  save(s: SyncState): Promise<void>;
}

export interface ManifestEntry {
  name: string;
  hash: string;
  updatedAt: number;
  deviceId: string;
  deleted?: boolean;
}

export interface Manifest {
  v: 1;
  entries: Record<string, ManifestEntry>;
}

const ROOT_SYNCED = new Set(["roster", "user", "groups"]);
const PER_ITEM = new Set(["config", "routines", "transcript", "recap", "activity"]);
const GROUP_ITEM = new Set(["transcript", "recap"]);

/** True for slices that travel between devices; device-local ones (settings, ui-layout, acp, drafts, runs) never do. */
export function isSyncedKey(key: string): boolean {
  if (ROOT_SYNCED.has(key)) return true;
  const parts = key.split("/");
  if (parts.length !== 3 || !parts[1]) return false;
  const scope = parts[0];
  const leaf = parts[2] ?? "";
  const base = leaf.replace(/-\d+$/, "");
  const archive = base !== leaf;
  if (scope === "blobs") return PER_ITEM.has(leaf) || (archive && base === "transcript");
  if (scope === "groups") return GROUP_ITEM.has(leaf) || (archive && base === "transcript");
  return false;
}
