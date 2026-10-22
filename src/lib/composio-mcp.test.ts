import { beforeEach, describe, expect, it, vi } from "vitest";
import { callComposioTool, composioCheck, forgetComposioSession } from "@/lib/composio-mcp";
import { deleteSecret, setSecret } from "@/lib/secrets";

/** What the browser sign-in would hand the transport, or null when signed out. */
const oauth = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("@/lib/composio-oauth", () => ({
  composioAccessToken: async () => oauth.token,
}));

/** Every request, by the credential it carried. */
let sent: { auth: string; method: string; session: string }[] = [];
/** Credentials the stand-in server accepts. */
let accepted = new Set<string>();

vi.mock("@/lib/http", () => ({
  httpFetch: async (_url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? `key:${headers["x-consumer-api-key"] ?? ""}`;
    const { method } = JSON.parse(String(init.body)) as { method: string };
    sent.push({ auth, method, session: headers["mcp-session-id"] ?? "" });
    if (!accepted.has(auth)) {
      return new Response('{"error":"Authorization required"}', { status: 401 });
    }
    const result =
      method === "initialize" ? {} : { content: [{ type: "text", text: `ok via ${auth}` }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "mcp-session-id": `session-for-${auth}` },
    });
  },
}));

beforeEach(async () => {
  sent = [];
  accepted = new Set();
  oauth.token = null;
  forgetComposioSession();
  await deleteSecret("composio-api-key");
});

describe("credential fallback", () => {
  it("uses the pasted key when the sign-in token is refused", async () => {
    // The bug this covers: a stored sign-in always won, so once Composio
    // refused it a perfectly good key was never tried and the app read as
    // "not connected" with no way out.
    oauth.token = "at_refused";
    await setSecret("composio-api-key", "ck_good_key_000000");
    accepted.add("key:ck_good_key_000000");

    await expect(composioCheck()).resolves.toEqual({ ok: true });
    expect(sent.map((request) => request.auth)).toEqual([
      "Bearer at_refused",
      "key:ck_good_key_000000",
    ]);

    // Later calls go straight to the key, on the session the key opened.
    sent = [];
    await expect(callComposioTool("COMPOSIO_SEARCH_TOOLS", {})).resolves.toBe(
      "ok via key:ck_good_key_000000",
    );
    expect(sent).toEqual([
      {
        auth: "key:ck_good_key_000000",
        method: "tools/call",
        session: "session-for-key:ck_good_key_000000",
      },
    ]);
  });

  it("moves a running session to the key when the token is refused mid-way", async () => {
    oauth.token = "at_soon_revoked";
    await setSecret("composio-api-key", "ck_good_key_000000");
    accepted.add("Bearer at_soon_revoked");
    accepted.add("key:ck_good_key_000000");
    await expect(composioCheck()).resolves.toEqual({ ok: true });

    accepted.delete("Bearer at_soon_revoked");
    sent = [];
    await expect(callComposioTool("COMPOSIO_SEARCH_TOOLS", {})).resolves.toBe(
      "ok via key:ck_good_key_000000",
    );
    // Exactly one refusal: the dead token is not sent a second time.
    expect(sent.map((request) => `${request.method} ${request.auth}`)).toEqual([
      "tools/call Bearer at_soon_revoked",
      "initialize key:ck_good_key_000000",
      "tools/call key:ck_good_key_000000",
    ]);
  });

  it("still prefers a sign-in token that works", async () => {
    oauth.token = "at_good";
    await setSecret("composio-api-key", "ck_good_key_000000");
    accepted.add("Bearer at_good");
    accepted.add("key:ck_good_key_000000");

    await expect(composioCheck()).resolves.toEqual({ ok: true });
    expect(sent.map((request) => request.auth)).toEqual(["Bearer at_good"]);
  });

  it("says the sign-in was refused when there is no key to fall back to", async () => {
    oauth.token = "at_refused";
    await expect(composioCheck()).resolves.toMatchObject({
      ok: false,
      reason: "failed",
      message: expect.stringMatching(/rejected your sign-in/),
    });
  });

  it("reports nothing stored as a state, not a failure", async () => {
    await expect(composioCheck()).resolves.toMatchObject({ ok: false, reason: "none" });
    expect(sent).toHaveLength(0);
  });

  it("does not retry a refused key", async () => {
    await setSecret("composio-api-key", "ck_bad_key_0000000");
    await expect(composioCheck()).resolves.toMatchObject({ ok: false, reason: "failed" });
    expect(sent).toHaveLength(1);
  });
});
