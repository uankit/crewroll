import { useEffect, useRef, useState } from "react";
import { Keyboard, TextInput } from "react-native";

import { Button, Sheet, TextField } from "../../design-system";
import type { TripInvitePreview } from "../../domain/trips/model";

function normalizeCode(value: string): string {
  return value.replace(/\s/g, "").toUpperCase();
}

type Props = Readonly<{
  initialCode?: string;
  onCodeChange?(code: string): void;
  onDismiss(): void;
  onLookup(code: string): Promise<TripInvitePreview>;
  onFound(code: string, trip: TripInvitePreview): void;
}>;

export function InviteCodeSheet({
  initialCode = "",
  onCodeChange,
  onDismiss,
  onLookup,
  onFound,
}: Props) {
  const input = useRef<TextInput>(null);
  const active = useRef(true);
  const busy = useRef(false);
  const [code, setCode] = useState(() => normalizeCode(initialCode));
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState("");
  const complete = code.length === 8;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function dismiss() {
    active.current = false;
    Keyboard.dismiss();
    onDismiss();
  }
  async function findTrip() {
    if (!active.current || busy.current || !complete) return;
    if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) {
      setError("That code doesn’t look right. Check it with your host.");
      return;
    }
    busy.current = true;
    setFinding(true);
    setError("");
    try {
      const trip = await onLookup(code);
      if (active.current) {
        Keyboard.dismiss();
        onFound(code, trip);
      }
    } catch (failure) {
      if (!active.current) return;
      const invalid =
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        failure.code === "INVITE_INVALID";
      setError(
        invalid
          ? "Trip not found. Check the code with your host."
          : "Couldn’t load this trip. Try again.",
      );
    } finally {
      busy.current = false;
      if (active.current) setFinding(false);
    }
  }
  return (
    <Sheet
      visible
      title="Join a trip"
      onDismiss={dismiss}
      onShow={() => input.current?.focus()}
    >
      <TextField
        ref={input}
        label="Invite code"
        placeholder="8-character code"
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="go"
        value={code}
        disabled={finding}
        onChangeText={(value) => {
          const nextCode = normalizeCode(value);
          setCode(nextCode);
          onCodeChange?.(nextCode);
          setError("");
        }}
        onSubmitEditing={() => void findTrip()}
        {...(error ? { errorMessage: error } : {})}
      />
      <Button
        label="Find trip"
        loading={finding}
        disabled={!complete || finding}
        onPress={() => void findTrip()}
      />
    </Sheet>
  );
}
