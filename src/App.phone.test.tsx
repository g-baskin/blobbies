import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { SharedContent } from "@/lib/mobile";
import { flushRoster } from "@/lib/store";

const phone = vi.hoisted(() => ({
  android: false,
  pending: null as SharedContent | null,
  listener: null as ((content: SharedContent) => void) | null,
}));

vi.mock("@/lib/mobile", () => ({
  isAndroid: () => phone.android,
  isPhoneLayout: () => true,
  takePendingShare: async () => {
    const next = phone.pending;
    phone.pending = null;
    return next;
  },
  takePendingPairLink: async () => null,
  onPairLink: () => () => {},
  onShare: (callback: (content: SharedContent) => void) => {
    phone.listener = callback;
    return () => {
      phone.listener = null;
    };
  },
}));

const ken = {
  id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
  name: "Ken",
  time: "Now",
  snippet: "New Blob. Say hello",
  tone: "blue" as const,
  shape: "sphere" as const,
};

const shell = () => document.querySelector(".app-shell");

// App boots slowly under jsdom on slower machines.
describe("App on a phone", { timeout: 30_000 }, () => {
  beforeEach(() => {
    phone.android = false;
    phone.pending = null;
  });

  it("opens a chat from the list and goes back with the button or Android back", async () => {
    await flushRoster([ken]);
    const user = userEvent.setup();
    render(<App />);
    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    expect(shell()).toHaveClass("phone-list");

    await user.click(await within(conversations).findByRole("button", { name: /^Ken(?! Kai)/ }));
    expect(shell()).toHaveClass("phone-main");

    await user.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(shell()).toHaveClass("phone-list");

    // Android's back gesture arrives as a history pop.
    await user.click(within(conversations).getByRole("button", { name: /^Ken(?! Kai)/ }));
    expect(shell()).toHaveClass("phone-main");
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(shell()).toHaveClass("phone-list");
  });

  it("puts a share into the chosen composer without sending it", async () => {
    await flushRoster([ken]);
    phone.pending = { text: "https://example.com/story", subject: "A story", files: [] };
    const user = userEvent.setup();
    render(<App />);

    const sheet = await screen.findByRole("dialog", { name: "Send to" });
    expect(within(sheet).getByText(/example\.com\/story/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: /^Ken(?! Kai)/ }));

    expect(screen.queryByRole("dialog", { name: "Send to" })).not.toBeInTheDocument();
    const log = await screen.findByRole("log");
    const composer = screen.getByRole("textbox", { name: "Message Ken" }) as HTMLTextAreaElement;
    expect(composer.value).toContain("https://example.com/story");
    expect(within(log).queryByText(/example\.com\/story/)).not.toBeInTheDocument();
  });

  it("opens the sheet for a share that arrives while running", async () => {
    await flushRoster([ken]);
    render(<App />);
    await screen.findByRole("navigation", { name: "Conversations" });
    act(() => phone.listener?.({ text: "hello", subject: "", files: [] }));
    expect(await screen.findByRole("dialog", { name: "Send to" })).toBeInTheDocument();
  });

  it("hides desktop-only settings on Android", async () => {
    phone.android = true;
    await flushRoster([ken]);
    const user = userEvent.setup();
    render(<App />);
    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: /Ken Kai/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Settings/ }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).queryByRole("button", { name: "Updates" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    expect(within(dialog).queryByText("Ollama")).not.toBeInTheDocument();
    expect(within(dialog).getAllByText("Tinfoil").length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "Plugins" }));
    expect(within(dialog).queryByText("Composio")).not.toBeInTheDocument();
  });
  it("shows the full conversation list, not the icon rail, on a phone-width screen", async () => {
    // Every phone is under the desktop's 860px auto-collapse line.
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    try {
      await flushRoster([ken]);
      const { unmount } = render(<App />);
      await screen.findByRole("navigation", { name: "Conversations" });
      expect(document.querySelector(".sidebar")).not.toHaveClass("sidebar-collapsed");
      // Closing an open layer steps history back asynchronously; let that pop
      // land here rather than in the next test's back-gesture check.
      await act(async () => {
        unmount();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
