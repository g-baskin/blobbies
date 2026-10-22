import { describe, expect, it } from "vitest";
import { generateSyncKey } from "@/lib/sync/crypto";
import { syncOnce } from "@/lib/sync/engine";
import type { LocalStore, RemoteStore, SyncState, SyncStateStore } from "@/lib/sync/types";
import { isSyncedKey } from "@/lib/sync/types";

class MemRemote implements RemoteStore {
  objects = new Map<string, { bytes: Uint8Array; version: string }>();
  n = 0;
  async get(name: string) {
    return this.objects.get(name) ?? null;
  }
  async put(name: string, bytes: Uint8Array, ifVersion?: string | null) {
    const cur = this.objects.get(name);
    if (ifVersion === null && cur) return "conflict" as const;
    if (ifVersion && cur?.version !== ifVersion) return "conflict" as const;
    const version = String(++this.n);
    this.objects.set(name, { bytes, version });
    return { version };
  }
}

class MemLocal implements LocalStore {
  data = new Map<string, unknown>();
  async list() {
    return [...this.data.keys()];
  }
  async read(key: string) {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : null;
  }
  async write(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
}

class MemState implements SyncStateStore {
  s: SyncState | null = null;
  async load() {
    return this.s ? structuredClone(this.s) : null;
  }
  async save(s: SyncState) {
    this.s = structuredClone(s);
  }
}

const msg = (id: string, createdAt: number, text: string) => ({
  id,
  kind: "text",
  author: "user",
  segments: [text],
  createdAt,
});

function device(remote: RemoteStore, keyB64: string, deviceId: string) {
  const local = new MemLocal();
  const state = new MemState();
  return { local, sync: () => syncOnce({ local, remote, state, keyB64, deviceId, now: () => 1 }) };
}

describe("syncOnce", () => {
  it("syncs computer → phone, keeps device-local slices home, never leaks plaintext", async () => {
    const remote = new MemRemote();
    const key = generateSyncKey();
    const pc = device(remote, key, "pc");
    const phone = device(remote, key, "phone");
    pc.local.data.set("roster", [{ id: "blob-1", name: "Pip" }]);
    pc.local.data.set("blobs/blob-1/transcript", [msg("m1", 1, "SECRET-MARKER-123")]);
    pc.local.data.set("blobs/blob-1/transcript-1", [msg("m0", 0, "old")]);
    pc.local.data.set("settings", { apiKey: "sk-LOCALONLY" });
    pc.local.data.set("blobs/blob-1/runs", [{ id: "r" }]);

    const r = await pc.sync();
    expect(r.pushed.sort()).toEqual([
      "blobs/blob-1/transcript",
      "blobs/blob-1/transcript-1",
      "roster",
    ]);
    await phone.sync();
    expect(await phone.local.read("blobs/blob-1/transcript")).toEqual([
      msg("m1", 1, "SECRET-MARKER-123"),
    ]);
    expect(await phone.local.read("roster")).toEqual([{ id: "blob-1", name: "Pip" }]);
    expect(await phone.local.read("settings")).toBeNull();
    expect(await phone.local.read("blobs/blob-1/runs")).toBeNull();

    const dump = [...remote.objects.entries()]
      .map(([n, o]) => n + new TextDecoder("latin1").decode(o.bytes))
      .join();
    for (const needle of ["SECRET-MARKER", "sk-LOCALONLY", "blob-1", "Pip", "transcript", key]) {
      expect(dump).not.toContain(needle);
    }
  });

  it("converges after concurrent offline additions", async () => {
    const remote = new MemRemote();
    const key = generateSyncKey();
    const pc = device(remote, key, "pc");
    const phone = device(remote, key, "phone");
    const k = "groups/g1/transcript";
    pc.local.data.set(k, [msg("a", 1, "hi")]);
    await pc.sync();
    await phone.sync();
    pc.local.data.set(k, [msg("a", 1, "hi"), msg("c", 3, "from pc")]);
    phone.local.data.set(k, [msg("a", 1, "hi"), msg("p", 2, "from phone")]);
    await pc.sync();
    const r = await phone.sync();
    expect(r.conflicts).toBe(1);
    await pc.sync();
    await phone.sync();
    const want = [msg("a", 1, "hi"), msg("p", 2, "from phone"), msg("c", 3, "from pc")];
    expect(await pc.local.read(k)).toEqual(want);
    expect(await phone.local.read(k)).toEqual(want);
    expect((await pc.sync()).pushed).toEqual([]);
  });

  it("classifies keys", () => {
    for (const k of [
      "roster",
      "user",
      "groups",
      "blobs/x/config",
      "blobs/x/transcript-2",
      "groups/u/recap",
    ]) {
      expect(isSyncedKey(k)).toBe(true);
    }
    for (const k of ["settings", "ui-layout", "acp", "drafts", "blobs/x/runs", "groups/u/config"]) {
      expect(isSyncedKey(k)).toBe(false);
    }
  });
});
