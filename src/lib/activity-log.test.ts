import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadActivity,
  logToolCall,
  MAX_ACTIVITY_ENTRIES,
  resetActivityCache,
} from "@/lib/activity-log";
import * as store from "@/lib/store";

describe("activity log", () => {
  beforeEach(() => {
    resetActivityCache();
    store.clearFallbackBackend();
  });

  it("persists entries with approval and clipped summary", async () => {
    vi.useFakeTimers();
    await logToolCall("b1", {
      name: "web_search",
      args: { query: "x" },
      result: "y".repeat(500),
      isError: false,
    });
    await logToolCall("b1", {
      name: "message_blob",
      args: { name: "Ada" },
      result: "denied",
      isError: false,
      approval: "denied",
    });
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    resetActivityCache();
    const entries = await loadActivity("b1");
    expect(entries.map((e) => e.tool)).toEqual(["web_search", "message_blob"]);
    expect(entries[0]?.approval).toBe("auto");
    expect(entries[1]?.approval).toBe("denied");
    expect(entries[0]?.summary.length).toBeLessThanOrEqual(200);
  });

  it("caps the log, keeping the newest", async () => {
    for (let index = 0; index < MAX_ACTIVITY_ENTRIES + 5; index++) {
      await logToolCall("b2", { name: `t${index}`, args: {}, result: "", isError: false });
    }
    const entries = await loadActivity("b2");
    expect(entries).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(entries.at(-1)?.tool).toBe(`t${MAX_ACTIVITY_ENTRIES + 4}`);
    expect(entries[0]?.tool).toBe("t5");
  });
});
