import { fireEvent, render } from "@testing-library/react-native";

import { HomeScreen } from "@/features/home";

describe("HomeScreen", () => {
  test("explains the CrewRoll promise before asking the member to act", async () => {
    const screen = await render(
      <HomeScreen onCreateTrip={jest.fn()} onJoinTrip={jest.fn()} />,
    );

    screen.getByRole("header", {
      name: "Every trip photo. On every phone.",
    });
    screen.getByText(
      "Keep using your normal camera. CrewRoll privately delivers each eligible photo to everyone in the trip.",
    );
    screen.getByText("No active trip");
    screen.getByText(
      "Photos stay on your phones. Temporary encrypted copies are deleted.",
    );
  });

  test("exposes create and join as distinct accessible actions", async () => {
    const onCreateTrip = jest.fn();
    const onJoinTrip = jest.fn();
    const screen = await render(
      <HomeScreen onCreateTrip={onCreateTrip} onJoinTrip={onJoinTrip} />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "Create a trip" }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Join a trip" }));

    expect(onCreateTrip).toHaveBeenCalledTimes(1);
    expect(onJoinTrip).toHaveBeenCalledTimes(1);
  });
});
