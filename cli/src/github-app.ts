import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { randomBytes, createPrivateKey } from "node:crypto";
import { createServer } from "node:http";
import { Effect, Schedule, Schema } from "effect";
import open from "open";
import { InstallerError, tryPromise, trySync } from "./errors.js";

export type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  slug: string;
  ownerLogin: string;
  ownerType: "User" | "Organization";
};

const ManifestConversion = Schema.Struct({
  id: Schema.Number,
  pem: Schema.String,
  webhook_secret: Schema.String,
  slug: Schema.String,
  owner: Schema.Struct({
    login: Schema.String,
    type: Schema.Literals(["User", "Organization"]),
  }),
});

export function createGitHubApp(options: {
  workerName: string;
  workerUrl: string;
  organization?: string;
}): Effect.Effect<GitHubAppCredentials, InstallerError> {
  const state = randomBytes(32).toString("hex");
  return Effect.acquireUseRelease(
    tryPromise("github_app_setup", "Could not start the local GitHub App callback", () =>
      listenForManifestCode(state, options),
    ),
    (callback) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => console.log("Opening GitHub to create the App..."));
        yield* tryPromise("github_app_setup", "Could not open GitHub App setup", () =>
          open(callback.startUrl),
        );
        const code = yield* tryPromise(
          "github_app_setup",
          "GitHub App creation did not complete",
          () => callback.code,
        );
        const response = yield* tryPromise(
          "github_app_conversion",
          "Could not exchange the GitHub App manifest code",
          () => request("POST /app-manifests/{code}/conversions", { code }),
        );
        const conversion = yield* trySync(
          "github_app_conversion",
          "GitHub returned an invalid App manifest response",
          () => Schema.decodeUnknownSync(ManifestConversion)(response.data),
        );
        const privateKey = yield* trySync(
          "github_app_conversion",
          "Could not convert the GitHub App private key",
          () =>
            createPrivateKey(conversion.pem).export({ type: "pkcs8", format: "pem" }).toString(),
        );
        return {
          appId: String(conversion.id),
          privateKey,
          webhookSecret: conversion.webhook_secret,
          slug: conversion.slug,
          ownerLogin: conversion.owner.login,
          ownerType: conversion.owner.type,
        };
      }),
    (callback) => Effect.sync(callback.close),
  );
}

export function openInstallation(
  credentials: GitHubAppCredentials,
): Effect.Effect<void, InstallerError> {
  return tryPromise(
    "github_app_installation",
    "Could not open GitHub App installation",
    async () => {
      await open(`https://github.com/apps/${credentials.slug}/installations/new`);
    },
  );
}

export function openGitHubAppDeletion(
  credentials: GitHubAppCredentials,
): Effect.Effect<void, InstallerError> {
  const settingsUrl =
    credentials.ownerType === "Organization"
      ? `https://github.com/organizations/${credentials.ownerLogin}/settings/apps/${credentials.slug}/advanced`
      : `https://github.com/settings/apps/${credentials.slug}/advanced`;
  return tryPromise("rollback", "Could not open GitHub App deletion settings", () =>
    open(settingsUrl),
  ).pipe(Effect.asVoid);
}

export function waitForGitHubAppDeletion(
  credentials: GitHubAppCredentials,
): Effect.Effect<void, InstallerError> {
  const pending = new InstallerError({
    step: "rollback",
    message: `GitHub App ${credentials.slug} still exists`,
  });
  const check = tryPromise("rollback", "Could not verify GitHub App deletion", () =>
    fetch(`https://github.com/apps/${credentials.slug}`, { redirect: "manual" }),
  ).pipe(
    Effect.flatMap((response) => (response.status === 404 ? Effect.void : Effect.fail(pending))),
  );
  return check.pipe(
    Effect.retry(Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(119)])),
  );
}

export function installationCount(
  credentials: GitHubAppCredentials,
): Effect.Effect<number, InstallerError> {
  return tryPromise(
    "github_app_installation",
    "Could not inspect GitHub App installations",
    async () => {
      const auth = createAppAuth({ appId: credentials.appId, privateKey: credentials.privateKey });
      const appAuthentication = await auth({ type: "app" });
      const response = await request("GET /app/installations", {
        headers: { authorization: `bearer ${appAuthentication.token}` },
        per_page: 100,
      });
      return response.data.length;
    },
  );
}

export async function listenForManifestCode(
  state: string,
  options: { workerName: string; workerUrl: string; organization?: string },
): Promise<{ startUrl: string; code: Promise<string>; close: () => void }> {
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
  return {
    startUrl: callbackUrl(server).replace("/callback", "/start"),
    code,
    close: () => {
      clearTimeout(timeout);
      server.close();
    },
  };
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
    default_permissions: { actions: "read", administration: "write", variables: "write" },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
