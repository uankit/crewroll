import { useTripPhotoAdmission } from "@/bootstrap/useTripPhotoAdmission";
import { AccountMenu } from "@/bootstrap/AccountMenu";
import { Redirect, useIsFocused, useRouter } from "expo-router";
import { useState } from "react";

import { useAppSession } from "@/bootstrap";
import {
  CreateTripScreen,
  type CreateTripInput,
  type CreateTripScreenState,
} from "@/features/trips";

export default function CreateTripRoute() {
  const router = useRouter();
  const focused = useIsFocused();
  const { actions, retry, snapshot, capabilities } = useAppSession();
  const [now] = useState(() => new Date());
  const [state, setState] = useState<CreateTripScreenState>({
    kind: "editing",
  });

  const [draft, setDraft] = useState<CreateTripInput | null>(null);
  const admission = useTripPhotoAdmission(
    focused &&
      state.kind === "editing" &&
      snapshot.phase === "READY_NO_TRIP" &&
      capabilities.canMutateTrip,
    () => router.dismissTo("/(app)"),
  );

  if (
    state.kind === "editing" &&
    (snapshot.phase !== "READY_NO_TRIP" ||
      actions === null ||
      !capabilities.canMutateTrip)
  ) {
    return <Redirect href="/(app)" withAnchor />;
  }

  if (!admission.ready) return admission.screen;

  return (
    <CreateTripScreen
      accountControl={<AccountMenu />}
      now={now}
      {...(draft
        ? { initialName: draft.name, initialEndsAt: new Date(draft.endsAt) }
        : {})}
      onCancel={() => router.dismissTo("/(app)")}
      onDraftChange={setDraft}
      onCreate={(input) => {
        if (actions === null || !capabilities.canMutateTrip) return;
        setDraft(input);
        setState({ kind: "submitting" });
        void actions
          .create(input)
          .then((result) => {
            router.replace(`/trips/${result.tripId}`);
          })
          .catch((failure: unknown) => {
            if (admission.block(failure)) {
              setState({ kind: "editing" });
              return;
            }
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
