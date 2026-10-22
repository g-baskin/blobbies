/**
 * One sync pass. Remote layout: an encrypted manifest (name = objectName(key, "__manifest"))
 * plus one encrypted object per slice. The provider sees only opaque hex names and ciphertext.
 *
 * v1 limits: remote deletions never delete local files; an array slice is emptied instead,
 * object slices are left as-is. Slice objects are written unconditionally; the manifest put
 * (ifVersion CAS) is the commit point and a lost race re-runs the whole pass (max 3 tries).
 */
import { decodeJson, decrypt, encodeJson, encrypt, objectName } from "./crypto";
import { canonical, merge3 } from "./merge";
import type { LocalStore, Manifest, RemoteStore, SyncState, SyncStateStore } from "./types";
import { isSyncedKey } from "./types";

export interface SyncOptions {
  local: LocalStore;
  remote: RemoteStore;
  state: SyncStateStore;
  keyB64: string;
  deviceId: string;
  now: () => number;
}

export interface SyncResult {
  pulled: string[];
  pushed: string[];
  conflicts: number;
}

export const MANIFEST_KEY = "__manifest";
const MAX_TRIES = 3;

export async function hashJson(v: unknown): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(v)));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readManifest(
  o: SyncOptions,
  name: string,
): Promise<{ m: Manifest; version: string | null }> {
  const got = await o.remote.get(name);
  if (!got) return { m: { v: 1, entries: {} }, version: null };
  return { m: decodeJson(await decrypt(o.keyB64, got.bytes)) as Manifest, version: got.version };
}

export async function syncOnce(o: SyncOptions): Promise<SyncResult> {
  const manifestName = await objectName(o.keyB64, MANIFEST_KEY);
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const state: SyncState = (await o.state.load()) ?? { slices: {} };
    const { m, version } = await readManifest(o, manifestName);
    const result: SyncResult = { pulled: [], pushed: [], conflicts: 0 };
    const localKeys = (await o.local.list()).filter(isSyncedKey);
    const keys = [...new Set([...localKeys, ...Object.keys(m.entries).filter(isSyncedKey)])].sort();
    let manifestDirty = false;

    for (const key of keys) {
      const localVal = await o.local.read(key);
      const localHash = localVal === null ? null : await hashJson(localVal);
      const base = state.slices[key];
      const entry = m.entries[key];
      const remoteHash = entry ? (entry.deleted ? "deleted" : entry.hash) : null;
      const localChanged = localHash !== (base?.hash ?? null);
      const remoteChanged = remoteHash !== null && remoteHash !== (base?.hash ?? null);

      if (!localChanged && !remoteChanged) continue;

      if (entry?.deleted && !localChanged) {
        if (Array.isArray(localVal) && localVal.length > 0) await o.local.write(key, []);
        state.slices[key] = { hash: "deleted", value: null };
        continue;
      }

      let remoteVal: unknown = null;
      if (remoteChanged && entry && !entry.deleted) {
        const got = await o.remote.get(entry.name);
        if (got) remoteVal = decodeJson(await decrypt(o.keyB64, got.bytes));
      }

      let next: unknown;
      if (!localChanged) next = remoteVal;
      else if (!remoteChanged || remoteVal === null) next = localVal;
      else {
        const baseVal = base && base.hash !== "deleted" ? base.value : null;
        next = merge3(baseVal, localVal, remoteVal, true);
        result.conflicts++;
      }
      if (next === null) continue;
      const nextHash = await hashJson(next);

      if (nextHash !== localHash) {
        await o.local.write(key, next);
        result.pulled.push(key);
      }
      if (nextHash !== remoteHash) {
        const name = await objectName(o.keyB64, key);
        const put = await o.remote.put(name, await encrypt(o.keyB64, encodeJson(next)));
        if (put === "conflict") throw new Error(`unconditional put of ${key} reported conflict`);
        m.entries[key] = { name, hash: nextHash, updatedAt: o.now(), deviceId: o.deviceId };
        manifestDirty = true;
        result.pushed.push(key);
      }
      state.slices[key] = { hash: nextHash, value: next };
    }

    if (manifestDirty) {
      const put = await o.remote.put(manifestName, await encrypt(o.keyB64, encodeJson(m)), version);
      if (put === "conflict") continue; // someone else committed; redo against their manifest
    }
    await o.state.save(state);
    return result;
  }
  throw new Error("sync: manifest kept changing; try again later");
}
