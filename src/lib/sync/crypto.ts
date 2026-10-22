/** WebCrypto-only E2E primitives. Format: [version=1][iv 12B][AES-256-GCM ciphertext+tag]. */

const VERSION = 1;
const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 32 random bytes, base64url. Stays on device (keychain); never uploaded. */
export function generateSyncKey(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function hkdfBits(keyB64: string, info: string): Promise<ArrayBuffer> {
  const raw = b64urlDecode(keyB64);
  if (raw.length !== 32) throw new Error("sync key must be 32 bytes");
  const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) },
    ikm,
    256,
  );
}

function aesKey(keyB64: string): Promise<CryptoKey> {
  return hkdfBits(keyB64, "blobbies-sync/enc/v1").then((bits) =>
    crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]),
  );
}

export async function encrypt(keyB64: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await aesKey(keyB64),
      new Uint8Array(plaintext),
    ),
  );
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

/** Throws on wrong key, unknown version or any tampering. */
export async function decrypt(keyB64: string, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 13 + 16 || data[0] !== VERSION) throw new Error("unsupported sync ciphertext");
  const iv = new Uint8Array(data.slice(1, 13));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    await aesKey(keyB64),
    new Uint8Array(data.slice(13)),
  );
  return new Uint8Array(pt);
}

/** Opaque remote name: hex HMAC-SHA256(sliceKey) under a name-only derived key. */
export async function objectName(keyB64: string, sliceKey: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    await hkdfBits(keyB64, "blobbies-sync/names/v1"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(sliceKey)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodeJson(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}
