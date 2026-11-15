import { fireEvent, render } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "../design-system";
import { TripPhotoOrganizationStatus } from "./TripPhotoOrganizationStatus";

describe("trip photo organization status", () => {
  it("does not promise an album when the installed native binary omits the feature", async () => {
    const view = await render(
      <TripPhotoOrganizationStatus
        organization={undefined}
        onRetry={jest.fn()}
      />,
    );
    expect(view.queryByTestId("trip-photo-organization")).toBeNull();
  });

  it("offers organization retry without claiming that original delivery failed", async () => {
    const retry = jest.fn();
    const view = await render(
      <CrewRollThemeProvider>
        <TripPhotoOrganizationStatus
          organization={{ state: "FAILED", pendingCount: 2, failedCount: 1 }}
          onRetry={retry}
        />
      </CrewRollThemeProvider>,
    );
    view.getByRole("alert", {
      name: "Trip album organization couldn’t finish.",
    });
    await fireEvent.press(
      view.getByRole("button", { name: "Retry album organization" }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
    await view.rerender(
      <CrewRollThemeProvider>
        <TripPhotoOrganizationStatus
          organization={{ state: "FAILED", pendingCount: 2, failedCount: 1 }}
          busy
          onRetry={retry}
        />
      </CrewRollThemeProvider>,
    );
    expect(
      view.getByRole("button", { name: "Retry album organization" }),
    ).toBeDisabled();
    await fireEvent.press(
      view.getByRole("button", { name: "Retry album organization" }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps repair unavailable when sharing and its native authority are paused", async () => {
    const retry = jest.fn();
    const view = await render(
      <CrewRollThemeProvider>
        <TripPhotoOrganizationStatus
          organization={{ state: "FAILED", pendingCount: 1, failedCount: 1 }}
          paused
          onRetry={retry}
        />
      </CrewRollThemeProvider>,
    );
    view.getByText("Album organization is paused.");
    expect(view.queryByRole("button")).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });
});
