import { Redirect } from "expo-router";
import { lazy, Suspense } from "react";

const DevelopmentSurface = lazy(
  () => import("@/bootstrap/DevelopmentAcceptanceSurface"),
);

export function acceptanceRouteEnabled(development: boolean): boolean {
  return development;
}

export function StagingAcceptanceGate({
  development,
}: Readonly<{ development: boolean }>) {
  if (!acceptanceRouteEnabled(development))
    return <Redirect href="/" withAnchor />;
  return (
    <Suspense fallback={null}>
      <DevelopmentSurface />
    </Suspense>
  );
}

export default function StagingAcceptanceRoute() {
  return <StagingAcceptanceGate development={__DEV__} />;
}
