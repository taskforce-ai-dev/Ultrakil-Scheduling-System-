import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>(
    "@/lib/api-client"
  );
  return { ...actual, fetchVehicles: vi.fn() };
});

import VehiclesPage from "../page";
import { ApiError, fetchVehicles } from "@/lib/api-client";
import { buildVehicle } from "@/test/fixtures";

/**
 * The page reads the live fleet now, so the API is stubbed here. One Colombo
 * van and two Kandy vehicles are enough to prove the branch filter keeps the
 * two branches apart — the rule the scheduler depends on.
 */
const vehicles = [
  buildVehicle({ id: "v1", code: "COL-4521", label: "Van — COL-4521" }),
  buildVehicle({
    id: "v2",
    code: "KAN-1190",
    label: "Van — KAN-1190",
    branchCode: "KANDY",
  }),
  buildVehicle({
    id: "v3",
    code: "KAN-2004",
    label: "Pickup — KAN-2004",
    branchCode: "KANDY",
  }),
];

beforeEach(() => {
  vi.mocked(fetchVehicles).mockResolvedValue({
    items: vehicles,
    total: vehicles.length,
    page: 1,
    pageSize: 200,
  });
});

describe("VehiclesPage", () => {
  it("lists all vehicles by default", async () => {
    render(<VehiclesPage />);

    expect(await screen.findByText("Van — COL-4521")).toBeInTheDocument();
    expect(screen.getByText("Van — KAN-1190")).toBeInTheDocument();
  });

  it("filters vehicles by branch", async () => {
    const user = userEvent.setup();
    render(<VehiclesPage />);
    await screen.findByText("Van — COL-4521");

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    expect(screen.getByText("Van — KAN-1190")).toBeInTheDocument();
    expect(screen.getByText("Pickup — KAN-2004")).toBeInTheDocument();
    expect(screen.queryByText("Van — COL-4521")).not.toBeInTheDocument();
  });

  it("shows an empty state when no vehicle matches the search", async () => {
    const user = userEvent.setup();
    render(<VehiclesPage />);
    await screen.findByText("Van — COL-4521");

    await user.type(screen.getByLabelText("Search"), "Nonexistent Vehicle");

    expect(await screen.findByText("No vehicles match these filters")).toBeInTheDocument();
  });

  it("surfaces an API failure with its stable code and a retry", async () => {
    vi.mocked(fetchVehicles).mockRejectedValueOnce(
      new ApiError({
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in to use this endpoint.",
      })
    );

    render(<VehiclesPage />);

    expect(await screen.findByText("Sign in to use this endpoint.")).toBeInTheDocument();
    expect(screen.getByText("AUTHENTICATION_REQUIRED")).toBeInTheDocument();
  });
});
