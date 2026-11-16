import type { AppStartupState } from "./startupState";

/** Fixed public copy follows the operation that is actually running. */
export function startupPresentation(startup: AppStartupState): Readonly<{
  title: string;
  message: string;
}> {
  if (startup.status === "failed") {
    switch (startup.error?.code) {
      case "SESSION_TEARDOWN_FAILED":
        return {
          title: "Finish signing out.",
          message:
            "CrewRoll could not finish signing out safely. Try again to stop transfers and close this session.",
        };
      case "ACCOUNT_SETUP_FAILED":
        return {
          title: "Check your account.",
          message: "Your account check couldn’t finish. Try again.",
        };
      case "DEVICE_SETUP_FAILED":
        return {
          title: "Restore this phone.",
          message:
            "Your saved session couldn’t be restored on this phone. Try again.",
        };
      case "LOCAL_STORAGE_LOCKED":
        return {
          title: "Unlock this phone.",
          message:
            "Unlock your phone, then try again to open its protected saved session.",
        };
      case "LOCAL_KEYS_UNAVAILABLE":
        return {
          title: "Restore access on this phone.",
          message:
            "CrewRoll could not safely open this phone’s saved access. Try again, or use your account controls to continue with recovery.",
        };
      case "TRIP_LIST_FAILED":
        return {
          title: "Refresh your trips.",
          message: "Your trips couldn’t refresh. Try again.",
        };
      case "TRIP_ACTIVATION_FAILED":
        return {
          title: "Sharing is paused on this phone",
          message: "Reconnect sharing to continue with this trip.",
        };
      case "TRIP_RECOVERY_FAILED":
      default:
        return {
          title: "Check your trip.",
          message:
            "Saved trip state couldn’t be restored. Try again to continue safely.",
        };
    }
  }

  switch (startup.stage) {
    case "account":
      return {
        title: "Checking your account",
        message: "Checking your saved account details.",
      };
    case "device":
      return {
        title: "Restoring this phone",
        message: "Restoring your saved session on this phone.",
      };
    case "recovery":
      return {
        title: "Checking saved trip state",
        message: "Checking saved trip requests before continuing.",
      };
    case "trips":
      return {
        title: "Getting your trips ready",
        message: "Your trips will appear here as they load.",
      };
    case "transfer":
      return {
        title: "Preparing photo sharing",
        message: "You can view your trips while photo sharing gets ready.",
      };
    case "ready":
      return { title: "Ready", message: "Your trips are ready." };
  }
}
