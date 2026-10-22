import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const unregister = vi.fn(async () => {});
let shareHandler: ((raw: unknown) => void) | null = null;
const addPluginListener = vi.fn(
  async (_plugin: string, _event: string, handler: (raw: unknown) => void) => {
    shareHandler = handler;
    return { unregister };
  },
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  addPluginListener: (plugin: string, event: string, handler: (raw: unknown) => void) =>
    addPluginListener(plugin, event, handler),
}));

let tauri = true;
vi.mock("@/lib/tauri", () => ({ isTauri: () => tauri }));

const { onPairLink, onShare, takePendingPairLink, takePendingShare } = await import("@/lib/mobile");

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36";

beforeEach(() => {
  vi.clearAllMocks();
  shareHandler = null;
  tauri = true;
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_UA);
});

describe("takePendingShare", () => {
  it("decodes the plugin's base64 files", async () => {
    invoke.mockResolvedValue({
      share: {
        text: "hi",
        subject: "",
        files: [{ name: "a.png", mimeType: "image/png", base64: btoa("\x01\x02") }],
      },
    });
    const share = await takePendingShare();
    expect(invoke).toHaveBeenCalledWith("plugin:blobbies-android|take_pending_share");
    expect(share?.text).toBe("hi");
    expect(share?.files[0]?.name).toBe("a.png");
    expect(Array.from(share?.files[0]?.bytes ?? [])).toEqual([1, 2]);
  });

  it("returns null when nothing is pending", async () => {
    invoke.mockResolvedValue({ share: null });
    expect(await takePendingShare()).toBeNull();
  });

  it("never calls native code off Android", async () => {
    tauri = false;
    expect(await takePendingShare()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("onShare", () => {
  it("forwards share events and unsubscribes", async () => {
    const callback = vi.fn();
    const stop = onShare(callback);
    await Promise.resolve();
    await Promise.resolve();
    expect(addPluginListener).toHaveBeenCalledWith(
      "blobbies-android",
      "share",
      expect.any(Function),
    );
    shareHandler?.({ text: "url", files: [] });
    expect(callback).toHaveBeenCalledWith({ text: "url", subject: "", files: [] });
    stop();
    expect(unregister).toHaveBeenCalled();
  });

  it("is a no-op off Android", () => {
    tauri = false;
    onShare(vi.fn())();
    expect(addPluginListener).not.toHaveBeenCalled();
  });
});

describe("takePendingPairLink", () => {
  it("returns the plugin's url once", async () => {
    invoke.mockResolvedValue({ url: "blobbies://pair#abc" });
    expect(await takePendingPairLink()).toBe("blobbies://pair#abc");
    expect(invoke).toHaveBeenCalledWith("plugin:blobbies-android|take_pending_pair_link");
    invoke.mockResolvedValue({ url: null });
    expect(await takePendingPairLink()).toBeNull();
  });

  it("is null off Android without calling the plugin", async () => {
    tauri = false;
    expect(await takePendingPairLink()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("onPairLink", () => {
  it("forwards pairLink events and unsubscribes", async () => {
    const callback = vi.fn();
    const stop = onPairLink(callback);
    await vi.waitFor(() => expect(shareHandler).not.toBeNull());
    expect(addPluginListener).toHaveBeenCalledWith(
      "blobbies-android",
      "pairLink",
      expect.any(Function),
    );
    shareHandler?.({ url: "blobbies://pair#xyz" });
    expect(callback).toHaveBeenCalledWith("blobbies://pair#xyz");
    stop();
    expect(unregister).toHaveBeenCalled();
  });

  it("is a no-op off Android", () => {
    tauri = false;
    onPairLink(vi.fn())();
    expect(addPluginListener).not.toHaveBeenCalled();
  });
});
