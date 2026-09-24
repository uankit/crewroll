import { Redirect } from "expo-router";
import { useAccountSetup } from "@/bootstrap/AccountSetup";

export default function AccountSetupRoute() {
  const setup = useAccountSetup();
  return setup.required ? setup.screen : <Redirect href="/" withAnchor />;
}
