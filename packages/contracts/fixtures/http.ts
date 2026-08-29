import type {
  ApproveJoinRequestBody,
  CommitAssetBody,
  CreateDownloadSessionBody,
  CreateJoinRequestBody,
  CreateTripBody,
  CreateUploadSessionBody,
  DeviceRegistrationHeaders,
  EndTripBody,
  MobileCommandHeaders,
  MobileQueryHeaders,
  ReconciliationQuery,
  RegisterDeviceBody,
  SavedReceiptBody,
  SetTripReadinessBody,
  StartTripBody,
  SyncQuery,
  TripResponse,
  UpdatePushTokenBody,
} from "../openapi/index.js";

const IDS = {
  device: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
  trip: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
  membership: "018f0d98-76fa-7d1a-b4b4-1f742c2e3140",
  asset: "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
  upload: "018f0d98-76fa-7d1a-b4b4-1f742c2e3160",
  idempotency: "018f0d98-76fa-7d1a-b4b4-1f742c2e3170",
} as const;

const SHA256_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const P256_PUBLIC_KEY_BASE64 =
  "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=";
const X25519_PUBLIC_KEY_BASE64 = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
const IOS_APNS_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BACKGROUND_BEARER = `crb_${"A".repeat(43)}`;
const TRIP_ENVELOPE_BASE64 =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

export function validRegistrationHeaders(): DeviceRegistrationHeaders {
  return {
    authorization: "Bearer clerk-session-token",
    "idempotency-key": IDS.idempotency,
  };
}

export function validClerkCommandHeaders(): MobileCommandHeaders {
  return {
    authorization: "Bearer clerk-session-token",
    "x-crewroll-device-id": IDS.device,
    "idempotency-key": IDS.idempotency,
  };
}

export function validClerkQueryHeaders(): MobileQueryHeaders {
  return {
    authorization: "Bearer clerk-session-token",
    "x-crewroll-device-id": IDS.device,
  };
}

export function validBackgroundCommandHeaders(): MobileCommandHeaders {
  return {
    authorization: `Bearer ${BACKGROUND_BEARER}`,
    "x-crewroll-device-id": IDS.device,
    "idempotency-key": IDS.idempotency,
  };
}

export function validBackgroundQueryHeaders(): MobileQueryHeaders {
  return {
    authorization: `Bearer ${BACKGROUND_BEARER}`,
    "x-crewroll-device-id": IDS.device,
  };
}

export function validRegisterDeviceBody(): RegisterDeviceBody {
  return {
    installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
    platform: "ios",
    authenticationKeyAlgorithm: "P-256",
    authenticationPublicKey: P256_PUBLIC_KEY_BASE64,
    authenticationKeyVersion: 1,
    e2eeKeyAlgorithm: "X25519",
    e2eePublicKey: X25519_PUBLIC_KEY_BASE64,
    e2eeKeyVersion: 1,
    pushToken: IOS_APNS_TOKEN,
    appVersion: "1.0.0",
  };
}

export const validDeviceBody = validRegisterDeviceBody;

export function validUpdatePushTokenBody(): UpdatePushTokenBody {
  return {
    pushToken: "fcm_fixture_token_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
    appVersion: "1.0.1",
  };
}

export function validImmediateTripBody(): CreateTripBody {
  return {
    tripId: IDS.trip,
    name: "Ladakh",
    inviteCode: "ABCD2345",
    release: { mode: "IMMEDIATE" },
    endsAt: "2026-09-02T12:00:00.000Z",
    ownerDeviceId: IDS.device,
    ownerKeyEnvelope: {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey: TRIP_ENVELOPE_BASE64,
    },
  };
}

export function validNightlyTripBody(): CreateTripBody {
  return {
    ...validImmediateTripBody(),
    release: { mode: "NIGHTLY", timeZone: "Asia/Kolkata", localTime: "21:30" },
  };
}

export function validCreateJoinRequestBody(): CreateJoinRequestBody {
  return { inviteCode: "ABCD2345", deviceId: IDS.device };
}

export function validApproveJoinRequestBody(): ApproveJoinRequestBody {
  return {
    keyEpoch: 1,
    algorithmVersion: 1,
    wrappedKey: TRIP_ENVELOPE_BASE64,
  };
}

export function validSetTripReadinessBody(
  fullPhotoLibraryAccess = true,
): SetTripReadinessBody {
  return { fullPhotoLibraryAccess };
}

export function validTripResponse(
  options: Readonly<{
    version: number;
    fullPhotoLibraryAccess: boolean;
  }> = { version: 1, fullPhotoLibraryAccess: false },
): TripResponse {
  return {
    id: IDS.trip,
    version: options.version,
    name: "Ladakh",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt: "2026-09-02T12:00:00.000Z",
    ownerDeviceId: IDS.device,
    currentMembershipId: IDS.membership,
    keyEpoch: 1,
    tripKeyEnvelope: {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey: TRIP_ENVELOPE_BASE64,
    },
    members: [
      {
        membershipId: IDS.membership,
        role: "OWNER",
        displayName: "Owner",
        status: "ACTIVE",
        readiness: {
          fullPhotoLibraryAccess: options.fullPhotoLibraryAccess,
        },
        nominatedDevice: {
          deviceId: IDS.device,
          e2eeKeyAlgorithm: "X25519",
          e2eePublicKey: X25519_PUBLIC_KEY_BASE64,
          e2eeKeyVersion: 1,
        },
      },
    ],
  };
}

export function validStartTripBody(): StartTripBody {
  return { expectedVersion: 2 };
}

export function validEndTripBody(): EndTripBody {
  return { expectedVersion: 3 };
}

export function validUploadSessionBody(): CreateUploadSessionBody {
  return {
    tripId: IDS.trip,
    assetId: IDS.asset,
    sourceAssetKey: "src_01J6D4M4KB8J8G3AZXJ3PZV1Z9XY",
    capturedAt: "2026-08-29T12:00:00.000Z",
    formatVersion: 1,
    keyEpoch: 1,
    encryptedManifest: "AQID",
    objects: [
      {
        variant: "PREVIEW",
        ciphertextBytes: "262144",
        checksumSha256: SHA256_BASE64,
      },
      {
        variant: "ORIGINAL",
        ciphertextBytes: "10485760",
        checksumSha256: SHA256_BASE64,
      },
    ],
  };
}

export function validCommitAssetBody(): CommitAssetBody {
  return {
    uploadSessionId: IDS.upload,
    objects: [
      { variant: "PREVIEW", etag: "preview-etag" },
      { variant: "ORIGINAL", etag: "original-etag" },
    ],
  };
}

export function validCreateDownloadSessionBody(): CreateDownloadSessionBody {
  return { variants: ["PREVIEW", "ORIGINAL"] };
}

export function validSavedReceiptBody(): SavedReceiptBody {
  return {
    assetId: IDS.asset,
    savedAt: "2026-08-29T12:05:00.000Z",
    engineRevision: 12,
  };
}

export function validSyncQuery(): SyncQuery {
  return { cursor: "cur_AQID_20260829", limit: "50" };
}

export function validReconciliationQuery(): ReconciliationQuery {
  return { cursor: "rec_AQID_20260829", limit: "100" };
}
