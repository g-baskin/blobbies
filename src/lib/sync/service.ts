/** Sync orchestration: pairing, secrets, status, one-at-a-time sync passes. Keep free of heavy deps. */
import { deleteSecret, getSecret, setSecret } from "@/lib/secrets";
import {
  backupData,
  flushPendingWrites,
  listSliceKeys,
  readSlice,
  writeSliceNow,
} from "@/lib/store";
import { generateSyncKey } from "./crypto";
import { syncOnce } from "./engine";
import { setSyncConfiguredFlag } from "./flag";
import { createS3Store, parseS3Config } from "./s3";
import type { LocalStore, RemoteStore, SyncState, SyncStateStore } from "./types";

export type ProviderId = "gdrive" | "s3" | "dropbox";
export interface RemoteConfig {
  provider: ProviderId;
  [field: string]: unknown;
}
export interface SyncStatus {
  state: "off" | "idle" | "syncing" | "error";
  provider: ProviderId | null;
  lastSyncedAt: number | null;
  error: string | null;
  /** remote changes were written locally while the app was running; the UI should offer a refresh */
  pendingRefresh: boolean;
}

const PROVIDERS: readonly ProviderId[] = ["gdrive", "s3", "dropbox"];
const PROVIDER_NAMES: Record<ProviderId, string> = {
  gdrive: "Google Drive",
  s3: "S3 storage",
  dropbox: "Dropbox",
};
const LINK_PREFIX = "blobbies://pair#";
const MAX_LINK = 4096;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const INIT_TIMEOUT_MS = 4000;
const AUTO_INTERVAL_MS = 3 * 60_000;
const STATE_SLICE = "sync";

const factories = new Map<ProviderId, (config: RemoteConfig) => RemoteStore>([
  ["s3", (config) => createS3Store(parseS3Config(config))],
]);
const listeners = new Set<(status: SyncStatus) => void>();
let status: SyncStatus = {
  state: "off",
  provider: null,
  lastSyncedAt: null,
  error: null,
  pendingRefresh: false,
};
let keyB64: string | null = null;
let remoteConfig: RemoteConfig | null = null;
let running: Promise<void> | null = null;

class SyncError extends Error {}

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSync(listener: (status: SyncStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerProvider(
  id: ProviderId,
  factory: (config: RemoteConfig) => RemoteStore,
): void {
  factories.set(id, factory);
}

export function isSyncConfigured(): boolean {
  return keyB64 !== null && remoteConfig !== null;
}

export function clearPendingRefresh(): void {
  if (status.pendingRefresh) setStatus({ pendingRefresh: false });
}

// ---------------------------------------------------------------- pair links

function b64urlFromString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stringFromB64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(out);
}

function isRemoteConfig(v: unknown): v is RemoteConfig {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    PROVIDERS.includes((v as { provider?: unknown }).provider as ProviderId)
  );
}

function buildLink(key: string, remote: RemoteConfig): string {
  return LINK_PREFIX + b64urlFromString(JSON.stringify({ v: 1, key, remote }));
}

export function parsePairLink(url: string): { key: string; remote: RemoteConfig } | null {
  if (typeof url !== "string" || url.length >= MAX_LINK || !url.startsWith(LINK_PREFIX)) {
    return null;
  }
  const payload = url.slice(LINK_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const parsed = JSON.parse(stringFromB64url(payload)) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { v, key, remote } = parsed as { v?: unknown; key?: unknown; remote?: unknown };
    if (v !== 1 || typeof key !== "string" || !KEY_RE.test(key) || !isRemoteConfig(remote)) {
      return null;
    }
    return { key, remote };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- stores

interface StoredState extends SyncState {
  deviceId?: string;
  backedUp?: boolean;
}

async function loadStored(): Promise<StoredState | null> {
  const v = await readSlice(STATE_SLICE);
  return typeof v === "object" && v !== null ? (v as StoredState) : null;
}

const stateStore: SyncStateStore = {
  load: async () => {
    const s = await loadStored();
    return s?.slices ? { slices: s.slices } : null;
  },
  save: async (s) => {
    const prev = (await loadStored()) ?? { slices: {} };
    await writeSliceNow(STATE_SLICE, { ...prev, slices: s.slices });
  },
};

const localStore: LocalStore = {
  list: () => listSliceKeys(),
  read: async (key) => (await readSlice(key)) ?? null,
  write: (key, value) => writeSliceNow(key, value),
};

/** deviceId (created once) and one backup before this device's first sync. */
async function prepareDevice(): Promise<string> {
  const prev = (await loadStored()) ?? { slices: {} };
  const next: StoredState = { ...prev, slices: prev.slices ?? {} };
  if (!next.deviceId) next.deviceId = crypto.randomUUID();
  if (!next.backedUp) {
    await backupData();
    next.backedUp = true;
  }
  if (next.deviceId !== prev.deviceId || next.backedUp !== prev.backedUp) {
    await writeSliceNow(STATE_SLICE, next);
  }
  return next.deviceId;
}

// ---------------------------------------------------------------- syncing

function errorMessage(e: unknown): string {
  return e instanceof SyncError ? e.message : "Couldn't reach the sync storage";
}

async function runPass(): Promise<void> {
  const key = keyB64;
  const config = remoteConfig;
  if (!key || !config) return;
  setStatus({ state: "syncing", error: null });
  try {
    const factory = factories.get(config.provider);
    if (!factory) {
      throw new SyncError(`Sync storage not set up for ${PROVIDER_NAMES[config.provider]} yet`);
    }
    let remote: RemoteStore;
    try {
      remote = factory(config);
    } catch (e) {
      // Config validation messages are short and secret-free by design.
      throw new SyncError(e instanceof Error ? e.message : "Sync storage settings are invalid");
    }
    await flushPendingWrites();
    const deviceId = await prepareDevice();
    const result = await syncOnce({
      local: localStore,
      remote,
      state: stateStore,
      keyB64: key,
      deviceId,
      now: Date.now,
    });
    setStatus({
      state: "idle",
      lastSyncedAt: Date.now(),
      error: null,
      pendingRefresh: status.pendingRefresh || result.pulled.length > 0,
    });
  } catch (e) {
    setStatus({ state: "error", error: errorMessage(e) });
  }
}

export function syncNow(): Promise<void> {
  if (!running) {
    running = runPass().finally(() => {
      running = null;
    });
  }
  return running;
}

async function loadConfig(): Promise<void> {
  const [key, remoteRaw] = await Promise.all([getSecret("sync-key"), getSecret("sync-remote")]);
  let remote: unknown = null;
  try {
    remote = remoteRaw ? JSON.parse(remoteRaw) : null;
  } catch {
    remote = null;
  }
  if (key && KEY_RE.test(key) && isRemoteConfig(remote)) {
    applyConfig(key, remote);
  } else {
    applyConfig(null, null);
  }
}

function applyConfig(key: string | null, remote: RemoteConfig | null): void {
  keyB64 = key;
  remoteConfig = remote;
  setSyncConfiguredFlag(key !== null && remote !== null);
  if (key && remote) {
    setStatus({ state: status.state === "off" ? "idle" : status.state, provider: remote.provider });
  } else {
    setStatus({ state: "off", provider: null, error: null, lastSyncedAt: null });
  }
}

export async function initSync(): Promise<void> {
  try {
    await loadConfig();
  } catch {
    return;
  }
  if (!isSyncConfigured()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    syncNow(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, INIT_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}

export function startAutoSync(): () => void {
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const interval = setInterval(() => {
    if (visible() && isSyncConfigured()) void syncNow();
  }, AUTO_INTERVAL_MS);
  const onVisibility = () => {
    if (visible() && isSyncConfigured()) void syncNow();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    clearInterval(interval);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

async function storeAndSync(key: string, remote: RemoteConfig): Promise<void> {
  await setSecret("sync-key", key);
  await setSecret("sync-remote", JSON.stringify(remote));
  applyConfig(key, remote);
  await syncNow();
}

export async function createPairing(remote: RemoteConfig): Promise<{ link: string }> {
  if (!isRemoteConfig(remote)) throw new Error("Unknown sync storage provider");
  const key = generateSyncKey();
  const link = buildLink(key, remote);
  if (link.length >= MAX_LINK) throw new Error("Sync storage settings are too large to pair");
  // Try the first sync with the config held only in memory; secrets are stored only once it works.
  await running;
  applyConfig(key, remote);
  await syncNow();
  if (status.state === "error") {
    const message = status.error ?? "Couldn't reach the sync storage";
    applyConfig(null, null);
    throw new Error(message);
  }
  await setSecret("sync-key", key);
  await setSecret("sync-remote", JSON.stringify(remote));
  return { link };
}

export async function currentPairingLink(): Promise<string | null> {
  if (!isSyncConfigured()) await loadConfig();
  return keyB64 && remoteConfig ? buildLink(keyB64, remoteConfig) : null;
}

export async function acceptPairing(url: string): Promise<void> {
  const parsed = parsePairLink(url);
  if (!parsed) throw new Error("That pairing link isn't valid");
  await storeAndSync(parsed.key, parsed.remote);
}

export async function unpair(): Promise<void> {
  await running;
  await deleteSecret("sync-key");
  await deleteSecret("sync-remote");
  applyConfig(null, null);
  setStatus({ pendingRefresh: false });
}
