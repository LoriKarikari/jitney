import * as Containers from "@distilled.cloud/cloudflare/containers";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, HashMap, Option, Predicate, Ref, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { request } from "@octokit/request";
import { observeAccount, type AccountSnapshot } from "./cloudflare-inventory.js";
import { cloudflareRuntime } from "./cloudflare-runtime.js";
import { InstallerError } from "./errors.js";
import {
  ListPlatform,
  ListReceipts,
  ProbeUnreachableError,
  listDeployments,
  renderListReport,
  type GitHubProbe,
  type LiveApplication,
} from "./list.js";
import { listImageTags } from "./oras.js";
import {
  findCloudflareReceiptNamespace,
  makeCloudflareReceiptBackend,
} from "./receipts/cloudflare.js";
import { makeReceiptStore } from "./receipts/store.js";

const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.String,
});

const LifecycleResponse = Schema.Struct({
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

const LatestRelease = Schema.Struct({ tag_name: Schema.String });

const unreachable = (
  plane: ProbeUnreachableError["plane"],
  cause: unknown,
): ProbeUnreachableError => new ProbeUnreachableError({ plane, cause });

const workerAddress = Effect.fn(function* (accountId: string, name: string) {
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

const makeListPlatform = Effect.fn(function* () {
  const credentials = yield* Credentials;
  const client = yield* HttpClient.HttpClient;
  const provideCloudflare = <A, E>(
    effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) =>
    effect.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, client),
    );

  // list probes the same account twice (workers, applications); observe once.
  const snapshots = yield* Ref.make(HashMap.empty<string, AccountSnapshot>());
  const snapshotFor = (accountId: string) =>
    Ref.get(snapshots).pipe(
      Effect.flatMap((cache) =>
        Option.match(HashMap.get(cache, accountId), {
          onSome: Effect.succeed,
          onNone: () =>
            provideCloudflare(observeAccount(accountId)).pipe(
              Effect.tap((snapshot) =>
                Ref.update(snapshots, (current) => HashMap.set(current, accountId, snapshot)),
              ),
            ),
        }),
      ),
    );

  return ListPlatform.of({
    worker: (accountId, name) =>
      provideCloudflare(workerAddress(accountId, name)).pipe(
        Effect.flatMap((worker) => {
          if (!worker.exists) return Effect.succeed({ exists: false, version: null });
          if (worker.url === null) return Effect.succeed({ exists: true, version: null });
          return client.get(`${worker.url}/health`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap((body) =>
              Effect.try({
                try: () => Schema.decodeUnknownSync(HealthResponse)(body),
                catch: (cause) => cause,
              }),
            ),
            Effect.map((health) => ({ exists: true, version: health.version })),
            Effect.catch(() => Effect.succeed({ exists: true, version: null })),
          );
        }),
        Effect.mapError((cause) => unreachable("cloudflare", cause)),
      ),
    workerNames: (accountId) =>
      snapshotFor(accountId).pipe(
        Effect.map((snapshot) =>
          snapshot.workers.flatMap((worker) => (worker.jitneyTagged ? [worker.name] : [])),
        ),
        Effect.mapError((cause) => unreachable("cloudflare", cause)),
      ),
    containerApplications: (accountId) =>
      snapshotFor(accountId).pipe(
        Effect.map((snapshot): readonly LiveApplication[] => snapshot.applications),
        Effect.mapError((cause) => unreachable("cloudflare", cause)),
      ),
    registryTags: (accountId, repository) =>
      provideCloudflare(
        Containers.createContainerRegistryCredentials({
          accountId,
          registryId: "registry.cloudflare.com",
          permissions: ["pull"],
          expirationMinutes: 15,
        }),
      ).pipe(
        Effect.flatMap((registry) => {
          const username = registry.username ?? registry.user;
          return username === null || username === undefined
            ? Effect.fail(new Error("Cloudflare registry credentials have no username"))
            : listImageTags({
                repository: `registry.cloudflare.com/${accountId}/${repository}`,
                registryHost: "registry.cloudflare.com",
                username,
                password: registry.password,
              });
        }),
        Effect.mapError((cause) => unreachable("cloudflare", cause)),
      ),
    githubApp: (receipt) =>
      Effect.gen(function* () {
        if (receipt.github.appSlug === null) {
          return {
            appExists: false,
            installations: [],
            ownership: [],
          } satisfies GitHubProbe;
        }
        const appPage = yield* client.get(`https://github.com/apps/${receipt.github.appSlug}`);
        if (appPage.status >= 500 || appPage.status === 429) {
          return yield* Effect.fail(new Error(`GitHub returned ${appPage.status}`));
        }
        if (appPage.status === 404) {
          return { appExists: false, installations: [], ownership: [] } satisfies GitHubProbe;
        }
        const worker = yield* provideCloudflare(
          workerAddress(receipt.cloudflare.accountId, receipt.cloudflare.workerName),
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
        const status = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(LifecycleResponse)(body),
          catch: (cause) => cause,
        });
        if (status.app === "unknown" || status.installations === "unknown") {
          return yield* Effect.fail(new Error("GitHub lifecycle probe was inconclusive"));
        }
        return {
          appExists: appPage.status !== 404,
          installations: status.installations === "ok" ? receipt.github.installations : [],
          ownership: receipt.github.installations.flatMap((installation) =>
            installation.repositories.map((repository) => ({
              fullName: repository.fullName,
              class:
                status.ownership.find(
                  (item) =>
                    item.installationId === installation.id && item.repositoryId === repository.id,
                )?.status ?? "unknown",
            })),
          ),
        } satisfies GitHubProbe;
      }).pipe(Effect.mapError((cause) => unreachable("github", cause))),
    latestVersion: () =>
      Effect.tryPromise({
        try: () =>
          request("GET /repos/{owner}/{repo}/releases/latest", {
            owner: "LoriKarikari",
            repo: "jitney",
          }),
        catch: (cause) => unreachable("release", cause),
      }).pipe(
        Effect.flatMap((response) =>
          Effect.try({
            try: () => Schema.decodeUnknownSync(LatestRelease)(response.data),
            catch: (cause) => unreachable("release", cause),
          }),
        ),
        Effect.map(({ tag_name }) => Option.some(tag_name.replace(/^v/, ""))),
        Effect.catch((error) =>
          Predicate.hasProperty(error.cause, "status") && error.cause.status === 404
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(error),
        ),
      ),
  });
});

export function listCommand(options: {
  readonly json?: boolean;
}): Effect.Effect<void, InstallerError> {
  return Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const scope = yield* findCloudflareReceiptNamespace(accountId);
    const receipts = yield* Option.match(scope, {
      onNone: () => Effect.succeed(ListReceipts.of({ list: () => Effect.succeed([]) })),
      onSome: (value) =>
        makeCloudflareReceiptBackend(value).pipe(
          Effect.map((backend) => ListReceipts.of(makeReceiptStore(backend))),
        ),
    });
    const platform = yield* makeListPlatform();
    const report = yield* listDeployments([accountId]).pipe(
      Effect.provideService(ListReceipts, receipts),
      Effect.provideService(ListPlatform, platform),
    );
    yield* Effect.sync(() =>
      console.log(
        options.json === true ? JSON.stringify(report, null, 2) : renderListReport(report),
      ),
    );
  }).pipe(
    Effect.provide(cloudflareRuntime),
    Effect.mapError(
      (cause) =>
        new InstallerError({
          step: "deployment_inspection",
          message: "Could not inspect Jitney deployments",
          cause,
        }),
    ),
  );
}
