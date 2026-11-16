import { Redirect } from "expo-router";

export default function JoinTripRoute() {
  return (
    <Redirect href={{ pathname: "/(app)", params: { join: "1" } }} withAnchor />
  );
}
