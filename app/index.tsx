import { useRouter } from "expo-router";

import { HomeScreen } from "@/features/home";

export default function HomeRoute() {
  const router = useRouter();

  return (
    <HomeScreen
      onCreateTrip={() => router.push("/trips/create")}
      onJoinTrip={() => router.push("/trips/join")}
    />
  );
}
