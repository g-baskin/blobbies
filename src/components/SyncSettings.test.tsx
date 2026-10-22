import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncSettings } from "@/components/SyncSettings";

const env = vi.hoisted(() => ({ android: false }));
const sync = vi.hoisted(() => ({
  status: {
    state: "off",
    provider: null,
    lastSyncedAt: null,
    error: null,
    pendingRefresh: false,
  } as Record<string, unknown>,
  syncNow: vi.fn(async () => {}),
  createPairing: vi.fn(async () => ({ link: "blobbies://pair#abc" })),
}));

vi.mock("@/lib/mobile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile")>()),
  isAndroid: () => env.android,
}));
vi.mock("@/lib/sync/service", () => ({
  getSyncStatus: () => sync.status,
  subscribeSync: () => () => {},
  syncNow: sync.syncNow,
  createPairing: sync.createPairing,
  currentPairingLink: async () => null,
  parsePairLink: () => null,
  acceptPairing: async () => {},
  unpair: async () => {},
}));

beforeEach(() => {
  env.android = false;
  sync.status = {
    state: "off",
    provider: null,
    lastSyncedAt: null,
    error: null,
    pendingRefresh: false,
  };
  sync.syncNow.mockClear();
  sync.createPairing.mockClear();
});

describe("SyncSettings", () => {
  it("offers Set up sync on desktop", async () => {
    render(<SyncSettings />);
    expect(await screen.findByRole("button", { name: "Set up sync" })).toBeTruthy();
  });

  it("shows scan instructions and a paste field on Android", async () => {
    env.android = true;
    render(<SyncSettings />);
    expect(await screen.findByText(/Scan the code shown in Blobbies/)).toBeTruthy();
    expect(screen.getByLabelText("Paste a pairing link")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up sync" })).toBeNull();
  });

  it("shows last synced and Sync now calls syncNow", async () => {
    sync.status = { ...sync.status, state: "idle", provider: "s3", lastSyncedAt: Date.now() };
    render(<SyncSettings />);
    expect(await screen.findByText("Last synced just now")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(sync.syncNow).toHaveBeenCalled();
  });

  it("creates a pairing from the S3 form with trimmed values", async () => {
    render(<SyncSettings />);
    await userEvent.click(await screen.findByRole("button", { name: "Set up sync" }));
    const cont = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    await userEvent.type(
      screen.getByLabelText("Endpoint URL"),
      " https://acc.r2.cloudflarestorage.com ",
    );
    await userEvent.type(screen.getByLabelText("Bucket"), "my-bucket ");
    await userEvent.type(screen.getByLabelText("Access key ID"), "AKID");
    await userEvent.type(screen.getByLabelText("Secret access key"), "s3cret");
    expect(cont.disabled).toBe(false);
    await userEvent.click(cont);
    expect(sync.createPairing).toHaveBeenCalledWith({
      provider: "s3",
      endpoint: "https://acc.r2.cloudflarestorage.com",
      bucket: "my-bucket",
      region: "auto",
      accessKeyId: "AKID",
      secretAccessKey: "s3cret",
      prefix: "blobbies-sync",
    });
    expect(await screen.findByText("Scan this with your phone's camera")).toBeTruthy();
  });
});
