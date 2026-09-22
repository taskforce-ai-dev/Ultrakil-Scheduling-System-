import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * A dialog is `position: fixed` and centred, so a dialog taller than the
 * window puts its own action row off-screen with nothing able to scroll it
 * back. Measured on the live portal at 1280x720: the Publish dialog listing
 * four unconfirmed-source sections reported its Publish button as visible and
 * enabled at y=745.5, `document.elementFromPoint` returned nothing at its
 * centre, and the click never landed. At 900 and 1100 tall the same dialog
 * published fine. The taller the gate list, the less publishable the run.
 *
 * jsdom has no layout engine, so these tests cannot measure a viewport. What
 * they can do is hold the structure that makes the measurement come out
 * right: a popup capped at the window, one scrolling region in the middle,
 * and an action row that is not inside it.
 */
function openDialog() {
  render(
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this schedule?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p>A gate list that can run to any length.</p>
        </DialogBody>
        <DialogFooter>
          <Button>Publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  const content = document.querySelector("[data-slot=dialog-content]");
  const body = document.querySelector("[data-slot=dialog-body]");
  const footer = document.querySelector("[data-slot=dialog-footer]");
  const header = document.querySelector("[data-slot=dialog-header]");
  return { content, body, footer, header };
}

describe("Dialog layout", () => {
  it("never grows past the window it opens in", () => {
    const { content } = openDialog();

    // The cap is the whole fix: without it the popup's height is its
    // content's, and half of it ends up outside the viewport.
    expect(content).toHaveClass("max-h-[calc(100dvh-2rem)]");
    // A column, so the middle can take the leftover height and the rest
    // keeps its own.
    expect(content).toHaveClass("flex", "flex-col");
  });

  it("scrolls the body and nothing else", () => {
    const { body } = openDialog();

    expect(body).toHaveClass("overflow-y-auto");
    // flex-1 takes the height left over; min-h-0 is what lets it be smaller
    // than its content, which is the whole point of the scroll region.
    expect(body).toHaveClass("flex-1", "min-h-0");
  });

  it("keeps the actions and the header out of the scrolling region", () => {
    const { body, footer, header } = openDialog();

    // The decision lives in the footer. If it scrolls away with the content
    // — or worse, off the bottom of the screen — the dialog cannot be used.
    expect(body?.contains(footer ?? null)).toBe(false);
    expect(body?.contains(header ?? null)).toBe(false);
    expect(footer).toHaveClass("shrink-0");
    expect(header).toHaveClass("shrink-0");
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });

  it("still reaches the actions in a dialog that uses no body", () => {
    // Not every dialog needs a scroll region, and one that forgets it must
    // not be able to strand its buttons: the popup itself scrolls instead.
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save vehicle authorizations?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

    const content = document.querySelector("[data-slot=dialog-content]");
    expect(content).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
  });
});
