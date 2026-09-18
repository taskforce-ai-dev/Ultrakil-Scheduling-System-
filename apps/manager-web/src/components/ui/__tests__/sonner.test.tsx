import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Toaster, TOAST_DURATION_MS } from "@/components/ui/sonner";
import { notify } from "@/lib/notify";

/**
 * A confirmation must not become an obstacle.
 *
 * A dispatch coordinator saved a crew change, realised it was wrong, and
 * clicked "Remove crew" — and nothing happened: no request, no message. The
 * success toast had landed on top of the drawer's footer buttons and taken
 * the click, and it was still there a minute later, because sonner pauses a
 * toast's dismiss timer while the pointer is over it and the pointer had been
 * left sitting on the toast by that very click. Undo is what a coordinator
 * reaches for under pressure, so a confirmation that eats it is worse than no
 * confirmation at all.
 */
describe("the portal's notification surface", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    // Sonner's queue is module-global: a toast left standing by one test is
    // still standing in the next one.
    act(() => {
      toast.dismiss();
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it("clears a confirmation on its own after a few seconds", async () => {
    render(<Toaster />);

    act(() => {
      notify.success("Assignment saved. The reason is on this visit's history.");
    });
    expect(await screen.findByText(/^Assignment saved\./)).toBeInTheDocument();

    act(() => {
      // The dismiss timer, plus sonner's exit animation before unmount.
      vi.advanceTimersByTime(TOAST_DURATION_MS + 1_000);
    });

    await waitFor(() => {
      expect(screen.queryByText(/^Assignment saved\./)).not.toBeInTheDocument();
    });
  });

  it("lets a manager dismiss a confirmation by hand", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Toaster />);

    act(() => {
      notify.success("Crew removed. The visit is back in the Unassigned queue.");
    });
    expect(await screen.findByText(/^Crew removed\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => {
      expect(screen.queryByText(/^Crew removed\./)).not.toBeInTheDocument();
    });
  });

  it("stays clear of the bottom edge, where every overlay keeps its actions", async () => {
    render(<Toaster />);

    act(() => {
      notify.success("Assignment saved. The reason is on this visit's history.");
    });
    await screen.findByText(/^Assignment saved\./);

    // Drawers and dialogs pin Save / Remove crew / Publish to their own
    // bottom edge. A toast anchored there is a toast on top of the decision.
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).not.toBeNull();
    expect(toaster).toHaveAttribute("data-y-position", "top");
  });

  it("takes no pointer events except on its close button", async () => {
    render(<Toaster />);

    act(() => {
      notify.success("Assignment saved. The reason is on this visit's history.");
    });
    await screen.findByText(/^Assignment saved\./);

    // jsdom does no hit-testing, so this pins the mechanism rather than the
    // symptom: the whole toast stack is transparent to the pointer, which is
    // what stops it swallowing a click meant for the button underneath — and
    // what stops it from ever being "hovered" into pausing its own timer.
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster?.className).toContain("pointer-events-none");
    expect(screen.getByRole("button", { name: /close/i }).className).toContain(
      "pointer-events-auto",
    );
  });
});
