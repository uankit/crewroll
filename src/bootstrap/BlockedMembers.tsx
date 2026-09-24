import { useEffect, useRef, useState } from "react";
import { AppText, Button, Stack } from "../design-system";
import type { BlockedMembers as Members } from "@crewroll/contracts";
import { useAccountPrivacy } from "./AccountPrivacy";

export function BlockedMembers() {
  const privacy = useAccountPrivacy();
  const [items, setItems] = useState<Members["items"] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const working = useRef(false);
  const api = privacy?.api;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    if (api)
      void api.getBlockedMembers().then(
        (value) => {
          if (active) setItems(value.items);
        },
        () => {
          if (active) setFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [api, attempt]);
  const unblock = async (userId: string) => {
    if (!api || working.current) return;
    working.current = true;
    setBusy(userId);
    setFailed(false);
    try {
      await api.unblockMember(userId);
      setItems(
        (value) => value?.filter((item) => item.userId !== userId) ?? [],
      );
    } catch {
      setFailed(true);
    } finally {
      working.current = false;
      setBusy(null);
    }
  };
  if (failed)
    return (
      <Stack gap="md">
        <AppText tone="secondary" accessibilityRole="alert">
          Couldn’t load blocked people. Please try again.
        </AppText>
        <Button
          label="Try again"
          onPress={() => {
            setFailed(false);
            setItems(null);
            setAttempt((value) => value + 1);
          }}
        />
      </Stack>
    );
  return (
    <Stack gap="sm">
      <AppText tone="secondary">
        Blocked people can’t join a trip with you. Unblocking lets you share a
        future trip again.
      </AppText>
      {items?.length === 0 ? <AppText>No blocked people.</AppText> : null}
      {items === null && !failed ? (
        <AppText tone="secondary">Loading…</AppText>
      ) : null}
      {items?.map((item) => (
        <Stack key={item.userId} gap="xs">
          <AppText>{item.displayName}</AppText>
          <Button
            label={`Unblock ${item.displayName}`}
            variant="text"
            loading={busy === item.userId}
            disabled={busy !== null}
            onPress={() => void unblock(item.userId)}
          />
        </Stack>
      ))}
    </Stack>
  );
}
