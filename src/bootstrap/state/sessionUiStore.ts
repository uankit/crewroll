import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

const INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export function normalizeInviteCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return INVITE_CODE_PATTERN.test(normalized) ? normalized : null;
}

export type SessionUiState = Readonly<{
  pendingInviteCode: string | null;
  setPendingInvite(value: string): boolean;
  clear(): void;
}>;

export const sessionUiStore = createStore<SessionUiState>((set) => ({
  pendingInviteCode: null,
  setPendingInvite(value) {
    const normalized = normalizeInviteCode(value);
    set({ pendingInviteCode: normalized });
    return normalized !== null;
  },
  clear() {
    set({ pendingInviteCode: null });
  },
}));

export function usePendingInviteCode(): string | null {
  return useStore(sessionUiStore, (state) => state.pendingInviteCode);
}
