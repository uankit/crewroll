import { AsyncLocalStorage } from "node:async_hooks";
import { httpServerHandler } from "cloudflare:node";
import type { AppDependencies } from "../src/app/dependencies.js";
import { buildApp } from "../src/app/buildApp.js";
import { createSafeLogger } from "../src/shared/observability/safeLogger.js";

// Compile only static schemas/routes at isolate startup. Connections, credentials
// and actors stay inside the current request's AsyncLocalStorage frame.
const scope = new AsyncLocalStorage<AppDependencies>();
function current(): AppDependencies {
  const dependencies = scope.getStore();
  if (!dependencies) throw new Error("CrewRoll request scope missing");
  return dependencies;
}
const media = () => {
  const service = current().media;
  if (!service) throw new Error("CrewRoll media service missing");
  return service;
};
const lifecycle: NonNullable<AppDependencies["trips"]["lifecycle"]> = {
  list: (...args) => current().trips.lifecycle!.list(...args),
  read: (...args) => current().trips.lifecycle!.read(...args),
  change: (...args) => current().trips.lifecycle!.change(...args),
  drained: (...args) => current().trips.lifecycle!.drained(...args),
  expire: () => current().trips.lifecycle!.expire(),
};
const logger = createSafeLogger({
  nodeEnvironment: "production",
  logLevel: "info",
});
export const workerApp = buildApp(
  {
    environment: { nodeEnvironment: "production", debugCorsOrigins: [] },
    logger,
    clock: { now: () => current().clock.now() },
    ids: { uuid: () => current().ids.uuid() },
    readiness: { check: () => current().readiness.check() },
    devices: {
      tokenVerifier: {
        verify: (...args) => current().devices.tokenVerifier.verify(...args),
      },
      registerDevice: {
        execute: (...args) => current().devices.registerDevice.execute(...args),
      },
      revokeDevice: {
        execute: (...args) => current().devices.revokeDevice.execute(...args),
      },
      updateDevicePushToken: {
        execute: (...args) =>
          current().devices.updateDevicePushToken.execute(...args),
      },
    },
    identity: {
      webhookService: {
        handle: (...args) => current().identity.webhookService.handle(...args),
      },
    },
    profile: {
      tokenVerifier: {
        verify: (...args) => current().devices.tokenVerifier.verify(...args),
      },
      syncProfile: {
        execute: (...args) => {
          const profile = current().profile;
          if (!profile) throw new Error("CrewRoll profile service missing");
          return profile.syncProfile.execute(...args);
        },
      },
    },
    trips: {
      lifecycle,
      tokenVerifier: {
        verify: (...args) => current().trips.tokenVerifier.verify(...args),
      },
      resolveForegroundActor: (...args) =>
        current().trips.resolveForegroundActor(...args),
      approveJoinRequest: {
        execute: (...args) =>
          current().trips.approveJoinRequest.execute(...args),
      },
      createTrip: {
        execute: (...args) => current().trips.createTrip.execute(...args),
      },
      previewInvite: {
        execute: (...args) => current().trips.previewInvite.execute(...args),
      },
      getTrip: {
        execute: (...args) => current().trips.getTrip.execute(...args),
      },
      rejectJoinRequest: {
        execute: (...args) =>
          current().trips.rejectJoinRequest.execute(...args),
      },
      requestJoin: {
        execute: (...args) => current().trips.requestJoin.execute(...args),
      },
      resolveCreateTripOutcome: {
        execute: (...args) =>
          current().trips.resolveCreateTripOutcome.execute(...args),
      },
      setTripReadiness: {
        execute: (...args) => current().trips.setTripReadiness.execute(...args),
      },
      startTrip: {
        execute: (...args) => current().trips.startTrip.execute(...args),
      },
    },
    media: {
      lifecycle,
      authenticator: {
        authenticate: (...args) => media().authenticator.authenticate(...args),
      },
      service: {
        publishPreview: (...args) => media().service.publishPreview(...args),
        previewFeed: (...args) => media().service.previewFeed(...args),
        previewDownload: (...args) => media().service.previewDownload(...args),
        createUpload: (...args) => media().service.createUpload(...args),
        commit: (...args) => media().service.commit(...args),
        pending: (...args) => media().service.pending(...args),
        download: (...args) => media().service.download(...args),
        saved: (...args) => media().service.saved(...args),
        cleanup: () => media().service.cleanup(),
      },
    },
  },
  { scheduledMediaCleanup: false, isolateStartup: true },
);

await workerApp.ready();
// This is a logical in-isolate HTTP listener, not a public socket or service.
workerApp.server.listen(8080);
export const nodeHttpHandler = httpServerHandler(8080);

export function inRequestScope<T>(
  dependencies: AppDependencies,
  action: () => T,
): T {
  return scope.run(dependencies, action);
}
