import type {
  AssetPage,
  DurableEngineSnapshot,
} from "@crewroll/contracts/native/protocol";
import {
  defaultGalleryFilters,
  type GalleryFilters,
} from "../domain/trips/galleryFilters";

export type GalleryData = Readonly<{
  snapshot: DurableEngineSnapshot;
  assets: AssetPage;
}>;

/** One bounded gallery page, owned by one account session and one trip. No photo bytes. */
export function createTripGalleryCache(
  tripId: string,
  scope: Readonly<{
    opaqueAccountScope: string;
    deviceId: string;
  }> | null = null,
) {
  const initial = () => ({
    filters: defaultGalleryFilters,
    cursor: null as string | null,
    data: null as GalleryData | null,
  });
  let state = initial();
  let scrollY = 0;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const clear = () => {
    generation += 1;
    scrollY = 0;
    state = initial();
    notify();
  };
  return Object.freeze({
    tripId,
    scope,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    token: () => generation,
    accepts: (token: number) => !disposed && token === generation,
    save(token: number, data: GalleryData) {
      if (disposed || token !== generation) return false;
      if (
        data.snapshot.activeTripId !== tripId ||
        (data.assets.activeTripId !== undefined &&
          data.assets.activeTripId !== tripId) ||
        (data.assets.items.some((asset) => asset.previewUri) &&
          data.assets.activeTripId !== tripId)
      ) {
        clear();
        return false;
      }
      if (JSON.stringify(state.data) !== JSON.stringify(data)) {
        state = { ...state, data };
        notify();
      }
      return true;
    },
    setFilters(filters: GalleryFilters) {
      if (disposed || JSON.stringify(filters) === JSON.stringify(state.filters))
        return;
      generation += 1;
      scrollY = 0;
      state = { filters, cursor: null, data: null };
      notify();
    },
    setCursor(cursor: string | null) {
      if (disposed || cursor === state.cursor) return;
      generation += 1;
      scrollY = 0;
      state = { ...state, cursor, data: null };
      notify();
    },
    getScrollY: () => scrollY,
    saveScrollY(value: number) {
      if (!disposed && Number.isFinite(value)) scrollY = Math.max(0, value);
    },
    clear,
    dispose() {
      disposed = true;
      clear();
    },
  });
}

export type TripGalleryCache = ReturnType<typeof createTripGalleryCache>;
