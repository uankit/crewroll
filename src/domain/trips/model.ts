export const memberStatuses = ["ACTIVE", "PENDING_KEY"] as const;

export type MemberStatus = (typeof memberStatuses)[number];

export type MemberView = Readonly<{
  membershipId: string;
  role: "OWNER" | "MEMBER";
  displayName: string;
  status: MemberStatus;
  fullPhotoLibraryAccess: boolean;
  deviceState: "AVAILABLE" | "MISSING" | "NOT_DISCLOSED";
  isCurrentMember: boolean;
}>;

export type TripReleaseView =
  | Readonly<{ mode: "IMMEDIATE" }>
  | Readonly<{
      mode: "NIGHTLY";
      timeZone: string;
      localTime: string;
    }>;

export type TripView = Readonly<{
  id: string;
  version: number;
  name: string;
  status:
    | "LOBBY"
    | "ACTIVE"
    | "ENDING"
    | "COMPLETE"
    | "INCOMPLETE_EXPIRED"
    | "CANCELLED";
  release: TripReleaseView;
  startsAt: string | null;
  endsAt: string;
  ownerDeviceId: string;
  currentMembershipId: string;
  members: readonly MemberView[];
}>;

export type StartBlocker =
  | "OWNER_ONLY"
  | "NOT_LOBBY"
  | "MEMBER_PENDING_KEY"
  | "MEMBER_NEEDS_FULL_ACCESS"
  | "MEMBER_DEVICE_MISSING";

/** Public invite metadata. It contains no device identifiers or photo keys. */
export type TripInvitePreview = Readonly<{
  tripId: string;
  name: string;
  startsAt: string | null;
  endsAt: string;
  hostDisplayName: string;
  members: readonly Readonly<{
    displayName: string;
    role: "OWNER" | "MEMBER";
  }>[];
}>;

/** Read-only trip library metadata; never contains keys or photo bytes. */
export type TripSummary = Readonly<{
  id: string;
  name: string;
  status: TripView["status"];
  participation: "JOINING" | "JOINED" | "LEAVING" | "LEFT";
  role: "OWNER" | "MEMBER";
  startsAt: string | null;
  endsAt: string;
  leftAt: string | null;
  sharingPaused: boolean;
  onThisDevice: boolean;
  memberCount: number;
  savedPhotoCount: number;
}>;
