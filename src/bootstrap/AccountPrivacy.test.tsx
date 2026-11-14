import { act, fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";

import type { AccountApi } from "../infrastructure/api/crewRollApi";
import {
  clearPendingErasure,
  readPendingErasure,
  rememberPendingErasure,
  type PendingLocalErasure,
} from "../infrastructure/storage/accountLocalData";
import { AccountPrivacyProvider } from "./AccountPrivacy";

jest.mock("../infrastructure/storage/accountLocalData", () => ({
  clearPendingErasure: jest.fn(),
  readPendingErasure: jest.fn(),
  rememberPendingErasure: jest.fn(),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const record: PendingLocalErasure = {
  accountId: "account_one",
  requestId: "40000000-0000-4000-8000-000000000001",
};

function fixture() {
  const api: AccountApi = {
    getAccountPolicy: jest.fn(),
    acceptAccountTerms: jest.fn(),
    requestAccountDeletion: jest.fn(),
    reportSafetyIssue: jest.fn(),
    getBlockedMembers: jest.fn(),
    blockMember: jest.fn(),
    unblockMember: jest.fn(),
  };
  const eraseLocalAccount = jest
    .fn<Promise<void>, [string]>()
    .mockResolvedValue(undefined);
  const signOut = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  return { api, eraseLocalAccount, signOut };
}

describe("account privacy startup gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(rememberPendingErasure).mockResolvedValue(undefined);
    jest.mocked(clearPendingErasure).mockResolvedValue(undefined);
    jest.mocked(readPendingErasure).mockResolvedValue(null);
  });

  it("opens the app only after confirming no local erasure is pending", async () => {
    const f = fixture();
    const view = await render(
      <AccountPrivacyProvider {...f} ready>
        <Text>private app</Text>
      </AccountPrivacyProvider>,
    );
    expect(view.getByText("private app")).toBeOnTheScreen();
    expect(f.eraseLocalAccount).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "stalled"] as const)(
    "keeps private views closed when the erasure journal is %s and retries the read",
    async (failure) => {
      jest.useFakeTimers();
      try {
        let finishOld!: (value: PendingLocalErasure | null) => void;
        const old = new Promise<PendingLocalErasure | null>((resolve) => {
          finishOld = resolve;
        });
        if (failure === "stalled")
          jest.mocked(readPendingErasure).mockReturnValueOnce(old);
        else
          jest
            .mocked(readPendingErasure)
            .mockRejectedValueOnce(new Error("keychain unavailable"));
        const f = fixture();
        const view = await render(
          <AccountPrivacyProvider {...f} ready>
            <Text>private app</Text>
          </AccountPrivacyProvider>,
        );
        await act(async () => {
          await jest.advanceTimersByTimeAsync(10_000);
        });
        expect(view.queryByText("private app")).toBeNull();
        expect(view.getByText("Unlock phone.")).toBeOnTheScreen();
        await act(() => finishOld(null));
        expect(view.queryByText("private app")).toBeNull();
        await fireEvent.press(view.getByRole("button", { name: "Try again" }));
        expect(view.getByText("private app")).toBeOnTheScreen();
        expect(readPendingErasure).toHaveBeenCalledTimes(2);
        expect(f.eraseLocalAccount).not.toHaveBeenCalled();
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it("retains a discovered erasure record until local deletion and sign-out finish", async () => {
    jest.mocked(readPendingErasure).mockResolvedValueOnce(record);
    let finishErase!: () => void;
    const erasing = new Promise<void>((resolve) => {
      finishErase = resolve;
    });
    const f = fixture();
    f.eraseLocalAccount.mockReturnValueOnce(erasing);
    const view = await render(
      <AccountPrivacyProvider {...f} ready>
        <Text>private app</Text>
      </AccountPrivacyProvider>,
    );
    expect(view.queryByText("private app")).toBeNull();
    expect(rememberPendingErasure).toHaveBeenCalledWith(record);
    expect(f.eraseLocalAccount).toHaveBeenCalledWith(record.accountId);
    expect(f.signOut).not.toHaveBeenCalled();
    expect(clearPendingErasure).not.toHaveBeenCalled();
    await act(() => finishErase());
    expect(f.signOut).toHaveBeenCalledTimes(1);
    expect(clearPendingErasure).toHaveBeenCalledTimes(1);
    expect(view.queryByText("private app")).toBeNull();
    expect(view.getByRole("button", { name: "Done" })).toBeOnTheScreen();
  });

  it.each(["remember", "erase", "sign-out", "clear"] as const)(
    "keeps the erasure receipt retryable after a stalled %s step",
    async (stage) => {
      jest.useFakeTimers();
      try {
        jest.mocked(readPendingErasure).mockResolvedValueOnce(record);
        let finishOld!: () => void;
        const stalled = new Promise<void>((resolve) => {
          finishOld = resolve;
        });
        const f = fixture();
        switch (stage) {
          case "remember":
            jest.mocked(rememberPendingErasure).mockReturnValueOnce(stalled);
            break;
          case "erase":
            f.eraseLocalAccount.mockReturnValueOnce(stalled);
            break;
          case "sign-out":
            f.signOut.mockReturnValueOnce(stalled);
            break;
          case "clear":
            jest.mocked(clearPendingErasure).mockReturnValueOnce(stalled);
            break;
        }
        const view = await render(
          <AccountPrivacyProvider {...f} ready>
            <Text>private app</Text>
          </AccountPrivacyProvider>,
        );
        await act(async () => {
          await jest.advanceTimersByTimeAsync(30_000);
        });
        expect(view.queryByText("private app")).toBeNull();
        expect(
          view.getByText(/Your deletion request is saved/),
        ).toBeOnTheScreen();
        expect(view.queryByRole("button", { name: "Done" })).toBeNull();
        if (stage !== "clear")
          expect(clearPendingErasure).not.toHaveBeenCalled();
        await fireEvent.press(view.getByRole("button", { name: "Try again" }));
        expect(view.getByRole("button", { name: "Done" })).toBeOnTheScreen();
        const clears = jest.mocked(clearPendingErasure).mock.calls.length;
        await act(() => finishOld());
        expect(clearPendingErasure).toHaveBeenCalledTimes(clears);
        expect(view.queryByText("private app")).toBeNull();
        expect(view.getByRole("button", { name: "Done" })).toBeOnTheScreen();
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    },
  );
});
