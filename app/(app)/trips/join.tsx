import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";

import { normalizeInviteCode, useAppSession } from "@/bootstrap";
import {
  JoinTripScreen,
  type JoinTripScreenState,
} from "@/features/invitations";

function safeFailureKind(error: unknown): "INVALID" | "UNKNOWN" | "FAILED" {
  try {
    if (typeof error !== "object" || error === null) return "FAILED";
    const value = error as Readonly<Record<string, unknown>>;
    if (value.kind === "TRANSPORT_UNAVAILABLE") return "UNKNOWN";
    if (value.kind === "API_PROBLEM" && value.code === "INVITE_INVALID") {
      return "INVALID";
    }
  } catch {
    return "FAILED";
  }
  return "FAILED";
}

export default function JoinTripRoute() {
  const params = useLocalSearchParams<{ code?: string | string[] }>();
  const router = useRouter();
  const { actions, retry, snapshot } = useAppSession();
  const routeCode =
    typeof params.code === "string" ? normalizeInviteCode(params.code) : null;
  const [initialCode, setInitialCode] = useState(routeCode ?? "");
  const [state, setState] = useState<JoinTripScreenState>({ kind: "editing" });

  function recoverUnknownJoin() {
    retry();
    router.replace("/(app)");
  }

  function requestJoin(inviteCode: string) {
    if (actions === null) return;
    setState({ kind: "submitting" });
    void actions
      .join(inviteCode)
      .then((result) => {
        if (result.kind === "PENDING_APPROVAL") {
          router.replace("/(app)");
          return;
        }
        if (result.kind === "REJECTED") {
          setState({
            kind: "rejected",
            onUseAnotherCode: () => {
              setInitialCode("");
              setState({ kind: "editing" });
            },
          });
          return;
        }
        router.replace(`/trips/${result.tripId}`);
      })
      .catch((error: unknown) => {
        switch (safeFailureKind(error)) {
          case "INVALID":
            setState({
              kind: "invalid",
              onUseAnotherCode: () => {
                setInitialCode("");
                setState({ kind: "editing" });
              },
            });
            return;
          case "UNKNOWN":
            setState({ kind: "unknown", onRetry: recoverUnknownJoin });
            return;
          case "FAILED":
            setState({
              kind: "failed",
              onRetry: recoverUnknownJoin,
            });
        }
      });
  }

  if (
    state.kind === "editing" &&
    (snapshot.phase !== "READY_NO_TRIP" || actions === null)
  ) {
    return <Redirect href="/(app)" withAnchor />;
  }

  return (
    <JoinTripScreen
      key={initialCode}
      initialCode={initialCode}
      onLookup={async (code) => {
        if (actions === null) throw new Error("Session unavailable");
        return actions.previewInvite(code);
      }}
      onCancel={() => router.back()}
      onJoin={requestJoin}
      state={state}
    />
  );
}
