/**
 * The audit trail: every tool call a Blob made, in order, with how it was
 * allowed. Persisted per Blob in the `activity` store slice and capped, so a
 * chatty routine cannot grow it without bound.
 *
 * A leaf module (store + types only): the chat turn writes it, and the
 * activity panel reads it, without either pulling the provider stack.
 */
import type { ApprovalOutcome } from "@/lib/approvals";
import { shortArgs } from "@/lib/approvals";
import * as store from "@/lib/store";

export interface ActivityEntry {
  /** Epoch ms the call finished. */
  at: number;
  blobId: string;
  tool: string;
  /** Arguments, clipped to one line. */
  args: string;
  /** Result or error text, clipped. */
  summary: string;
  isError: boolean;
  approval: ApprovalOutcome;
}

/** Newest entries kept per Blob. ~300 bytes each: well under 200 KB a Blob. */
export const MAX_ACTIVITY_ENTRIES = 500;

const SUMMARY_CHARS = 200;

/** Loaded logs, so appends never wait on (or race) a disk read. */
const cache = new Map<string, Promise<ActivityEntry[]>>();

function isEntry(value: unknown): value is ActivityEntry {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.at === "number" &&
    typeof row.tool === "string" &&
    typeof row.args === "string" &&
    typeof row.summary === "string" &&
    typeof row.isError === "boolean" &&
    (row.approval === "auto" || row.approval === "approved" || row.approval === "denied")
  );
}

/** This Blob's log, oldest first. Malformed rows (a hand-edited file) are skipped. */
export function loadActivity(blobId: string): Promise<ActivityEntry[]> {
  let loaded = cache.get(blobId);
  if (loaded === undefined) {
    loaded = store
      .loadBlobActivity(blobId)
      .then((raw) =>
        Array.isArray(raw)
          ? raw.filter(isEntry).map((entry) => ({ ...entry, blobId }))
          : ([] as ActivityEntry[]),
      )
      .catch(() => [] as ActivityEntry[]);
    cache.set(blobId, loaded);
  }
  return loaded;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat;
}

/** Record one finished call. Never throws: the log must not break a turn. */
export async function logToolCall(
  blobId: string,
  call: {
    name: string;
    args: Record<string, unknown>;
    result: string;
    isError: boolean;
    approval?: ApprovalOutcome;
  },
  now = Date.now(),
): Promise<void> {
  try {
    const entries = await loadActivity(blobId);
    entries.push({
      at: now,
      blobId,
      tool: call.name,
      args: shortArgs(call.args),
      summary: clip(call.result),
      isError: call.isError,
      approval: call.approval ?? "auto",
    });
    if (entries.length > MAX_ACTIVITY_ENTRIES) {
      entries.splice(0, entries.length - MAX_ACTIVITY_ENTRIES);
    }
    store.saveBlobActivity(blobId, entries);
    for (const listener of listeners) {
      listener();
    }
  } catch {
    // Logging is best-effort.
  }
}

/** Every listed Blob's log merged, newest first. */
export async function loadAllActivity(blobIds: readonly string[]): Promise<ActivityEntry[]> {
  const logs = await Promise.all(blobIds.map((id) => loadActivity(id)));
  return logs.flat().sort((a, b) => b.at - a.at);
}

const listeners = new Set<() => void>();

/** Fires after every append, so an open log can refresh. */
export function onActivityLogged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: forget loaded logs. */
export function resetActivityCache(): void {
  cache.clear();
}
