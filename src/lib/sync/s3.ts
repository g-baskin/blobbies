/**
 * S3-compatible RemoteStore (Cloudflare R2, AWS S3). Hand-written AWS SigV4 over WebCrypto;
 * path-style URLs `${endpoint}/${bucket}/${prefix}/${name}`. Only ciphertext ever reaches it.
 * Conditional writes: ifVersion null → If-None-Match: *, string → If-Match; 412/409 → "conflict".
 */
import { isTauri } from "@/lib/tauri";
import type { RemoteStore } from "./types";

export interface S3Config {
  provider: "s3";
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function parseS3Config(config: { provider: string; [k: string]: unknown }): S3Config {
  if (config.provider !== "s3") throw new Error("Storage provider must be s3");
  const str = (k: string): string => {
    const v = config[k];
    return typeof v === "string" ? v.trim() : "";
  };
  let endpoint = str("endpoint").replace(/\/+$/, "");
  if (!endpoint) throw new Error("Endpoint is required");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Endpoint is not a valid URL");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("Endpoint must use https");
  endpoint = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  const bucket = str("bucket");
  if (!BUCKET_RE.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket))
    throw new Error("Bucket name is invalid");
  const accessKeyId = str("accessKeyId");
  const secretAccessKey = str("secretAccessKey");
  if (!accessKeyId) throw new Error("Access key ID is required");
  if (!secretAccessKey) throw new Error("Secret access key is required");
  const prefix = normalizePrefix(str("prefix"));
  return {
    provider: "s3",
    endpoint,
    bucket,
    region: str("region") || "auto",
    accessKeyId,
    secretAccessKey,
    prefix,
  };
}

function normalizePrefix(p: string | undefined): string {
  const n = (p ?? "").replace(/^\/+|\/+$/g, "");
  return n || "blobbies-sync";
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** RFC 3986 encoding per SigV4 (unreserved: A-Z a-z 0-9 - _ . ~). */
export function uriEncode(s: string): string {
  return Array.from(enc.encode(s), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9\-_.~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

export interface SignInput {
  method: string;
  url: string; // path already segment-encoded
  headers: Record<string, string>; // must include x-amz-content-sha256; host/x-amz-date added
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
}

/** Internal: returns the headers to send (incl. Authorization) and the signature. */
export async function signRequest(
  i: SignInput,
): Promise<{ headers: Record<string, string>; signature: string }> {
  const u = new URL(i.url);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v.trim();
  headers.host = u.host;
  headers["x-amz-date"] = i.amzDate;
  headers["x-amz-content-sha256"] = i.payloadHash;
  const names = Object.keys(headers).sort();
  const query = [...u.searchParams.entries()]
    .map(([k, v]): [string, string] => [uriEncode(k), uriEncode(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    i.method,
    u.pathname || "/",
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    i.payloadHash,
  ].join("\n");
  const date = i.amzDate.slice(0, 8);
  const scope = `${date}/${i.region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    i.amzDate,
    scope,
    await sha256Hex(enc.encode(canonical)),
  ].join("\n");
  let k = await hmac(enc.encode(`AWS4${i.secretAccessKey}`), date);
  k = await hmac(k, i.region);
  k = await hmac(k, "s3");
  k = await hmac(k, "aws4_request");
  const signature = hex(await hmac(k, toSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope},SignedHeaders=${names.join(";")},Signature=${signature}`;
  delete headers.host; // set by the transport
  return { headers, signature };
}

function amzNow(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Plugin fetch in Tauri (goes through Rust: no CORS, no CSP); global fetch elsewhere. */
async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const bounded = { ...init, redirect: "error" as const };
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, { ...bounded, maxRedirections: 0 } as RequestInit);
  }
  return fetch(url, bounded);
}

export function createS3Store(config: S3Config, fetchImpl?: typeof fetch): RemoteStore {
  const doFetch = fetchImpl ?? defaultFetch;
  const prefix = normalizePrefix(config.prefix);
  const region = config.region || "auto";
  const base = `${config.endpoint.replace(/\/+$/, "")}/${uriEncode(config.bucket)}`;
  const urlFor = (name: string) =>
    `${base}/${[...prefix.split("/"), ...name.split("/")].map(uriEncode).join("/")}`;

  async function send(
    method: string,
    name: string,
    body?: Uint8Array,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const url = urlFor(name);
    const payloadHash = await sha256Hex(body ?? new Uint8Array());
    const { headers } = await signRequest({
      method,
      url,
      headers: extra,
      payloadHash,
      region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      amzDate: amzNow(),
    });
    return doFetch(
      url,
      body === undefined ? { method, headers } : { method, headers, body: body as BodyInit },
    );
  }

  const fail = (op: string, status: number) => new Error(`S3 ${op} failed (HTTP ${status})`);

  return {
    async get(name) {
      const res = await send("GET", name);
      if (res.status === 404) return null;
      if (res.status !== 200) throw fail("GET", res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, version: res.headers.get("etag") ?? "" };
    },
    async put(name, bytes, ifVersion) {
      const extra: Record<string, string> = { "content-type": "application/octet-stream" };
      if (ifVersion === null) extra["if-none-match"] = "*";
      else if (typeof ifVersion === "string") extra["if-match"] = ifVersion;
      const res = await send("PUT", name, bytes, extra);
      if (res.status === 412 || (res.status === 409 && ifVersion !== undefined)) return "conflict";
      if (res.status !== 200) throw fail("PUT", res.status);
      let etag = res.headers.get("etag");
      if (!etag) {
        const head = await send("HEAD", name);
        if (head.status !== 200) throw fail("HEAD", head.status);
        etag = head.headers.get("etag");
        if (!etag) throw new Error("S3 PUT returned no ETag");
      }
      return { version: etag };
    },
    async delete(name) {
      const res = await send("DELETE", name);
      if (![200, 204, 404].includes(res.status)) throw fail("DELETE", res.status);
    },
  };
}
