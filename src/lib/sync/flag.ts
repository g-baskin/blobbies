import { readPreference, writePreference } from "@/lib/preferences";

/**
 * Tiny "is sync configured" flag, so startup and the scheduler can check it
 * without pulling in the sync service.
 *
 * Persisted as a plain preference (it holds no secret): startup only loads the
 * service and reads the sync key from the keychain when this says sync is on.
 * Reading the keychain on every launch for users who never set up sync would
 * cost a slower start and, on macOS, can prompt for the device password.
 */
const PREF = "pref:syncConfigured";

let configured = readPreference(PREF, "false") === "true";

export function syncConfiguredFlag(): boolean {
  return configured;
}

export function setSyncConfiguredFlag(value: boolean): void {
  configured = value;
  writePreference(PREF, value ? "true" : "false");
}
