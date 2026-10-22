/**
 * Ask-before-acting: the gate between a Blob deciding to do something with a
 * trace (send, write, delete, spawn, run) and that thing happening.
 *
 * A leaf module on purpose. The turn loop (`lib/ai`, a lazy chunk) wraps its
 * tools with `gateTools`, and the chat pane renders the pending requests from
 * the same in-memory broker — so this file imports nothing heavier than a
 * type, and the UI may import it statically without breaching the startup
 * bundle budget.
 *
 * The policy is deliberately fail-closed: an unknown tool name is sensitive.
 * A new tool that nobody classified asks the user once too often; the
 * opposite mistake sends an email nobody approved.
 */
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { readPreference, writePreference } from "@/lib/preferences";

export type ApprovalMode = "sensitive" | "always" | "never";

/** How a call came to run (or not): the activity log's "approval" column. */
export type ApprovalOutcome = "auto" | "approved" | "denied";

const MODE_KEY = "pref:approvalMode";
const ALLOW_KEY_PREFIX = "pref:approvalAllow:";

/** Unattended requests wait this long for the user, then count as denied. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tools that only look: they read the web, the Blob's own files or the app's
 * catalogue and change nothing anyone else can see. `ask_user` is here because
 * asking IS the human in the loop.
 */
const READ_ONLY = new Set([
  "web_search",
  "web_fetch",
  "recall_memory",
  "list_files",
  "read_file",
  "list_routines",
  "app_find_tool",
  "app_tool_schema",
  "media_info",
  "take_screenshot",
  "run_subagent",
  "ask_user",
]);

/**
 * A Composio action slug that only reads (GMAIL_FETCH_EMAILS,
 * GOOGLECALENDAR_LIST_EVENTS). Anything else — SEND, CREATE, DELETE, REPLY,
 * or a verb we do not recognise — asks.
 */
const READ_VERB = /_(FETCH|GET|LIST|SEARCH|READ|FIND|RETRIEVE|LOOKUP|QUERY|COUNT)(_|$)/;

export function readApprovalMode(): ApprovalMode {
  const value = readPreference(MODE_KEY, "sensitive");
  return value === "always" || value === "never" ? value : "sensitive";
}

export function writeApprovalMode(mode: ApprovalMode): void {
  writePreference(MODE_KEY, mode);
}

/**
 * The name an approval is remembered under. A Composio call is keyed by its
 * action, not by `app_run_tool`, so "always allow fetching mail" never also
 * allows sending it.
 */
export function approvalKey(tool: string, args: Record<string, unknown>): string {
  if (tool === "app_run_tool" && typeof args.tool === "string") {
    return `app_run_tool:${args.tool.toUpperCase()}`;
  }
  return tool;
}

/** True when this call leaves a trace and, under the default mode, asks first. */
export function isSensitive(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "app_run_tool") {
    const action = typeof args.tool === "string" ? args.tool.toUpperCase() : "";
    return !READ_VERB.test(action);
  }
  return !READ_ONLY.has(tool);
}

/** Whether this call needs the user, before always-allow is considered. */
export function needsApproval(
  mode: ApprovalMode,
  tool: string,
  args: Record<string, unknown>,
): boolean {
  if (mode === "never" || tool === "ask_user") {
    return false;
  }
  return mode === "always" || isSensitive(tool, args);
}

function readAllowList(blobId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readPreference(`${ALLOW_KEY_PREFIX}${blobId}`, "[]"));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function isAlwaysAllowed(blobId: string, key: string): boolean {
  return readAllowList(blobId).includes(key);
}

export function allowAlways(blobId: string, key: string): void {
  const list = readAllowList(blobId);
  if (!list.includes(key)) {
    writePreference(`${ALLOW_KEY_PREFIX}${blobId}`, JSON.stringify([...list, key]));
  }
}

// ---------------------------------------------------------------------------
// The broker: pending requests the UI renders and answers.

export interface ApprovalRequest {
  id: string;
  blobId: string;
  blobName: string;
  /** Where the card shows: the Blob's own id, or a group's conversation id. */
  conversationId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Raised by a routine or hand-off with nobody watching. */
  unattended: boolean;
  createdAt: number;
}

export interface ApprovalDecision {
  allowed: boolean;
  outcome: ApprovalOutcome;
}

let pending: ApprovalRequest[] = [];
const resolvers = new Map<string, (decision: { allowed: boolean; always: boolean }) => void>();
const listeners = new Set<() => void>();

function publish(next: ApprovalRequest[]): void {
  pending = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot for `useSyncExternalStore`: the array identity changes on every edit. */
export function pendingApprovals(): readonly ApprovalRequest[] {
  return pending;
}

/** Answer a pending request from the card. Unknown ids are ignored. */
export function answerApproval(id: string, allowed: boolean, always = false): void {
  const resolve = resolvers.get(id);
  if (resolve !== undefined) {
    resolve({ allowed, always });
  }
}

/**
 * Decide whether one tool call may run, asking the user when the policy says
 * so. Never throws; resolves denied on timeout or abort.
 *
 * `notify` is called once for an unattended request, so a routine at 3am
 * leaves a notification instead of silently sending something.
 */
export function requestApproval(options: {
  blobId: string;
  blobName: string;
  conversationId: string;
  tool: string;
  args: Record<string, unknown>;
  unattended: boolean;
  signal?: AbortSignal;
  mode?: ApprovalMode;
  timeoutMs?: number;
  notify?: (title: string, body: string) => void;
}): Promise<ApprovalDecision> {
  const mode = options.mode ?? readApprovalMode();
  const key = approvalKey(options.tool, options.args);
  if (
    !needsApproval(mode, options.tool, options.args) ||
    (mode !== "always" && isAlwaysAllowed(options.blobId, key))
  ) {
    return Promise.resolve({ allowed: true, outcome: "auto" });
  }
  if (options.signal?.aborted === true) {
    return Promise.resolve({ allowed: false, outcome: "denied" });
  }
  const request: ApprovalRequest = {
    id: `approval-${crypto.randomUUID()}`,
    blobId: options.blobId,
    blobName: options.blobName,
    conversationId: options.conversationId,
    tool: options.tool,
    args: options.args,
    unattended: options.unattended,
    createdAt: Date.now(),
  };
  return new Promise<ApprovalDecision>((resolve) => {
    const finish = (decision: { allowed: boolean; always: boolean }) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvers.delete(request.id);
      publish(pending.filter((entry) => entry.id !== request.id));
      if (decision.allowed && decision.always) {
        allowAlways(options.blobId, key);
      }
      resolve({ allowed: decision.allowed, outcome: decision.allowed ? "approved" : "denied" });
    };
    const onAbort = () => finish({ allowed: false, always: false });
    const timer = setTimeout(onAbort, options.timeoutMs ?? APPROVAL_TIMEOUT_MS);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    resolvers.set(request.id, finish);
    publish([...pending, request]);
    if (options.unattended) {
      options.notify?.(
        `${options.blobName} needs your OK`,
        `${describeTool(options.tool, options.args)} — open Blobbies to approve or deny.`,
      );
    }
  });
}

/** Plain words for a tool call, for the card title and the notification. */
export function describeTool(tool: string, args: Record<string, unknown>): string {
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  switch (tool) {
    case "app_run_tool":
      return `Run ${text("tool") || "an app action"}`;
    case "message_blob":
      return `Message ${text("name") || text("to") || "another Blob"}`;
    case "spawn_blob":
      return `Create a new Blob${text("name") === "" ? "" : ` called ${text("name")}`}`;
    case "delete_blob":
      return `Delete ${text("name") || "a Blob"}`;
    case "update_blob":
      return `Change ${text("name") || "a Blob"}`;
    case "run_command":
      return `Run ${text("program") || text("command") || "a command"}`;
    case "write_file":
      return `Write ${text("path") || "a file"}`;
    case "delete_file":
      return `Delete ${text("path") || "a file"}`;
    default:
      if (tool.startsWith("mcp__")) {
        return `Use ${tool.split("__").slice(1).join(" → ")}`;
      }
      return `Use ${tool}`;
  }
}

/** Arguments, one line each, clipped — what the card and the log show. */
export function shortArgs(args: Record<string, unknown>, limit = 160): string {
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// The wrapper the turn loop applies to its catalogue.

/** The tool result a denied call returns, so the model can tell the user. */
export function deniedResult(tool: string): string {
  return (
    `The user did not approve ${tool}, so it was NOT run and nothing changed. ` +
    "Tell them plainly you did not do it, and ask if they want something different."
  );
}

/**
 * Wrap each tool so `gate` decides before it runs. Same names, same schemas,
 * same count — only `execute` changes, so the tested catalogs are untouched.
 *
 * `outcomes` receives the decision per tool-call id, so whoever observes the
 * finished call can log how it was allowed.
 */
export function gateTools(
  tools: AgentTool[],
  gate: (call: {
    name: string;
    args: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<ApprovalDecision>,
  outcomes: Map<string, ApprovalOutcome>,
): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    // The wait for the user must not be cut short by the loop's own tool
    // timeout (5 minutes by default); the gate has its own.
    timeoutMs: (tool.timeoutMs ?? 300_000) + APPROVAL_TIMEOUT_MS,
    execute: async (args, context) => {
      const record = (args ?? {}) as Record<string, unknown>;
      const decision = await gate({ name: tool.name, args: record, signal: context.signal });
      outcomes.set(context.toolCallId, decision.outcome);
      if (!decision.allowed) {
        return deniedResult(tool.name);
      }
      return tool.execute(args, context);
    },
  }));
}
