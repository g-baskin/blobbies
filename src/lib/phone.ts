import { useEffect, useRef, useState } from "react";
import { isAndroid, isPhoneLayout } from "@/lib/mobile";

/**
 * Phone-layout plumbing: the narrow-screen switch, Android back handling
 * through history state, and long-press as the touch stand-in for
 * right-click. Static-safe (React and mobile.ts only).
 */

/** Live `isPhoneLayout()`: re-renders when the viewport crosses 640px. */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(isPhoneLayout);
  useEffect(() => {
    if (isAndroid() || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(max-width: 640px)");
    const apply = () => setPhone(isPhoneLayout());
    media.addEventListener?.("change", apply);
    return () => media.removeEventListener?.("change", apply);
  }, []);
  return phone;
}

/**
 * Open layers (chat, sheets), innermost last. Each one owns a history entry,
 * so Android's back button/gesture — a `popstate` in the webview — closes the
 * top layer instead of leaving the app.
 */
const layers: { close: () => void }[] = [];
/** History pops we caused ourselves (closing a layer from the UI). */
let selfPops = 0;
let listening = false;

function onPopState() {
  if (selfPops > 0) {
    selfPops -= 1;
    return;
  }
  layers.pop()?.close();
}

/**
 * While `active`, hold a history entry whose back closes this layer. Closing
 * from the UI instead consumes the entry, so history never fills with stale
 * steps.
 */
export function useBackLayer(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active || typeof window === "undefined") {
      return;
    }
    if (!listening) {
      window.addEventListener("popstate", onPopState);
      listening = true;
    }
    const layer = { close: () => closeRef.current() };
    layers.push(layer);
    window.history.pushState({ blobbiesLayer: layers.length }, "");
    return () => {
      const at = layers.indexOf(layer);
      if (at === -1) {
        // Back already popped it.
        return;
      }
      layers.splice(at, 1);
      selfPops += 1;
      window.history.back();
    };
  }, [active]);
}

/** How long a finger must rest before it counts as a long-press. */
const LONG_PRESS_MS = 500;
/** Movement (px) that turns a press into a scroll instead. */
const LONG_PRESS_SLOP = 10;

/**
 * Long-press on touch fires a `contextmenu` at the pressed element, so every
 * right-click menu also opens by holding a finger down. The webview's own
 * long-press contextmenu, if it sends one, is swallowed right after ours so a
 * menu never opens twice. Returns an uninstaller.
 */
export function installLongPress(root: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let originX = 0;
  let originY = 0;
  let firedAt = 0;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    cancel();
    originX = event.clientX;
    originY = event.clientY;
    const target = event.target;
    timer = setTimeout(() => {
      timer = null;
      if (!(target instanceof Element) || !target.isConnected) {
        return;
      }
      firedAt = Date.now();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: originX,
          clientY: originY,
        }),
      );
      // The click that ends this press must not also open the row.
      const swallow = (click: Event) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 800);
    }, LONG_PRESS_MS);
  };
  const onMove = (event: PointerEvent) => {
    if (
      timer !== null &&
      (Math.abs(event.clientX - originX) > LONG_PRESS_SLOP ||
        Math.abs(event.clientY - originY) > LONG_PRESS_SLOP)
    ) {
      cancel();
    }
  };
  const onNativeMenu = (event: Event) => {
    if (event.isTrusted && Date.now() - firedAt < 1000) {
      event.preventDefault();
      event.stopPropagation();
    } else if (event.isTrusted && timer !== null) {
      // The webview beat our timer: let its event through and skip ours.
      cancel();
      firedAt = Date.now();
    }
  };

  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", cancel);
  root.addEventListener("pointercancel", cancel);
  root.addEventListener("contextmenu", onNativeMenu, { capture: true });
  return () => {
    cancel();
    root.removeEventListener("pointerdown", onDown);
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerup", cancel);
    root.removeEventListener("pointercancel", cancel);
    root.removeEventListener("contextmenu", onNativeMenu, { capture: true });
  };
}
