import type { AppSessionSnapshot } from "./AppSessionProvider";

/** Teardown owns navigation until the previous native session is safely closed. */
export function isSessionTeardown(snapshot: AppSessionSnapshot): boolean {
  return (
    snapshot.phase === "SIGNING_OUT" ||
    (snapshot.phase === "RECOVERABLE_FAILURE" &&
      snapshot.publicErrorCode === "SESSION_TEARDOWN_FAILED")
  );
}
