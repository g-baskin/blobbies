import type { AgentTool } from "@kenkaiiii/gg-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalOutcome,
  allowAlways,
  answerApproval,
  gateTools,
  isSensitive,
  needsApproval,
  pendingApprovals,
  requestApproval,
} from "@/lib/approvals";

const base = { blobId: "b1", blobName: "Scout", conversationId: "b1" };

describe("approval policy", () => {
  it("reads run freely, writes and sends ask", () => {
    expect(isSensitive("web_search", {})).toBe(false);
    expect(isSensitive("read_file", {})).toBe(false);
    expect(isSensitive("app_run_tool", { tool: "GMAIL_FETCH_EMAILS" })).toBe(false);
    for (const tool of [
      "message_blob",
      "spawn_blob",
      "delete_blob",
      "run_command",
      "write_file",
      "mcp__x__y",
      "unknown",
    ]) {
      expect(isSensitive(tool, {})).toBe(true);
    }
    expect(isSensitive("app_run_tool", { tool: "GMAIL_SEND_EMAIL" })).toBe(true);
  });

  it("honours the mode", () => {
    expect(needsApproval("never", "delete_blob", {})).toBe(false);
    expect(needsApproval("always", "web_search", {})).toBe(true);
    expect(needsApproval("sensitive", "web_search", {})).toBe(false);
  });
});

describe("requestApproval", () => {
  it("auto-allows read-only and never-mode calls without a card", async () => {
    await expect(
      requestApproval({ ...base, tool: "web_fetch", args: {}, unattended: false }),
    ).resolves.toEqual({ allowed: true, outcome: "auto" });
    await expect(
      requestApproval({ ...base, tool: "delete_blob", args: {}, unattended: false, mode: "never" }),
    ).resolves.toEqual({ allowed: true, outcome: "auto" });
    expect(pendingApprovals()).toHaveLength(0);
  });

  it("queues a sensitive call until answered, and remembers always-allow", async () => {
    const decision = requestApproval({
      ...base,
      tool: "message_blob",
      args: { name: "Ada" },
      unattended: false,
      mode: "sensitive",
    });
    const [card] = pendingApprovals();
    expect(card?.tool).toBe("message_blob");
    answerApproval(card?.id ?? "", true, true);
    await expect(decision).resolves.toEqual({ allowed: true, outcome: "approved" });
    await expect(
      requestApproval({
        ...base,
        tool: "message_blob",
        args: {},
        unattended: false,
        mode: "sensitive",
      }),
    ).resolves.toMatchObject({ outcome: "auto" });
  });

  it("notifies for unattended routines and denies on timeout", async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const decision = requestApproval({
      ...base,
      blobId: "b2",
      tool: "run_command",
      args: { program: "ls" },
      unattended: true,
      mode: "sensitive",
      timeoutMs: 1000,
      notify,
    });
    expect(notify).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1001);
    await expect(decision).resolves.toEqual({ allowed: false, outcome: "denied" });
    expect(pendingApprovals()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("always-mode ignores the always-allow list", async () => {
    allowAlways("b3", "spawn_blob");
    const decision = requestApproval({
      ...base,
      blobId: "b3",
      tool: "spawn_blob",
      args: {},
      unattended: false,
      mode: "always",
    });
    answerApproval(pendingApprovals()[0]?.id ?? "", false);
    await expect(decision).resolves.toEqual({ allowed: false, outcome: "denied" });
  });
});

describe("gateTools", () => {
  it("returns the denial to the model and never runs the tool", async () => {
    const execute = vi.fn(async () => "sent");
    const tool = {
      name: "app_run_tool",
      description: "",
      parameters: {} as never,
      execute,
    } as unknown as AgentTool;
    const outcomes = new Map<string, ApprovalOutcome>();
    const [gated] = gateTools(
      [tool],
      async () => ({ allowed: false, outcome: "denied" }),
      outcomes,
    );
    const result = await gated?.execute({ tool: "GMAIL_SEND_EMAIL" } as never, {
      toolCallId: "c1",
      signal: new AbortController().signal,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(String(result)).toContain("did not approve");
    expect(outcomes.get("c1")).toBe("denied");
    expect(gated?.name).toBe("app_run_tool");
  });
});
