/**
 * Ask the user before a Blob changes anything in their apps.
 *
 * `app_run_tool` holds real credentials: it can send mail, post, delete. Until
 * this existed, the only thing between a Blob and a sent email was one line
 * in the tool description asking the model to check first, and a model can be
 * talked out of that by the very inbox it is reading. This makes the check
 * the app's job, not the model's.
 *
 * Reads run freely. Anything that could change something waits for the user:
 * once, for the rest of this task, always for this app, or no. Unattended
 * runs wait the same way, up to `APPROVAL_TIMEOUT_MS`, and are then skipped.
 */

/** How long a request waits before it is treated as unanswered. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** The four answers a person can give. */
export type ApprovalAnswer = "once" | "task" | "always" | "deny";

/** What the gate reports back to the tool. */
export type ApprovalOutcome = ApprovalAnswer | "timeout" | "cancelled";

/** One action waiting for the user's word. */
export interface ApprovalRequest {
  /** Composio toolkit slug, e.g. "gmail". The unit "always allow" applies to. */
  toolkit: string;
  /** Exact tool slug, e.g. "GMAIL_SEND_EMAIL". */
  tool: string;
  /** The action in plain words, e.g. "Send email". */
  action: string;
  /** The model's arguments, as it sent them. Shown, never interpreted. */
  arguments: string;
}

/**
 * What the host provides: the remembered "always" choices and a way to ask.
 *
 * `ask` must settle when `signal` aborts (timeout or Stop) and take its prompt
 * off the screen, so a card is never left asking about an action nobody is
 * waiting on any more.
 */
export interface ApprovalHost {
  isAlwaysAllowed: (toolkit: string) => boolean;
  ask: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>;
}

/**
 * Verbs that open an action that only looks. Matched against the first word
 * after the toolkit, and only when no word of the action is a writing one.
 * Anything not recognised asks: a wrong guess here must cost a click, never a
 * sent message.
 */
const READ_VERBS = new Set([
  "CHECK",
  "COUNT",
  "DESCRIBE",
  "DOWNLOAD",
  "EXPORT",
  "FETCH",
  "FIND",
  "GET",
  "LIST",
  "LOOKUP",
  "QUERY",
  "READ",
  "RETRIEVE",
  "SEARCH",
  "VIEW",
]);

/** Words that mean the action changes something, wherever they appear. */
const WRITE_WORDS = new Set([
  "ACCEPT",
  "ADD",
  "APPROVE",
  "ARCHIVE",
  "ASSIGN",
  "BLOCK",
  "CANCEL",
  "CLOSE",
  "COMMENT",
  "CREATE",
  "DECLINE",
  "DELETE",
  "DRAFT",
  "EDIT",
  "EXECUTE",
  "FORWARD",
  "IMPORT",
  "INSERT",
  "INVITE",
  "LABEL",
  "MARK",
  "MERGE",
  "MODIFY",
  "MOVE",
  "PATCH",
  "POST",
  "PUBLISH",
  "PUT",
  "REMOVE",
  "RENAME",
  "REPLY",
  "RESPOND",
  "RUN",
  "SAVE",
  "SCHEDULE",
  "SEND",
  "SET",
  "SHARE",
  "STAR",
  "SUBSCRIBE",
  "TRASH",
  "TRIGGER",
  "UNSUBSCRIBE",
  "UPDATE",
  "UPLOAD",
  "UPSERT",
  "WRITE",
]);

/**
 * Split a tool slug into its app and its action.
 *
 * Composio slugs are `TOOLKIT_ACTION`, but a toolkit can itself contain an
 * underscore, so the app is the longest known toolkit the slug starts with.
 * An app missing from the catalog falls back to the first word.
 */
export function splitToolSlug(
  tool: string,
  toolkits: readonly string[],
): { toolkit: string; action: string } {
  const lower = tool.toLowerCase();
  let toolkit = "";
  for (const candidate of toolkits) {
    if (candidate.length > toolkit.length && lower.startsWith(`${candidate.toLowerCase()}_`)) {
      toolkit = candidate.toLowerCase();
    }
  }
  if (toolkit === "") {
    toolkit = lower.split("_")[0] ?? lower;
  }
  return { toolkit, action: tool.slice(toolkit.length + 1).toUpperCase() };
}

/** True only for an action that clearly just looks. */
export function isReadOnlyAction(action: string): boolean {
  const words = action.split("_").filter((word) => word !== "");
  const first = words[0];
  if (first === undefined || !READ_VERBS.has(first)) {
    return false;
  }
  return !words.some((word) => WRITE_WORDS.has(word));
}

/** "SEND_EMAIL" -> "Send email": what the approval card calls the action. */
export function actionLabel(action: string): string {
  const words = action
    .toLowerCase()
    .split("_")
    .filter((word) => word !== "");
  const text = words.join(" ");
  return text === "" ? "Run an action" : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Wait for the user's answer, giving up on timeout or Stop.
 *
 * The signal handed to `ask` fires in both cases, which is what takes the
 * card down. Never rejects: every way this can end is an outcome the tool
 * turns into a sentence for the model.
 */
export async function askWithDeadline(
  host: ApprovalHost,
  request: ApprovalRequest,
  signal: AbortSignal,
  timeoutMs = APPROVAL_TIMEOUT_MS,
): Promise<ApprovalOutcome> {
  if (signal.aborted) {
    return "cancelled";
  }
  const controller = new AbortController();
  let outcome: ApprovalOutcome | null = null;
  const settle = (value: ApprovalOutcome) => {
    outcome ??= value;
    controller.abort();
  };
  const timer = setTimeout(() => settle("timeout"), timeoutMs);
  const onAbort = () => settle("cancelled");
  signal.addEventListener("abort", onAbort);
  try {
    const stopped = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve());
    });
    const answered = host.ask(request, controller.signal).then(
      (answer) => settle(answer),
      () => settle("deny"),
    );
    await Promise.race([answered, stopped]);
    return outcome ?? "deny";
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/** What the model is told when an action did not run. */
export function notRunMessage(outcome: "deny" | "timeout" | "cancelled", action: string): string {
  switch (outcome) {
    case "deny":
      return (
        `The user declined: "${action}" was not run. Do not try it again. ` +
        "Ask them what they would like instead."
      );
    case "timeout":
      return (
        `Not run: the user did not answer the approval for "${action}" within ` +
        `${Math.round(APPROVAL_TIMEOUT_MS / 60_000)} minutes. Do not try it again in this ` +
        "task. Tell them what you wanted to do so they can ask you again."
      );
    case "cancelled":
      return `Not run: the task was stopped before "${action}" was approved.`;
  }
}
