import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStore } from "./types";

interface Device {
  secrets: Map<string, string>;
  slices: Map<string, unknown>;
  backups: number;
}
const h = vi.hoisted(() => ({
  device: null as unknown as Device,
}));

vi.mock("@/lib/secrets", () => ({
  getSecret: async (n: string) => h.device.secrets.get(n) ?? null,
  setSecret: async (n: string, v: string) => void h.device.secrets.set(n, v),
  deleteSecret: async (n: string) => void h.device.secrets.delete(n),
}));
vi.mock("@/lib/store", () => ({
  listSliceKeys: async () => [...h.device.slices.keys()].sort(),
  readSlice: async (k: string) => structuredClone(h.device.slices.get(k) ?? null),
  writeSliceNow: async (k: string, v: unknown) => void h.device.slices.set(k, structuredClone(v)),
  flushPendingWrites: async () => {},
  backupData: async () => {
    h.device.backups++;
    return "/backup";
  },
}));

function newDevice(slices: Record<string, unknown> = {}): Device {
  return { secrets: new Map(), slices: new Map(Object.entries(slices)), backups: 0 };
}

function memoryRemote() {
  const objects = new Map<string, { bytes: Uint8Array; version: string }>();
  let n = 0;
  let offline = false;
  const store: RemoteStore = {
    async get(name) {
      if (offline) throw new Error("network down secret-token");
      return objects.get(name) ?? null;
    },
    async put(name, bytes, ifVersion) {
      if (offline) throw new Error("network down");
      const cur = objects.get(name);
      if (ifVersion === null && cur) return "conflict";
      if (typeof ifVersion === "string" && cur?.version !== ifVersion) return "conflict";
      const version = String(++n);
      objects.set(name, { bytes, version });
      return { version };
    },
  };
  return { store, objects, setOffline: (v: boolean) => (offline = v) };
}

async function freshService() {
  vi.resetModules();
  return import("./service");
}

const KEY = "A".repeat(43);

describe("pair links", () => {
  it("round-trips and rejects malformed or oversized links", async () => {
    const s = await freshService();
    const payload = (o: unknown) =>
      `blobbies://pair#${btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const ok = payload({ v: 1, key: KEY, remote: { provider: "s3", bucket: "b" } });
    expect(s.parsePairLink(ok)).toEqual({ key: KEY, remote: { provider: "s3", bucket: "b" } });
    expect(s.parsePairLink("blobbies://pair#!!")).toBeNull();
    expect(s.parsePairLink("https://x#abc")).toBeNull();
    expect(s.parsePairLink(payload({ v: 2, key: KEY, remote: { provider: "s3" } }))).toBeNull();
    expect(s.parsePairLink(payload({ v: 1, key: "short", remote: { provider: "s3" } }))).toBeNull();
    expect(s.parsePairLink(payload({ v: 1, key: KEY, remote: { provider: "ftp" } }))).toBeNull();
    expect(
      s.parsePairLink(
        payload({ v: 1, key: KEY, remote: { provider: "s3", pad: "x".repeat(4000) } }),
      ),
    ).toBeNull();
  });
});

describe("pairing and syncing", () => {
  let remote: ReturnType<typeof memoryRemote>;
  beforeEach(() => {
    remote = memoryRemote();
  });

  it("createPairing → acceptPairing moves data, pendingRefresh only on pull", async () => {
    h.device = newDevice({ roster: [{ id: "a" }], settings: { theme: "dark" } });
    const a = await freshService();
    a.registerProvider("s3", () => remote.store);
    const { link } = await a.createPairing({ provider: "s3", bucket: "b" });
    expect(a.getSyncStatus()).toMatchObject({ state: "idle", provider: "s3", error: null });
    expect(a.getSyncStatus().pendingRefresh).toBe(false);
    expect(h.device.backups).toBe(1);
    expect(await a.currentPairingLink()).toBe(link);
    const deviceA = h.device;
    const deviceIdA = (deviceA.slices.get("sync") as { deviceId: string }).deviceId;
    expect(deviceIdA).toMatch(/-/);

    h.device = newDevice();
    const b = await freshService();
    b.registerProvider("s3", () => remote.store);
    await b.acceptPairing(link);
    expect(h.device.slices.get("roster")).toEqual([{ id: "a" }]);
    expect(h.device.slices.has("settings")).toBe(false);
    expect(h.device.backups).toBe(1);
    expect(b.getSyncStatus().pendingRefresh).toBe(true);
    b.clearPendingRefresh();
    await b.syncNow();
    expect(b.getSyncStatus().pendingRefresh).toBe(false);
    expect(h.device.backups).toBe(1);

    h.device.slices.set("roster", [{ id: "a" }, { id: "b" }]);
    await b.syncNow();
    expect(b.getSyncStatus().pendingRefresh).toBe(false);

    h.device = deviceA;
    await a.syncNow();
    expect(deviceA.slices.get("roster")).toEqual([{ id: "a" }, { id: "b" }]);
    expect(a.getSyncStatus().pendingRefresh).toBe(true);

    await a.unpair();
    expect(a.isSyncConfigured()).toBe(false);
    expect(a.getSyncStatus().state).toBe("off");
    expect(await a.currentPairingLink()).toBeNull();
  });

  it("concurrent syncNow calls join one pass", async () => {
    h.device = newDevice({ roster: [] });
    const s = await freshService();
    const get = vi.fn(remote.store.get);
    s.registerProvider("s3", () => ({ ...remote.store, get }));
    await s.createPairing({ provider: "s3" });
    get.mockClear();
    const p1 = s.syncNow();
    const p2 = s.syncNow();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    const once = get.mock.calls.length;
    await s.syncNow();
    expect(get.mock.calls.length).toBe(once * 2);
  });

  it("maps errors to short status messages", async () => {
    h.device = newDevice({ roster: [] });
    const s = await freshService();
    await expect(s.createPairing({ provider: "gdrive" })).rejects.toThrow(
      "Sync storage not set up for Google Drive yet",
    );
    expect(h.device.secrets.size).toBe(0);
    expect(s.isSyncConfigured()).toBe(false);
    s.registerProvider("gdrive", () => remote.store);
    remote.setOffline(true);
    await expect(s.createPairing({ provider: "gdrive" })).rejects.toThrow(
      "Couldn't reach the sync storage",
    );
    expect(h.device.secrets.size).toBe(0);
    remote.setOffline(false);
    await s.createPairing({ provider: "gdrive" });
    expect(h.device.secrets.has("sync-key")).toBe(true);
    remote.setOffline(true);
    await s.syncNow();
    expect(s.getSyncStatus()).toMatchObject({
      state: "error",
      error: "Couldn't reach the sync storage",
    });
    remote.setOffline(false);
    await s.syncNow();
    expect(s.getSyncStatus()).toMatchObject({ state: "idle", error: null });
  });

  it("s3 is built in and a bad config throws a short message without storing secrets", async () => {
    h.device = newDevice({ roster: [] });
    const s = await freshService();
    await expect(s.createPairing({ provider: "s3", endpoint: "http://x" })).rejects.toThrow(
      "Endpoint must use https",
    );
    expect(h.device.secrets.size).toBe(0);
    expect(s.getSyncStatus().state).toBe("off");
  });

  it("initSync loads config from secrets and syncs", async () => {
    h.device = newDevice({ roster: [] });
    h.device.secrets.set("sync-key", KEY);
    h.device.secrets.set("sync-remote", JSON.stringify({ provider: "dropbox" }));
    const s = await freshService();
    s.registerProvider("dropbox", () => remote.store);
    await s.initSync();
    expect(s.isSyncConfigured()).toBe(true);
    expect(s.getSyncStatus().lastSyncedAt).not.toBeNull();
  });
});
