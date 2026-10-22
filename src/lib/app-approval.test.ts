import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalAnswer,
  type ApprovalHost,
  type ApprovalRequest,
  actionLabel,
  askWithDeadline,
  isReadOnlyAction,
  splitToolSlug,
} from "@/lib/app-approval";
import { makeComposioTools } from "@/lib/blob-tools";

/** What the app was actually asked to run, so a refusal can be proved. */
const executed = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/composio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composio")>()),
  composioExecute: async (tool: string) => {
    executed.calls.push(tool);
    return `ran ${tool}`;
  },
}));

const context = { signal: new AbortController().signal, toolCallId: "t1" };

/** A host that answers every request the same way and records them. */
function fakeHost(answer: ApprovalAnswer, always: string[] = []) {
  const asked: ApprovalRequest[] = [];
  const host: ApprovalHost = {
    isAlwaysAllowed: (toolkit) => always.includes(toolkit),
    ask: async (request) => {
      asked.push(request);
      return answer;
    },
  };
  return { host, asked };
}

async function run(
  tools: ReturnType<typeof makeComposioTools>,
  tool: string,
  args = '{"to":"a@example.com"}',
): Promise<string> {
  const runTool = tools.find((entry) => entry.name === "app_run_tool");
  return String(await runTool?.execute({ tool, arguments: args }, context));
}

beforeEach(() => {
  executed.calls = [];
});

describe("which actions ask", () => {
  it("lets clearly read-only actions through", () => {
    expect(isReadOnlyAction("FETCH_EMAILS")).toBe(true);
    expect(isReadOnlyAction("LIST_EVENTS")).toBe(true);
    expect(isReadOnlyAction("GET_PROFILE")).toBe(true);
  });

  it("asks for anything that writes, even when it starts like a read", () => {
    expect(isReadOnlyAction("SEND_EMAIL")).toBe(false);
    expect(isReadOnlyAction("CREATE_EVENT")).toBe(false);
    // A read verb first is not enough: the action still changes something.
    expect(isReadOnlyAction("FETCH_AND_DELETE_MESSAGE")).toBe(false);
    expect(isReadOnlyAction("GET_OR_CREATE_LABEL")).toBe(false);
  });

  it("asks for an action it does not recognise", () => {
    // A wrong guess must cost a click, never a sent message.
    expect(isReadOnlyAction("ZAP_THINGS")).toBe(false);
    expect(isReadOnlyAction("")).toBe(false);
  });

  it("finds the app even when its slug has an underscore", () => {
    expect(splitToolSlug("GMAIL_SEND_EMAIL", ["gmail", "github"])).toEqual({
      toolkit: "gmail",
      action: "SEND_EMAIL",
    });
    // Longest match wins, so a toolkit is never mistaken for a shorter one.
    expect(splitToolSlug("GOOGLE_DRIVE_UPLOAD_FILE", ["google", "google_drive"])).toEqual({
      toolkit: "google_drive",
      action: "UPLOAD_FILE",
    });
    // Unknown app: the first word stands in.
    expect(splitToolSlug("ACME_POST_NOTE", [])).toEqual({ toolkit: "acme", action: "POST_NOTE" });
  });

  it("names the action in plain words", () => {
    expect(actionLabel("SEND_EMAIL")).toBe("Send email");
    expect(actionLabel("")).toBe("Run an action");
  });
});

describe("app_run_tool approval", () => {
  it("runs a read without asking", async () => {
    const { host, asked } = fakeHost("deny");
    const tools = makeComposioTools(undefined, { host, taskAllowed: new Set() });
    expect(await run(tools, "GMAIL_FETCH_EMAILS")).toContain("ran GMAIL_FETCH_EMAILS");
    expect(asked).toHaveLength(0);
  });

  it("does not send when the user says no", async () => {
    // The bug this covers: the only guard was a line in the tool description,
    // which an email the Blob was reading could talk it out of.
    const { host, asked } = fakeHost("deny");
    const tools = makeComposioTools(undefined, { host, taskAllowed: new Set() });
    const result = await run(tools, "GMAIL_SEND_EMAIL");
    expect(result).toMatch(/declined/);
    expect(executed.calls).toEqual([]);
    expect(asked[0]).toMatchObject({
      toolkit: "gmail",
      tool: "GMAIL_SEND_EMAIL",
      action: "Send email",
      arguments: '{"to":"a@example.com"}',
    });
  });

  it("asks once per app for the rest of the task after 'Allow for this task'", async () => {
    const { host, asked } = fakeHost("task");
    const taskAllowed = new Set<string>();
    // Two catalogs for one turn: the allowance belongs to the turn.
    await run(makeComposioTools(undefined, { host, taskAllowed }), "GMAIL_SEND_EMAIL");
    await run(makeComposioTools(undefined, { host, taskAllowed }), "GMAIL_CREATE_DRAFT");
    expect(asked).toHaveLength(1);
    expect(executed.calls).toEqual(["GMAIL_SEND_EMAIL", "GMAIL_CREATE_DRAFT"]);
  });

  it("asks again after 'Allow once'", async () => {
    const { host, asked } = fakeHost("once");
    const tools = makeComposioTools(undefined, { host, taskAllowed: new Set() });
    await run(tools, "GMAIL_SEND_EMAIL");
    await run(tools, "GMAIL_SEND_EMAIL");
    expect(asked).toHaveLength(2);
  });

  it("skips the card for an app set to always allow", async () => {
    const { host, asked } = fakeHost("deny", ["gmail"]);
    const tools = makeComposioTools(undefined, { host, taskAllowed: new Set() });
    expect(await run(tools, "GMAIL_SEND_EMAIL")).toContain("ran GMAIL_SEND_EMAIL");
    expect(asked).toHaveLength(0);
  });

  it("refuses a write when there is no way to ask", async () => {
    // Fail closed: a harness or helper must never send unseen.
    const tools = makeComposioTools();
    expect(await run(tools, "GMAIL_SEND_EMAIL")).toMatch(/needs the user's approval/);
    expect(executed.calls).toEqual([]);
  });
});

describe("askWithDeadline", () => {
  /** A host that never answers, and reports when its card is taken down. */
  function silentHost() {
    const state = { closed: false };
    const host: ApprovalHost = {
      isAlwaysAllowed: () => false,
      ask: (_request, signal) =>
        new Promise<ApprovalAnswer>((resolve) => {
          signal.addEventListener("abort", () => {
            state.closed = true;
            resolve("deny");
          });
        }),
    };
    return { host, state };
  }

  const request: ApprovalRequest = {
    toolkit: "gmail",
    tool: "GMAIL_SEND_EMAIL",
    action: "Send email",
    arguments: "{}",
  };

  it("gives up after the deadline and takes the card down", async () => {
    vi.useFakeTimers();
    try {
      const { host, state } = silentHost();
      const pending = askWithDeadline(host, request, new AbortController().signal, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBe("timeout");
      expect(state.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends at Stop, with the card", async () => {
    const { host, state } = silentHost();
    const stop = new AbortController();
    const pending = askWithDeadline(host, request, stop.signal);
    stop.abort();
    await expect(pending).resolves.toBe("cancelled");
    expect(state.closed).toBe(true);
  });

  it("treats a host failure as no", async () => {
    const host: ApprovalHost = {
      isAlwaysAllowed: () => false,
      ask: async () => {
        throw new Error("card failed to open");
      },
    };
    await expect(askWithDeadline(host, request, new AbortController().signal)).resolves.toBe(
      "deny",
    );
  });
});
