import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useUser } from "@clerk/expo";
import { DeviceRecoveryScreen } from "../features/recovery/DeviceRecoveryScreen";
import { useAppSession } from "./AppSessionProvider";
import { useTripContinuity } from "./useTripContinuity";
export function DeviceRecoveryFlow({
  tripId,
  tripName,
  owner,
  onBack,
}: Readonly<{
  tripId: string;
  tripName: string;
  owner: boolean;
  onBack: () => void;
}>) {
  const { actions, retry } = useAppSession();
  const { user } = useUser();
  const query = useTripContinuity(tripId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const working = useRef(false);
  const resumed = useRef(false);
  useEffect(() => {
    if (!query.data?.onThisDevice || resumed.current) return;
    resumed.current = true;
    retry();
    onBack();
  }, [query.data?.onThisDevice, onBack, retry]);
  async function request() {
    if (!actions || working.current) return;
    working.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await actions.requestDeviceRecovery(tripId);
      await query.refetch();
    } catch {
      setFailed(true);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const phoneLabel =
    Platform.OS === "android"
      ? `${Platform.constants.Model ?? "Android phone"} · Android ${Platform.Version}`
      : `iPhone · iOS ${Platform.Version}`;
  const state = query.data;
  return (
    <DeviceRecoveryScreen
      tripName={tripName}
      owner={owner}
      hostName={state?.hostDisplayName ?? "your host"}
      displayName={user?.fullName ?? user?.firstName ?? "You"}
      phoneLabel={phoneLabel}
      status={
        !state
          ? "loading"
          : state.onThisDevice
            ? "resuming"
            : state.status !== "ACTIVE" && state.status !== "LOBBY"
              ? "ended"
              : state.deviceRequest?.status === "PENDING"
                ? "pending"
                : state.deviceRequest?.status === "REJECTED" ||
                    state.deviceRequest?.status === "CANCELLED"
                  ? "rejected"
                  : "confirm"
      }
      busy={busy || (query.isFetching && !state)}
      error={failed || query.isError}
      onRequest={() => void request()}
      onRetry={() => void query.refetch()}
      onBack={onBack}
    />
  );
}
