import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncWiring } from "@/lib/sync/useSyncWiring";

const link = vi.hoisted(() => ({
  pending: null as string | null,
  listener: null as ((url: string) => void) | null,
}));
const sync = vi.hoisted(() => ({
  listener: null as ((status: { pendingRefresh: boolean }) => void) | null,
  acceptPairing: vi.fn(async (_url: string) => {}),
  stopAuto: vi.fn(),
  startAutoSync: vi.fn(),
}));

vi.mock("@/lib/mobile", () => ({
  takePendingPairLink: async () => {
    const next = link.pending;
    link.pending = null;
    return next;
  },
  onPairLink: (callback: (url: string) => void) => {
    link.listener = callback;
    return () => {
      link.listener = null;
    };
  },
}));

vi.mock("@/lib/sync/service", () => ({
  startAutoSync: () => {
    sync.startAutoSync();
    return sync.stopAuto;
  },
  getSyncStatus: () => ({ pendingRefresh: false }),
  subscribeSync: (listener: (status: { pendingRefresh: boolean }) => void) => {
    sync.listener = listener;
    return () => {
      sync.listener = null;
    };
  },
  parsePairLink: (url: string) =>
    url.startsWith("blobbies://pair#") ? { key: "k", remote: { provider: "s3" } } : null,
  acceptPairing: sync.acceptPairing,
  clearPendingRefresh: () => {},
}));

describe("useSyncWiring", () => {
  beforeEach(() => {
    link.pending = null;
    link.listener = null;
    sync.listener = null;
    sync.acceptPairing.mockClear();
    sync.startAutoSync.mockClear();
    sync.stopAuto.mockClear();
  });

  it("starts auto-sync and stops it on unmount", async () => {
    const { unmount } = renderHook(() => useSyncWiring(() => false));
    await waitFor(() => expect(sync.startAutoSync).toHaveBeenCalledTimes(1));
    unmount();
    expect(sync.stopAuto).toHaveBeenCalledTimes(1);
  });

  it("asks before accepting a pair link from launch, and accepts only on Connect", async () => {
    link.pending = "blobbies://pair#good";
    const { result } = renderHook(() => useSyncWiring(() => false));
    await waitFor(() =>
      expect(result.current.pairPrompt).toEqual({ kind: "confirm", url: "blobbies://pair#good" }),
    );
    expect(sync.acceptPairing).not.toHaveBeenCalled();
    act(() => result.current.acceptPair("blobbies://pair#good"));
    await waitFor(() => expect(sync.acceptPairing).toHaveBeenCalledWith("blobbies://pair#good"));
  });

  it("flags a malformed link arriving while running, without accepting it", async () => {
    const { result } = renderHook(() => useSyncWiring(() => false));
    await waitFor(() => expect(link.listener).not.toBeNull());
    act(() => link.listener?.("https://example.com/not-a-pair-link"));
    await waitFor(() => expect(result.current.pairPrompt).toEqual({ kind: "invalid" }));
    expect(sync.acceptPairing).not.toHaveBeenCalled();
  });

  it("shows the refresh banner when the other device's updates arrive", async () => {
    const { result } = renderHook(() => useSyncWiring(() => false));
    await waitFor(() => expect(sync.listener).not.toBeNull());
    expect(result.current.syncRefresh).toBe(false);
    act(() => sync.listener?.({ pendingRefresh: true }));
    expect(result.current.syncRefresh).toBe(true);
  });

  it("reports a failed connect instead of reloading", async () => {
    sync.acceptPairing.mockRejectedValueOnce(new Error("Couldn't reach the sync storage"));
    const { result } = renderHook(() => useSyncWiring(() => false));
    act(() => result.current.acceptPair("blobbies://pair#good"));
    await waitFor(() =>
      expect(result.current.pairPrompt).toEqual({
        kind: "failed",
        error: "Couldn't reach the sync storage",
      }),
    );
  });
});
