/** Loaded only for the website's authenticated deletion flow. */
export async function bootAccountDeletion() {
  if (
    location.pathname !== "/delete-account" ||
    new URL(location.href).searchParams.has("request")
  )
    return;
  const area = document.getElementById("account-action");
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://clerk.crewroll.app/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
      script.crossOrigin = "anonymous";
      script.dataset.clerkPublishableKey = "pk_live_Y2xlcmsuY3Jld3JvbGwuYXBwJA";
      const timeout = setTimeout(() => reject(new Error("timeout")), 15000);
      script.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("load"));
      };
      document.head.append(script);
    });
    await window.Clerk.load({ telemetry: { disabled: true } });
    if (!window.Clerk.user) return;
    area.replaceChildren();
    const account = document.createElement("p");
    account.textContent =
      "Signed in as " +
      (window.Clerk.user.primaryEmailAddress?.emailAddress ??
        "your CrewRoll account");
    const warning = document.createElement("p");
    warning.textContent =
      "Deleting your account is permanent. Trips you host will end. Photos already saved to anyone’s library will stay there.";
    const button = document.createElement("button");
    button.className = "button";
    button.textContent = "Delete my account";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const switchAccount = document.createElement("button");
    switchAccount.className = "text-button";
    switchAccount.textContent = "Use another account";
    switchAccount.onclick = () =>
      window.Clerk.signOut({
        redirectUrl: "https://crewroll.app/delete-account",
      });
    button.onclick = async () => {
      if (
        !window.confirm(
          "Permanently delete this CrewRoll account and end trips you host?",
        )
      )
        return;
      button.disabled = true;
      switchAccount.disabled = true;
      status.textContent = "Saving your request…";
      try {
        const token = await window.Clerk.session.getToken();
        const response = await fetch("/account-deletion", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "X-CrewRoll-Confirmation": "DELETE",
          },
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error("request");
        const receipt = await response.json();
        const destination =
          "/delete-account?request=" + encodeURIComponent(receipt.requestId);
        sessionStorage.setItem("crewroll-deletion-receipt", destination);
        try {
          await window.Clerk.signOut({
            redirectUrl: "https://crewroll.app" + destination,
          });
        } catch {
          location.replace(destination);
        }
      } catch {
        status.textContent = "We couldn’t save your request. Please try again.";
        button.disabled = false;
        switchAccount.disabled = false;
      }
    };
    area.append(account, warning, button, switchAccount, status);
  } catch {
    // The ordinary hosted sign-in link remains usable if the SDK fails to load.
    const note = document.createElement("p");
    note.textContent =
      "If sign-in does not return you here, reopen this page after signing in.";
    area.append(note);
  }
}
