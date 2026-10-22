import { describe, expect, it } from "vitest";
import { decrypt, encodeJson, encrypt, generateSyncKey, objectName } from "@/lib/sync/crypto";

describe("sync crypto", () => {
  it("round-trips and uses fresh IVs", async () => {
    const key = generateSyncKey();
    const pt = encodeJson({ hello: "wörld" });
    const a = await encrypt(key, pt);
    const b = await encrypt(key, pt);
    expect(a[0]).toBe(1);
    expect(a).not.toEqual(b);
    expect(Array.from(await decrypt(key, a))).toEqual(Array.from(pt));
  });

  it("rejects tampering and wrong keys", async () => {
    const key = generateSyncKey();
    const ct = await encrypt(key, encodeJson("secret"));
    const bad = ct.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    await expect(decrypt(key, bad)).rejects.toThrow();
    await expect(decrypt(generateSyncKey(), ct)).rejects.toThrow();
  });

  it("derives stable opaque names", async () => {
    const key = generateSyncKey();
    const n = await objectName(key, "blobs/abc/transcript");
    expect(n).toMatch(/^[0-9a-f]{64}$/);
    expect(n).toBe(await objectName(key, "blobs/abc/transcript"));
    expect(n).not.toBe(await objectName(generateSyncKey(), "blobs/abc/transcript"));
  });
});
