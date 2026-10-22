import { isTauri } from "@/lib/tauri";

/**
 * Whether this build can capture the screen (macOS/Windows desktop only).
 *
 * A leaf module on purpose: `screenshot.ts` pulls in zod and the agent tool
 * types, and App.tsx needs only this check at startup — importing it from there
 * put zod in the startup chunk (bundle budget, see CLAUDE.md).
 */
export function canCapture(): boolean {
  return isTauri() && !navigator.userAgent.includes("Linux");
}
