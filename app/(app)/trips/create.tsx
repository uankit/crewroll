import { Redirect, useRouter } from "expo-router";
import { useState } from "react";

import { useAppSession } from "@/bootstrap";
import { CreateTripScreen, type CreateTripScreenState } from "@/features/trips";

export default function CreateTripRoute() {
  const router = useRouter();
  const { actions, retry, snapshot } = useAppSession();
  const [now] = useState(() => new Date());
  const [state, setState] = useState<CreateTripScreenState>({
    kind: "editing",
  });

  if (
    state.kind === "editing" &&
    (snapshot.phase !== "READY_NO_TRIP" || actions === null)
  ) {
    return <Redirect href="/(app)" withAnchor />;
  }

  return (
    <CreateTripScreen
      now={now}
      onCancel={() => router.dismissTo("/(app)")}
      onCreate={(input) => {
        if (actions === null) return;
        setState({ kind: "submitting" });
        void actions
          .create(input)
          .then((result) => {
            router.replace(`/trips/${result.tripId}`);
          })
          .catch(() => {
            setState({
              kind: "unknown",
              onCheck: () => {
                retry();
                router.dismissTo("/(app)");
              },
            });
          });
      }}
      state={state}
    />
  );
}
