export interface PostgresBarrier {
  arrive(): Promise<void>;
}

export function createPostgresBarrier(participants: number): PostgresBarrier {
  if (!Number.isInteger(participants) || participants < 1) {
    throw new Error("Postgres barrier participants must be a positive integer");
  }

  let arrived = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    async arrive() {
      arrived += 1;
      if (arrived > participants) {
        throw new Error("Postgres barrier received too many participants");
      }
      if (arrived === participants) release?.();
      await released;
    },
  };
}
