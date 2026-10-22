import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/** Native plugin name (src-tauri/src/android_bridge.rs, BlobbiesPlugin.kt). */
const PLUGIN = "blobbies-android";

/** Wire shape from Kotlin: file bytes arrive base64-encoded. */
interface RawShare {
  text?: string;
  subject?: string;
  files?: { name?: string; mimeType?: string; base64?: string }[];
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toSharedContent(raw: RawShare): SharedContent {
  return {
    text: raw.text ?? "",
    subject: raw.subject ?? "",
    files: (raw.files ?? []).map((file) => ({
      name: file.name ?? "shared",
      mimeType: file.mimeType ?? "application/octet-stream",
      bytes: decodeBase64(file.base64 ?? ""),
    })),
  };
}

/**
 * Phone-platform surface (Android build). This module is the contract between
 * the native Android side (src-tauri, Kotlin) and the UI: UI code imports only
 * these exports, never `invoke` names directly, so the native half can change
 * without touching components.
 *
 * Static-safe: no provider-stack imports, so UI modules may import it freely
 * without breaching the startup bundle budget.
 */

/** Content another app handed to Blobbies through Android's share sheet. */
export interface SharedContent {
  /** Shared text or URL (EXTRA_TEXT). Empty string when only files were shared. */
  text: string;
  /** EXTRA_SUBJECT, e.g. a page title. Empty string when absent. */
  subject: string;
  /** Shared files (images, PDFs), already copied into app storage as bytes. */
  files: { name: string; mimeType: string; bytes: Uint8Array }[];
}

/** True in the Android build. False on desktop, in a browser, and in tests. */
export function isAndroid(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return isTauri() && /Android/i.test(navigator.userAgent);
}

/**
 * True when the UI should use the phone layout: the Android build, or any
 * narrow viewport (so the layout can be developed in a desktop browser).
 */
export function isPhoneLayout(): boolean {
  if (isAndroid()) {
    return true;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(max-width: 640px)").matches;
}

/**
 * The share that launched or resumed the app, consumed once (a second call
 * returns null until another share arrives). Null off Android.
 */
export async function takePendingShare(): Promise<SharedContent | null> {
  if (!isAndroid()) {
    return null;
  }
  const result = await invoke<{ share?: RawShare | null }>(`plugin:${PLUGIN}|take_pending_share`);
  return result?.share ? toSharedContent(result.share) : null;
}

/**
 * Subscribe to shares that arrive while the app is already running.
 * Returns an unsubscribe function. A no-op off Android.
 */
export function onShare(callback: (content: SharedContent) => void): () => void {
  if (!isAndroid()) {
    return () => {};
  }
  let listener: PluginListener | null = null;
  let cancelled = false;
  void addPluginListener<RawShare>(PLUGIN, "share", (raw) => callback(toSharedContent(raw)))
    .then((registered) => {
      if (cancelled) {
        void registered.unregister();
      } else {
        listener = registered;
      }
    })
    .catch(() => {
      // Listener registration failed (e.g. permission missing): no live shares.
    });
  return () => {
    cancelled = true;
    void listener?.unregister();
  };
}

/**
 * The `blobbies://pair#…` link (from the computer's pairing QR) that launched
 * or resumed the app, consumed once. Null off Android. It carries the sync
 * key: never log it.
 */
export async function takePendingPairLink(): Promise<string | null> {
  if (!isAndroid()) {
    return null;
  }
  const result = await invoke<{ url?: string | null }>(`plugin:${PLUGIN}|take_pending_pair_link`);
  return typeof result?.url === "string" ? result.url : null;
}

/**
 * Subscribe to pair links that arrive while the app is already running.
 * Returns an unsubscribe function. A no-op off Android.
 */
export function onPairLink(callback: (url: string) => void): () => void {
  if (!isAndroid()) {
    return () => {};
  }
  let listener: PluginListener | null = null;
  let cancelled = false;
  void addPluginListener<{ url?: string }>(PLUGIN, "pairLink", (raw) => {
    if (typeof raw?.url === "string") {
      callback(raw.url);
    }
  })
    .then((registered) => {
      if (cancelled) {
        void registered.unregister();
      } else {
        listener = registered;
      }
    })
    .catch(() => {
      // Listener registration failed: no live pair links.
    });
  return () => {
    cancelled = true;
    void listener?.unregister();
  };
}
