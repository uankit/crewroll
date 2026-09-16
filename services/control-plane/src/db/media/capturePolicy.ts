/** Paused photos stay private even after sharing resumes. Half-open intervals. */
export function captureAllowed(
  capturedAt: Date,
  input: {
    startsAt?: Date;
    endsAt: Date;
    endingAt: Date | null;
    leavingAt: Date | null;
    pausedAt: Date | null;
    pauses: readonly { from: string; until: string | null }[];
  },
): boolean {
  const captured = capturedAt.getTime();
  const cutoff = Math.min(
    input.endsAt.getTime(),
    input.endingAt?.getTime() ?? Infinity,
    input.leavingAt?.getTime() ?? Infinity,
  );
  if (
    !Number.isFinite(captured) ||
    captured < (input.startsAt?.getTime() ?? -Infinity) ||
    captured > cutoff ||
    (input.pausedAt && captured >= input.pausedAt.getTime())
  )
    return false;
  return !input.pauses.some(
    (p) =>
      captured >= Date.parse(p.from) &&
      (p.until === null || captured < Date.parse(p.until)),
  );
}
