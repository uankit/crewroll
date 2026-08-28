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
  StartTripBody,
  SyncQuery,
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

export function validRegistrationHeaders(): DeviceRegistrationHeaders {
  return {
    authorization: "Bearer clerk-session-token",
    "idempotency-key": IDS.idempotency,
  };
}

export function validMobileCommandHeaders(): MobileCommandHeaders {
  return {
    authorization: "Bearer background-device-token",
    "x-crewroll-device-id": IDS.device,
    "idempotency-key": IDS.idempotency,
  };
}

export function validMobileQueryHeaders(): MobileQueryHeaders {
  return {
    authorization: "Bearer background-device-token",
    "x-crewroll-device-id": IDS.device,
  };
}

export function validRegisterDeviceBody(): RegisterDeviceBody {
  return {
    installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
    platform: "ios",
    authenticationKeyAlgorithm: "P-256",
    authenticationPublicKey: "AQID",
    authenticationKeyVersion: 1,
    e2eeKeyAlgorithm: "X25519",
    e2eePublicKey: "BAUG",
    e2eeKeyVersion: 1,
    pushToken: "ExponentPushToken[fixture]",
    appVersion: "1.0.0",
  };
}

export const validDeviceBody = validRegisterDeviceBody;

export function validUpdatePushTokenBody(): UpdatePushTokenBody {
  return { pushToken: "ExponentPushToken[fixture-next]", appVersion: "1.0.1" };
}

export function validImmediateTripBody(): CreateTripBody {
  return {
    name: "Ladakh",
    inviteCode: "ABCD2345",
    release: { mode: "IMMEDIATE" },
    endsAt: "2026-09-02T12:00:00.000Z",
    ownerDeviceId: IDS.device,
    ownerKeyEnvelope: { keyEpoch: 1, algorithmVersion: 1, wrappedKey: "AQID" },
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
  return { keyEpoch: 1, algorithmVersion: 1, wrappedKey: "AQID" };
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
      { variant: "PREVIEW", ciphertextBytes: "262144", checksumSha256: SHA256_BASE64 },
      { variant: "ORIGINAL", ciphertextBytes: "10485760", checksumSha256: SHA256_BASE64 },
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
  return { assetId: IDS.asset, savedAt: "2026-08-29T12:05:00.000Z", engineRevision: 12 };
}

export function validSyncQuery(): SyncQuery {
  return { cursor: "cur_AQID_20260829", limit: "50" };
}

export function validReconciliationQuery(): ReconciliationQuery {
  return { cursor: "rec_AQID_20260829", limit: "100" };
}
