import { useEffect, useRef, useState } from "react";
import type { PairPrompt } from "@/components/SyncPairDialog";
import { onPairLink, takePendingPairLink } from "@/lib/mobile";

/**
 * App-level sync wiring: auto-sync for the app's lifetime, the "updates from
 * your other device" banner, and pair-link confirmation (Android).
 *
 * Static-safe: the sync service itself is only ever reached through dynamic
 * import(), so it stays out of the startup chunk.
 */
let syncModule: Promise<typeof import("@/lib/sync/service")> | undefined;
/**
 * The sync service, loaded once and shared. Memoized like App's loadAi: the
 * app asks for it from several effects in the same tick, and one promise
 * keeps that to a single load (it also keeps test mocks consistent; vitest
 * resolved concurrent loads of a mocked module to the real one).
 */
export const loadSync = () => (syncModule ??= import("@/lib/sync/service"));

export function useSyncWiring(isBusy: () => boolean) {
  const [syncRefresh, setSyncRefresh] = useState(false);
  const [pairPrompt, setPairPrompt] = useState<PairPrompt | null>(null);

  useEffect(() => {
    let alive = true;
    let stopAuto = () => {};
    let unsubscribe = () => {};
    void loadSync()
      .then((sync) => {
        if (!alive) {
          return;
        }
        stopAuto = sync.startAutoSync();
        setSyncRefresh(sync.getSyncStatus().pendingRefresh);
        unsubscribe = sync.subscribeSync((status) => setSyncRefresh(status.pendingRefresh));
      })
      .catch(() => {});
    return () => {
      alive = false;
      stopAuto();
      unsubscribe();
    };
  }, []);

  const refreshFromSync = () => {
    void loadSync()
      .then((sync) => sync.clearPendingRefresh())
      .catch(() => {})
      .finally(() => window.location.reload());
  };

  // Coming back to the app with updates waiting: reload on its own, but only
  // when no reply is streaming and nothing is half-typed.
  const latest = useRef({ syncRefresh, isBusy, refreshFromSync });
  latest.current = { syncRefresh, isBusy, refreshFromSync };
  useEffect(() => {
    const onVisible = () => {
      const { syncRefresh: pending, isBusy: busy, refreshFromSync: refresh } = latest.current;
      if (document.visibilityState !== "visible" || !pending || busy()) {
        return;
      }
      const typing = [...document.querySelectorAll("textarea")].some(
        (field) => field.value.trim() !== "",
      );
      if (!typing) {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Pair links: confirm first, never auto-accept.
  useEffect(() => {
    let alive = true;
    const offer = (url: string) => {
      void loadSync()
        .then((sync) => {
          if (alive) {
            setPairPrompt(
              sync.parsePairLink(url) === null ? { kind: "invalid" } : { kind: "confirm", url },
            );
          }
        })
        .catch(() => {
          if (alive) {
            setPairPrompt({ kind: "invalid" });
          }
        });
    };
    void takePendingPairLink().then((url) => {
      if (alive && url !== null) {
        offer(url);
      }
    });
    const stop = onPairLink(offer);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const acceptPair = (url: string) => {
    setPairPrompt({ kind: "connecting" });
    void loadSync()
      .then((sync) => sync.acceptPairing(url))
      .then(
        () => window.location.reload(),
        (error: unknown) =>
          setPairPrompt({
            kind: "failed",
            error:
              typeof (error as { message?: unknown } | null)?.message === "string"
                ? (error as { message: string }).message
                : String(error),
          }),
      );
  };

  return { syncRefresh, refreshFromSync, pairPrompt, setPairPrompt, acceptPair };
}
