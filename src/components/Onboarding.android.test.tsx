import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Onboarding } from "@/components/Onboarding";

vi.mock("@/lib/mobile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile")>()),
  isAndroid: () => true,
}));

describe("onboarding on Android", () => {
  it("lets a user without a Tinfoil key finish, since the key step is the last one", async () => {
    const onDone = vi.fn();
    render(
      <Onboarding
        onDone={onDone}
        userName="Ken"
        onUserNameChange={() => {}}
        timezone="auto"
        onTimezoneChange={() => {}}
      />,
    );
    // Advance to the key step: every step before it has a Next/Get started.
    for (let i = 0; i < 10 && !screen.queryByText("Give your Blobs a brain"); i++) {
      const forward =
        screen.queryByRole("button", { name: /get started/i }) ??
        screen.getByRole("button", { name: /^next$/i });
      fireEvent.click(forward);
    }
    expect(await screen.findByText("Give your Blobs a brain")).toBeInTheDocument();
    // No local model on a phone, so the skip copy must not promise one.
    expect(screen.queryByText(/local model/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
