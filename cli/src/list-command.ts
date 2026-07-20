import * as Containers from "@distilled.cloud/cloudflare/containers";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Cloudflare from "alchemy/Cloudflare";
import { Array as Arr, Effect, Option, Predicate, Schema, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { request } from "@octokit/request";
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

const workerUrl = Effect.fn(function* (accountId: string, name: string) {
  const script = yield* Workers.getScriptSetting({ accountId, scriptName: name }).pipe(
    Effect.map(Option.fromUndefinedOr),
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(Option.none())),
  );
  if (Option.isNone(script)) return Option.none<string>();
  const [{ subdomain }, scriptSubdomain] = yield* Effect.all([
    Workers.getSubdomain({ accountId }),
    Workers.getScriptSubdomain({ accountId, scriptName: name }),
  ]);
  if (!scriptSubdomain.enabled) {
    return yield* Effect.fail(new Error(`Worker ${name} has no workers.dev route`));
  }
  return Option.some(`https://${name}.${subdomain}.workers.dev`);
});

const imageTag = (image: string): string | null => {
  const separator = image.lastIndexOf(":");
  return separator < image.lastIndexOf("/") ? null : image.slice(separator + 1);
};

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

  return ListPlatform.of({
    workerVersion: (accountId, name) =>
      provideCloudflare(workerUrl(accountId, name)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<string>()),
            onSome: (url) =>
              client.get(`${url}/health`).pipe(
                Effect.flatMap((response) => response.json),
                Effect.map((body) => Schema.decodeUnknownSync(HealthResponse)(body)),
                Effect.map((health) => Option.some(health.version)),
              ),
          }),
        ),
        Effect.mapError((cause) => unreachable("cloudflare", cause)),
      ),
    workerNames: (accountId) =>
      provideCloudflare(Stream.runCollect(Workers.listScripts.items({ accountId }))).pipe(
        Effect.map((scripts) =>
          scripts.flatMap((script) => {
            if (script.id === null || script.id === undefined) return [];
            const names = (script.namedHandlers ?? []).flatMap(({ name }) =>
              name === null || name === undefined ? [] : [name],
            );
            return Arr.contains(names, "Scheduler") && Arr.contains(names, "RunnerContainer")
              ? [script.id]
              : [];
          }),
        ),
        Effect.mapError((cause) => unreachable("cloudflare", cause)),
      ),
    containerApplications: (accountId) =>
      provideCloudflare(Containers.listContainerApplications({ accountId })).pipe(
        Effect.map((applications): readonly LiveApplication[] =>
          applications.map((application) => ({
            id: application.id,
            name: application.name,
            imageTag: imageTag(application.configuration.image),
          })),
        ),
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
        const url = yield* provideCloudflare(
          workerUrl(receipt.cloudflare.accountId, receipt.cloudflare.workerName),
        );
        if (Option.isNone(url)) return yield* Effect.fail(new Error("Worker is unavailable"));
        const response = yield* client.get(`${url.value}/lifecycle/status`, {
          headers: { "X-Jitney-Deployment": receipt.id },
        });
        if (response.status !== 200) {
          return yield* Effect.fail(new Error(`Lifecycle probe returned ${response.status}`));
        }
        const status = Schema.decodeUnknownSync(LifecycleResponse)(yield* response.json);
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
        Effect.map((response) => Schema.decodeUnknownSync(LatestRelease)(response.data)),
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
