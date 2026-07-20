import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Effect, Option, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { DeploymentReceipt } from "./receipts/schema.js";

export const LifecycleResponse = Schema.Struct({
  app: Schema.Literals(["ok", "unknown"]),
  installations: Schema.Literals(["ok", "drifted", "unknown"]),
  ownership: Schema.Array(
    Schema.Struct({
      installationId: Schema.Number,
      repositoryId: Schema.Number,
      status: Schema.Literals(["ok", "missing", "drifted", "unknown"]),
    }),
  ),
});

export type LifecycleStatusResponse = typeof LifecycleResponse.Type;

/** Locate the Worker and its public URL, if it has one. */
export const workerAddress = Effect.fn(function* (accountId: string, name: string) {
  const script = yield* Workers.getScriptSetting({ accountId, scriptName: name }).pipe(
    Effect.map(Option.fromUndefinedOr),
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(Option.none())),
  );
  if (Option.isNone(script)) return { exists: false, url: null } as const;
  const [{ subdomain }, scriptSubdomain] = yield* Effect.all([
    Workers.getSubdomain({ accountId }),
    Workers.getScriptSubdomain({ accountId, scriptName: name }),
  ]);
  return {
    exists: true,
    url: scriptSubdomain.enabled ? `https://${name}.${subdomain}.workers.dev` : null,
  } as const;
});

/** Call the Worker's deployment-scoped lifecycle probe. */
const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const fetchLifecycleStatus = (
  receipt: DeploymentReceipt,
): Effect.Effect<LifecycleStatusResponse, Error, Credentials | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const worker = yield* workerAddress(
      receipt.cloudflare.accountId,
      receipt.cloudflare.workerName,
    );
    if (!worker.exists || worker.url === null) {
      return yield* Effect.fail(new Error("Worker is unavailable"));
    }
    const response = yield* client.get(`${worker.url}/lifecycle/status`, {
      headers: { "X-Jitney-Deployment": receipt.id },
    });
    if (response.status !== 200) {
      return yield* Effect.fail(new Error(`Lifecycle probe returned ${response.status}`));
    }
    const body = yield* response.json;
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(LifecycleResponse)(body),
      catch: asError,
    });
  }).pipe(Effect.mapError(asError));

/** Ask the Worker to rewrite JITNEY_DEPLOYMENT markers the receipt owns. */
export const rewriteOwnershipMarkers = (
  receipt: DeploymentReceipt,
  fullNames: readonly string[],
): Effect.Effect<void, Error, Credentials | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const worker = yield* workerAddress(
      receipt.cloudflare.accountId,
      receipt.cloudflare.workerName,
    );
    if (!worker.exists || worker.url === null) {
      return yield* Effect.fail(new Error("Worker is unavailable"));
    }
    const repositories = receipt.github.installations.flatMap((installation) =>
      installation.repositories
        .filter((repository) => fullNames.includes(repository.fullName))
        .map((repository) => ({
          installationId: installation.id,
          fullName: repository.fullName,
        })),
    );
    const request = HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${worker.url}/lifecycle/ownership`, {
        headers: { "X-Jitney-Deployment": receipt.id },
      }),
      { repositories },
    );
    const response = yield* client.execute(request);
    if (response.status !== 204) {
      return yield* Effect.fail(new Error(`Ownership rewrite returned ${response.status}`));
    }
  }).pipe(Effect.mapError(asError));
