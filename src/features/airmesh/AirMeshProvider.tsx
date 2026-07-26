import type { PropsWithChildren } from 'react';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

import type { AirMeshRuntime } from '@/application/runtime/AirMeshRuntime';
import { createAirMeshRuntime } from '@/application/runtime/composition';

const AirMeshContext = createContext<AirMeshRuntime | null>(null);

export interface AirMeshProviderProps extends PropsWithChildren {
  createRuntime?: () => Promise<AirMeshRuntime>;
  fallback: React.ReactNode;
  onBootstrapError: (message: string) => React.ReactNode;
}

export function AirMeshProvider({
  children,
  createRuntime = createAirMeshRuntime,
  fallback,
  onBootstrapError,
}: AirMeshProviderProps) {
  const [runtime, setRuntime] = useState<AirMeshRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let created: AirMeshRuntime | null = null;
    void createRuntime()
      .then(async (value) => {
        created = value;
        await value.initialize();
        if (mounted) setRuntime(value);
      })
      .catch((reason: unknown) => {
        if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      mounted = false;
      if (created) void created.dispose().catch(() => undefined);
    };
  }, [createRuntime]);

  if (error) return onBootstrapError(error);
  if (!runtime) return fallback;
  return <AirMeshContext.Provider value={runtime}>{children}</AirMeshContext.Provider>;
}

export function useAirMeshRuntime(): AirMeshRuntime {
  const runtime = useContext(AirMeshContext);
  if (!runtime) throw new Error('useAirMeshRuntime must be used inside AirMeshProvider.');
  return runtime;
}

export function useAirMesh() {
  const runtime = useAirMeshRuntime();
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  return { runtime, snapshot };
}
