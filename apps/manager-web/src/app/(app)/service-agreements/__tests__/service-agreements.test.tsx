import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ServiceAgreementsPage from "../page";

async function openForm() {
  const user = userEvent.setup();
  render(<ServiceAgreementsPage />);
  await user.click(screen.getByRole("button", { name: "Add agreement" }));
  return user;
}

describe("ServiceAgreementsPage", () => {
  it("is reachable by keyboard and exposes accessible labels for every field", async () => {
    await openForm();

    // Every field below is only findable via its associated <label>, so this
    // doubles as the accessible-labelling check.
    expect(screen.getByLabelText("Customer")).toBeInTheDocument();
    expect(screen.getByLabelText("Site")).toBeInTheDocument();
    expect(screen.getByLabelText("Job type")).toBeInTheDocument();
    expect(screen.getByLabelText("Visits")).toBeInTheDocument();
    expect(screen.getByLabelText("Crew size")).toBeInTheDocument();
    expect(screen.getByLabelText("Start date")).toBeInTheDocument();

    // Opening the drawer moves focus inside it (a focus trap, so keyboard
    // users never land back on the page behind it) — straight onto the
    // first field, with no wasted tab stops.
    expect(screen.getByLabelText("Customer")).toHaveFocus();
  });

  it("requires a start date and at least one allowed day before saving", async () => {
    const user = await openForm();

    // Save is disabled with no allowed day selected at all.
    expect(screen.getByRole("button", { name: "Save agreement" })).toBeDisabled();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    expect(screen.getByRole("button", { name: "Save agreement" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Save agreement" }));
    expect(await screen.findByText("Start date is required")).toBeInTheDocument();
    // The drawer is still open — submission was blocked, not completed.
    expect(screen.getByLabelText("Customer")).toBeInTheDocument();
  });

  it("prevents marking a day preferred before it is allowed (subset enforcement)", async () => {
    await openForm();

    const fridayPreferred = document.getElementById("preferred-FRIDAY");
    expect(fridayPreferred).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));

    // Once Monday is allowed, Monday becomes selectable as preferred...
    const mondayPreferred = document.getElementById("preferred-MONDAY");
    expect(mondayPreferred).toBeEnabled();
    // ...but Friday, still not allowed, stays disabled.
    expect(document.getElementById("preferred-FRIDAY")).toBeDisabled();
  });

  it("un-checking an allowed day also drops it from preferred", async () => {
    const user = await openForm();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.click(screen.getByLabelText("Mon", { selector: "#preferred-MONDAY" }));
    expect(document.getElementById("preferred-MONDAY")).toBeChecked();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    expect(document.getElementById("preferred-MONDAY")).not.toBeChecked();
    expect(document.getElementById("preferred-MONDAY")).toBeDisabled();
  });

  it("warns when visits per week exceed the number of allowed days, and blocks saving", async () => {
    const user = await openForm();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    const visits = screen.getByLabelText("Visits");
    await user.clear(visits);
    await user.type(visits, "3");

    expect(
      await screen.findByText(/3 visits\/week requested, but only 1 day\(s\) are allowed/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save agreement" })).toBeDisabled();
  });

  it("shows an error when previewing without a start date", async () => {
    const user = await openForm();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Set a start date to preview the schedule."
    );
  });

  it("shows a loading state then the computed preview on success", async () => {
    const user = await openForm();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), "2026-01-05");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.getByRole("button", { name: "Loading…" })).toBeInTheDocument();
    expect(await screen.findByText(/2026-01-05/)).toBeInTheDocument();
  });

  it("adds a new agreement to the table on save", async () => {
    const user = await openForm();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), "2026-01-05");
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3); // header + seeded row + the new one
    expect(within(rows[2]).getByText("Cinnamon Grand Colombo")).toBeInTheDocument();
  });
});
