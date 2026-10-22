import { describe, expect, it } from "vitest";
import { generateSyncKey } from "@/lib/sync/crypto";
import { syncOnce } from "@/lib/sync/engine";
import { createS3Store, parseS3Config, type S3Config, signRequest } from "@/lib/sync/s3";
import type { LocalStore, SyncState, SyncStateStore } from "@/lib/sync/types";

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("signRequest", () => {
  it("matches AWS's GET Object example", async () => {
    const { signature, headers } = await signRequest({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY_HASH,
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(headers.authorization).toContain(
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date",
    );
  });
});

function fakeS3() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const urls: string[] = [];
  let n = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const h = new Headers(init?.headers);
    expect(h.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    const key = new URL(url).pathname;
    const cur = objects.get(key);
    const method = init?.method ?? "GET";
    if (method === "GET" || method === "HEAD") {
      if (!cur) return new Response(null, { status: 404 });
      return new Response(method === "GET" ? (cur.bytes as BodyInit) : null, {
        status: 200,
        headers: { etag: cur.etag },
      });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (h.get("if-none-match") === "*" && cur) return new Response(null, { status: 412 });
    const im = h.get("if-match");
    if (im !== null && cur?.etag !== im) return new Response(null, { status: 412 });
    const etag = `"e${++n}"`;
    objects.set(key, { bytes: new Uint8Array(init?.body as Uint8Array), etag });
    return new Response(null, { status: 200, headers: { etag } });
  }) as typeof fetch;
  return { impl, objects, urls };
}

const cfg: S3Config = {
  provider: "s3",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "my-bucket",
  region: "auto",
  accessKeyId: "AK",
  secretAccessKey: "SK",
};

describe("createS3Store", () => {
  it("round-trips and honours conditional writes", async () => {
    const f = fakeS3();
    const s = createS3Store(cfg, f.impl);
    expect(await s.get("a")).toBeNull();
    const p = await s.put("a", new Uint8Array([1, 2]), null);
    expect(p).toEqual({ version: '"e1"' });
    expect(await s.put("a", new Uint8Array([3]), null)).toBe("conflict");
    const got = await s.get("a");
    expect(Array.from(got?.bytes ?? [])).toEqual([1, 2]);
    expect(got?.version).toBe('"e1"');
    expect(await s.put("a", new Uint8Array([4]), '"e1"')).toEqual({ version: '"e2"' });
    expect(await s.put("a", new Uint8Array([5]), '"e1"')).toBe("conflict");
    expect(await s.put("a", new Uint8Array([6]))).toEqual({ version: '"e3"' });
    await s.delete?.("a");
    expect(await s.get("a")).toBeNull();
  });

  it("encodes the prefix and name in the URL", async () => {
    const f = fakeS3();
    const s = createS3Store({ ...cfg, prefix: "my sync/dir" }, f.impl);
    await s.get("x y+z");
    expect(f.urls[0]).toBe(
      "https://acct.r2.cloudflarestorage.com/my-bucket/my%20sync/dir/x%20y%2Bz",
    );
    await createS3Store(cfg, f.impl).get("n");
    expect(f.urls[1]).toBe("https://acct.r2.cloudflarestorage.com/my-bucket/blobbies-sync/n");
  });

  it("falls back to HEAD when PUT has no ETag, and throws without secrets", async () => {
    const impl = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(null, { status: 200 })
        : init?.method === "HEAD"
          ? new Response(null, { status: 200, headers: { etag: '"h"' } })
          : new Response(null, { status: 500 })) as typeof fetch;
    const s = createS3Store(cfg, impl);
    expect(await s.put("a", new Uint8Array([1]))).toEqual({ version: '"h"' });
    await expect(s.get("a")).rejects.toThrow(/HTTP 500/);
    await expect(s.get("a")).rejects.not.toThrow(/SK|AK/);
  });
});

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
    return this.s;
  }
  async save(s: SyncState) {
    this.s = structuredClone(s);
  }
}

describe("S3 + syncOnce", () => {
  it("syncs between two devices", async () => {
    const f = fakeS3();
    const remote = createS3Store(cfg, f.impl);
    const keyB64 = await generateSyncKey();
    const mk = (deviceId: string) => {
      const local = new MemLocal();
      const state = new MemState();
      return {
        local,
        sync: () => syncOnce({ local, remote, state, keyB64, deviceId, now: () => 1 }),
      };
    };
    const a = mk("a");
    const b = mk("b");
    await a.local.write("roster", [{ id: "x" }]);
    expect((await a.sync()).pushed).toEqual(["roster"]);
    expect((await b.sync()).pulled).toEqual(["roster"]);
    expect(await b.local.read("roster")).toEqual([{ id: "x" }]);
    for (const o of f.objects.values())
      expect(new TextDecoder().decode(o.bytes)).not.toContain('x"');
  });
});

describe("parseS3Config", () => {
  const ok = { ...cfg, prefix: "/p/q/" };
  it("normalizes", () => {
    const c = parseS3Config({ ...ok, endpoint: "https://h.example/", region: "" });
    expect(c.endpoint).toBe("https://h.example");
    expect(c.region).toBe("auto");
    expect(c.prefix).toBe("p/q");
    expect(parseS3Config({ ...ok, endpoint: "http://127.0.0.1:9000" }).endpoint).toBe(
      "http://127.0.0.1:9000",
    );
  });
  it("rejects bad input", () => {
    expect(() => parseS3Config({ ...ok, endpoint: "http://h.example" })).toThrow(/https/);
    expect(() => parseS3Config({ ...ok, bucket: "Bad_Bucket" })).toThrow(/Bucket/);
    expect(() => parseS3Config({ ...ok, bucket: "ab" })).toThrow(/Bucket/);
    expect(() => parseS3Config({ ...ok, accessKeyId: "" })).toThrow(/Access key/);
    expect(() => parseS3Config({ ...ok, secretAccessKey: undefined })).toThrow(/Secret/);
  });
});
