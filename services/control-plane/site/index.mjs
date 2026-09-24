import { pages } from "./pages.mjs";
import { bootAccountDeletion } from "./account.mjs";

const css = `*{box-sizing:border-box}html{color-scheme:light;scroll-behavior:smooth}body{margin:0;background:#faf8f3;color:#222b24;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}a{color:inherit;text-underline-offset:4px}a:focus-visible,button:focus-visible{outline:3px solid #c64531;outline-offset:5px}header,footer{max-width:1080px;margin:auto;padding:28px 32px;display:flex;align-items:center;justify-content:space-between;gap:24px}header{border-bottom:1px solid #e6e3dc}.brand{font-size:23px;font-weight:750;letter-spacing:-1px;text-decoration:none}.brand b{color:#c64531}nav{display:flex;gap:24px;font-size:14px}main{max-width:780px;padding:72px 32px 100px;margin:auto;min-height:70vh}h1{font-size:clamp(32px,5vw,52px);line-height:1.1;letter-spacing:-2px;margin:0 0 28px;font-weight:750}h2{font-size:21px;letter-spacing:-.5px;margin:38px 0 8px;line-height:1.3}p{margin:0 0 20px;color:#566157}.lead{font-size:22px;line-height:1.5;margin-bottom:32px;max-width:620px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:2px;margin-bottom:22px;color:#8b493d}.button{display:inline-flex;justify-content:center;align-items:center;padding:15px 25px;min-height:50px;background:#c64531;border:0;border-radius:14px;color:white;font-size:16px;font-weight:600;text-decoration:none;cursor:pointer}.button:hover{background:#a73829}.button:disabled{opacity:.6;cursor:wait}.text-button{border:0;background:none;font:inherit;text-decoration:underline;padding:14px 20px;cursor:pointer;color:inherit}[hidden]{display:none!important}.steps{margin-top:72px;display:grid;gap:32px;grid-template-columns:repeat(3,1fr)}.steps span{color:#b27c63;font-size:13px}.steps h2{margin-top:12px}.steps p{font-size:15px}.note{margin-top:64px;padding:28px;border:1px solid #dfdfd5;border-radius:20px;background:#f3f2e9}.note h2{margin-top:0}.downloads{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin:32px 0}.downloads h2{margin-top:0}.small,footer{font-size:13px;color:#6f766f}footer{border-top:1px solid #e6e3dc;flex-wrap:wrap}footer nav{flex-wrap:wrap;font-size:13px}@media(max-width:600px){header,footer{padding:22px 24px}nav{gap:18px}main{padding:52px 24px 72px}h1{letter-spacing:-1.2px}.lead{font-size:20px}.steps,.downloads{grid-template-columns:1fr;gap:20px}.steps{margin-top:48px}.steps section{border-top:1px solid #e6e3dc;padding-top:24px}.note{margin-top:40px}.button{width:100%}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;

// Invitation material stays in the fragment; never send it to the server.
export function nativeInviteFromFragment(fragment) {
  if (!fragment.startsWith("#v1.") || fragment.length > 8192) return null;
  const encoded = fragment.slice(4);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const binary = atob(
      encoded.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (encoded.length % 4)) % 4),
    );
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    );
    const url = new URL(value);
    return url.protocol === "airmesh:" &&
      url.hostname === "join" &&
      ["", "/"].includes(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.search.length > 1
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const client = `(${bootAccountDeletion.toString()})();
const nativeInviteFromFragment=${nativeInviteFromFragment.toString()};
if(location.pathname==="/join"){
 const invite=nativeInviteFromFragment(location.hash), link=document.getElementById("open-invite");
 if(invite){link.href=invite;link.hidden=false}else{document.getElementById("invite-message").textContent="This invitation is incomplete. Ask your host to share the full link again."}
}
if(location.pathname==="/delete-account"){
 const id=new URL(location.href).searchParams.get("request"), status=document.getElementById("deletion-status");
 if(id&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)){
  document.getElementById("deletion-help").hidden=true;
  async function check(){status.textContent="Checking your request…";try{
   const response=await fetch("/deletion-status/"+id,{cache:"no-store"});if(!response.ok)throw Error();
   const result=await response.json();status.replaceChildren();
   const text=document.createElement("p");text.className="lead";text.textContent=result.status==="COMPLETE"?"Your account has been deleted.":"Your request is saved. Cleanup is in progress.";status.append(text);
   const note=document.createElement("p");note.textContent=result.status==="COMPLETE"?"Photos already saved in anyone’s library remain there.":"This usually takes a few minutes. Allow up to seven days during a service outage.";status.append(note);
   if(result.status!=="COMPLETE")retry("Check again");
  }catch{status.textContent="We couldn’t check this request. Receipts expire after 30 days. Contact support@crewroll.app if you need help.";retry("Try again")}}
  function retry(label){const button=document.createElement("button");button.className="button";button.textContent=label;button.onclick=check;status.append(button)}
  check();
 }
}`;
const headers = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cache-Control": "public, max-age=300",
};
const reply = (body, type, status = 200, extra = {}) =>
  new Response(body, {
    status,
    headers: { ...headers, "Content-Type": type, ...extra },
  });
export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname === "/account-deletion" && request.method === "POST") {
      if (
        !["https://crewroll.app", "https://www.crewroll.app"].includes(
          request.headers.get("Origin"),
        ) ||
        request.headers.get("X-CrewRoll-Confirmation") !== "DELETE"
      )
        return reply("{}", "application/json", 403, {
          "Cache-Control": "no-store",
        });
      const authorization = request.headers.get("Authorization") ?? "";
      if (!/^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(authorization))
        return reply("{}", "application/json", 401, {
          "Cache-Control": "no-store",
        });
      try {
        const response = await fetch(env.API_ORIGIN + "/v1/account/deletion", {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
          },
          body: '{"confirmation":"DELETE"}',
          signal: AbortSignal.timeout(25000),
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          return reply("{}", "application/json", response.status, {
            "Cache-Control": "no-store",
          });
        }
        const receipt = await response.json();
        if (
          !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
            receipt.requestId,
          ) ||
          !["PENDING", "COMPLETE"].includes(receipt.status)
        )
          throw new Error("invalid receipt");
        return reply(
          JSON.stringify({
            requestId: receipt.requestId,
            status: receipt.status,
          }),
          "application/json",
          202,
          { "Cache-Control": "no-store" },
        );
      } catch {
        return reply("{}", "application/json", 503, {
          "Cache-Control": "no-store",
        });
      }
    }
    if (!["GET", "HEAD"].includes(request.method))
      return reply("Method not allowed", "text/plain", 405, {
        Allow: "GET, HEAD",
      });
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (path === "/style.css") return reply(css, "text/css; charset=utf-8");
    if (path === "/site.js")
      return reply(client, "text/javascript; charset=utf-8");
    if (path === "/.well-known/apple-app-site-association")
      return reply(
        JSON.stringify({
          applinks: {
            apps: [],
            details: [
              {
                appID: "639SF375P5.app.crewroll.mobile",
                paths: ["/join", "/join/*"],
              },
            ],
          },
          webcredentials: { apps: ["639SF375P5.app.crewroll.mobile"] },
        }),
        "application/json",
      );
    if (path === "/.well-known/assetlinks.json")
      return reply(
        JSON.stringify([
          {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: {
              namespace: "android_app",
              package_name: "com.uankit53.airmesh",
              sha256_cert_fingerprints: [
                "AC:32:6F:80:12:00:D9:B5:CE:B7:5B:4A:07:8F:85:AB:37:84:90:54:13:44:6E:F0:7E:B2:E6:A2:8A:90:21:BA",
                "04:98:E3:CA:B5:9B:BD:E5:B1:F4:85:FB:CA:64:19:BD:32:0E:A4:40:C2:6D:59:1E:58:85:65:57:84:90:F1:F4",
              ],
            },
          },
        ]),
        "application/json",
      );
    if (path.startsWith("/deletion-status/")) {
      const id = path.slice("/deletion-status/".length);
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
        return reply("{}", "application/json", 404, {
          "Cache-Control": "no-store",
        });
      for (const origin of [env.API_ORIGIN, env.BETA_API_ORIGIN].filter(
        Boolean,
      )) {
        try {
          const response = await fetch(origin + "/v1/account/deletions/" + id, {
            signal: AbortSignal.timeout(8000),
            redirect: "error",
          });
          if (response.ok) {
            const result = await response.json();
            if (
              result.requestId === id &&
              ["COMPLETE", "PENDING"].includes(result.status)
            )
              return reply(
                JSON.stringify({ status: result.status }),
                "application/json",
                200,
                { "Cache-Control": "no-store" },
              );
          } else await response.body?.cancel();
        } catch {
          /* Try the previous beta environment without exposing identifiers. */
        }
      }
      return reply("{}", "application/json", 404, {
        "Cache-Control": "no-store",
      });
    }
    const [title, content] = pages[path] ?? [
      "Page not found",
      '<h1>Page not found</h1><p><a href="/">Go back to CrewRoll</a>.</p>',
    ];
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · CrewRoll</title><meta name="description" content="Private trip photos, shared as originals with your crew."><link rel="stylesheet" href="/style.css"><script src="/site.js" defer></script></head><body><header><a class="brand" href="/" aria-label="CrewRoll home">Crew<b>Roll</b></a><nav aria-label="Main navigation"><a href="/privacy">Privacy</a><a href="/download">Get the app</a></nav></header><main>${content}</main><footer><span>By Ankit Upadhyay · CrewRoll</span><nav aria-label="Legal and support"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a><a href="/delete-account">Delete account</a></nav></footer></body></html>`;
    return reply(
      request.method === "HEAD" ? null : html,
      "text/html; charset=utf-8",
      pages[path] ? 200 : 404,
      path === "/join" || path === "/delete-account"
        ? {
            "Cache-Control": "no-store",
            ...(path === "/delete-account"
              ? {
                  "Content-Security-Policy": headers["Content-Security-Policy"]
                    .replace(
                      "script-src 'self'",
                      "script-src 'self' https://clerk.crewroll.app",
                    )
                    .replace(
                      "connect-src 'self'",
                      "connect-src 'self' https://clerk.crewroll.app",
                    ),
                }
              : {}),
          }
        : {},
    );
  },
};
