import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { randomBytes, createPrivateKey } from "node:crypto";
import { createServer } from "node:http";
import open from "open";

export type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  slug: string;
};

type ManifestConversion = {
  id: number;
  pem: string;
  webhook_secret: string;
  slug: string;
};

export async function createGitHubApp(options: {
  workerName: string;
  workerUrl: string;
  organization?: string;
}): Promise<GitHubAppCredentials> {
  const state = randomBytes(32).toString("hex");
  const callback = await listenForManifestCode(state, options);
  console.log("Opening GitHub to create the App...");
  await open(callback.startUrl);
  const code = await callback.code;

  const response = await request("POST /app-manifests/{code}/conversions", { code });
  if (!isManifestConversion(response.data))
    throw new Error("GitHub returned an invalid App manifest response");
  const privateKey = createPrivateKey(response.data.pem)
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    appId: String(response.data.id),
    privateKey,
    webhookSecret: response.data.webhook_secret,
    slug: response.data.slug,
  };
}

export async function openInstallation(credentials: GitHubAppCredentials): Promise<void> {
  await open(`https://github.com/apps/${credentials.slug}/installations/new`);
}

export async function installationCount(credentials: GitHubAppCredentials): Promise<number> {
  const auth = createAppAuth({ appId: credentials.appId, privateKey: credentials.privateKey });
  const appAuthentication = await auth({ type: "app" });
  const response = await request("GET /app/installations", {
    headers: { authorization: `bearer ${appAuthentication.token}` },
    per_page: 100,
  });
  return response.data.length;
}

export async function listenForManifestCode(
  state: string,
  options: { workerName: string; workerUrl: string; organization?: string },
): Promise<{ startUrl: string; code: Promise<string> }> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/start") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(manifestForm(options, callbackUrl(server), state));
      return;
    }
    if (url.pathname === "/callback") {
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      if (returnedState !== state || returnedCode === null) {
        response
          .writeHead(400)
          .end("Invalid GitHub App callback. Complete setup in the GitHub tab.");
        return;
      }
      response.end("Jitney received the GitHub App credentials. You can close this tab.");
      resolveCode(returnedCode);
      server.close();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const timeout = setTimeout(
    () => {
      server.close();
      rejectCode(new Error("Timed out waiting for GitHub App creation"));
    },
    10 * 60 * 1000,
  );
  timeout.unref();
  void code.then(
    () => clearTimeout(timeout),
    () => clearTimeout(timeout),
  );
  return { startUrl: `${callbackUrl(server).replace("/callback", "/start")}`, code };
}

function callbackUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Local setup server did not start");
  return `http://127.0.0.1:${address.port}/callback`;
}

function manifestForm(
  options: { workerName: string; workerUrl: string; organization?: string },
  redirectUrl: string,
  state: string,
): string {
  const endpoint = options.organization
    ? `https://github.com/organizations/${encodeURIComponent(options.organization)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const manifest = githubAppManifest(options, redirectUrl);
  return `<!doctype html><html><body><p>Redirecting to GitHub...</p><form id="manifest" action="${endpoint}?state=${state}" method="post"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"></form><script>document.getElementById("manifest").submit()</script></body></html>`;
}

export function githubAppManifest(
  options: { workerName: string; workerUrl: string },
  redirectUrl: string,
): Record<string, unknown> {
  return {
    name: `Jitney ${options.workerName}-${randomBytes(2).toString("hex")}`,
    url: "https://github.com/LoriKarikari/jitney",
    hook_attributes: { url: `${options.workerUrl}/webhooks/github`, active: true },
    redirect_url: redirectUrl,
    public: false,
    default_events: ["workflow_job"],
    default_permissions: { actions: "read", administration: "write" },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isManifestConversion(value: unknown): value is ManifestConversion {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ManifestConversion).id === "number" &&
    typeof (value as ManifestConversion).pem === "string" &&
    typeof (value as ManifestConversion).webhook_secret === "string" &&
    typeof (value as ManifestConversion).slug === "string"
  );
}
