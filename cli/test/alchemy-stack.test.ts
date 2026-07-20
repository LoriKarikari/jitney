import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { deploy } from "alchemy/Deploy";
import { destroy } from "alchemy/Destroy";
import * as Provider from "alchemy/Provider";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { inMemoryState } from "alchemy/State";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import { Effect, Layer, Redacted, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { GitHubAppOperations, GitHubAppProvider } from "../src/alchemy/github-app.js";
import { jitneyStack } from "../src/alchemy/jitney-stack.js";

describe("Jitney Alchemy stack", () => {
  it("creates, updates, and destroys the Jitney resource graph in memory", async () => {
    const state = inMemoryState();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const providers = makeProviders(events);
        const options = { providers, state };
        const input = {
          deploymentId: "01JITNEYDEPLOYMENT",
          workerName: "jitney-test",
          workerBundlePath: "assets/worker/index.js",
          version: "0.3.0",
          manageGitHubApp: true,
          githubCredentials: {
            appId: Redacted.make("12345"),
            privateKey: Redacted.make("private-key"),
            webhookSecret: Redacted.make("webhook-secret"),
          },
        };

        const first = yield* deploy({
          stack: jitneyStack(input, options),
          stage: "test",
        });
        const second = yield* deploy({
          stack: jitneyStack({ ...input, version: "0.3.1" }, options),
          stage: "test",
        });
        yield* destroy({
          stack: jitneyStack({ ...input, version: "0.3.1" }, options),
          stage: "test",
        });

        return { first, second, events: yield* Ref.get(events) };
      }).pipe(
        Effect.provide(testCli),
        Effect.provide(state),
        Effect.provide(Alchemy.AlchemyContextLive),
        Effect.provideService(ArtifactStore, createArtifactStore()),
        Effect.provide(PlatformServices),
      ),
    );

    expect(result.first).toEqual({
      deploymentId: "01JITNEYDEPLOYMENT",
      workerName: "jitney-test",
      workerUrl: "https://jitney-test.example.workers.dev",
      runnerApplicationId: "application-RunnerApplication",
      runnerImage: "ghcr.io/lorikarikari/jitney:0.3.0",
      receiptNamespaceId: "namespace-LifecycleReceipts",
    });
    expect(result.second).toEqual({
      ...result.first,
      runnerImage: "ghcr.io/lorikarikari/jitney:0.3.1",
    });
    expect(result.events).toContain("container:reconcile:0.3.0");
    expect(result.events).toContain("container:reconcile:0.3.1");
    expect(result.events).toContain(
      "worker:reconcile:jitney-test:jitney,jitney-deployment:01JITNEYDEPLOYMENT",
    );
    expect(result.events.slice(-2)).toEqual([
      "container:delete:jitney-test-runner",
      "worker:delete:jitney-test",
    ]);
    expect(result.events).not.toContain("github:delete:jitney-test");
    expect(result.events).not.toContain("kv:delete:jitney-receipts");
  });
});

const testCli = Layer.succeed(Alchemy.Cli, {
  approvePlan: () => Effect.succeed(true),
  displayPlan: () => Effect.void,
  startApplySession: () =>
    Effect.succeed({
      emit: () => Effect.void,
      done: () => Effect.void,
    }),
});

function makeProviders(events: Ref.Ref<string[]>) {
  const record = (event: string) => Ref.update(events, (current) => [...current, event]);
  const githubOperations = Layer.succeed(GitHubAppOperations, {
    reconcile: ({ desired, current }) =>
      record(`github:reconcile:${desired.name}`).pipe(
        Effect.as(
          current ?? {
            appId: "github-app-GitHubApp",
            slug: desired.name,
            settingsUrl: `https://github.com/settings/apps/${desired.name}`,
            ownerLogin: "LoriKarikari",
            ownerType: "User",
          },
        ),
      ),
    delete: (app) => record(`github:delete:${app.slug}`),
    list: () => Effect.succeed([]),
  });
  const github = GitHubAppProvider.pipe(Layer.provide(githubOperations));
  const kv: Provider.ProviderService<Cloudflare.KV.Namespace> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news }) =>
      record(`kv:reconcile:${news.title ?? id}`).pipe(
        Effect.as({
          title: news.title ?? id,
          namespaceId: `namespace-${id}`,
          supportsUrlEncoding: true,
          accountId: "account",
        }),
      ),
    delete: ({ output }) => record(`kv:delete:${output.title}`),
  };
  const container: Provider.ProviderService<Cloudflare.Containers.ContainerApplication> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news, output, bindings }) =>
      record(`container:reconcile:${news.image?.split(":").at(-1)}`).pipe(
        Effect.as({
          applicationId: output?.applicationId ?? `application-${id}`,
          applicationName: news.name ?? id,
          accountId: "account",
          schedulingPolicy: news.schedulingPolicy ?? "default",
          instances: news.instances ?? 0,
          maxInstances: news.maxInstances ?? 20,
          constraints: news.constraints,
          affinities: news.affinities,
          configuration: { image: news.image ?? "" },
          durableObjects: bindings.find((binding) => binding.data.durableObjects !== undefined)
            ?.data.durableObjects,
          createdAt: output?.createdAt ?? "2026-07-20T00:00:00.000Z",
          version: (output?.version ?? 0) + 1,
          dev: undefined,
        }),
      ),
    delete: ({ output }) => record(`container:delete:${output.applicationName}`),
  };
  const worker: Provider.ProviderService<Cloudflare.Workers.Worker> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news, output }) =>
      record(`worker:reconcile:${news.name ?? id}:${news.tags?.join(",") ?? ""}`).pipe(
        Effect.as({
          workerId: output?.workerId ?? `worker-${id}`,
          workerName: news.name ?? id,
          namespace: undefined,
          logpush: news.logpush,
          url: `https://${news.name ?? id}.example.workers.dev`,
          tags: news.tags,
          durableObjectNamespaces: {
            SCHEDULER: "scheduler-namespace",
            RUNNER_CONTAINERS: "runner-container-namespace",
          },
          accountId: "account",
          domains: [],
          routes: [],
          crons: news.crons ?? [],
        }),
      ),
    delete: ({ output }) => record(`worker:delete:${output.workerName}`),
  };
  const kvLayer = Provider.succeed(Cloudflare.KV.Namespace, kv);
  const containerLayer = Provider.succeed(Cloudflare.Containers.ContainerPlatform, container);
  // Alchemy beta.63's Worker class has an exact-optional mismatch with its Provider helper.
  // @ts-expect-error upstream beta type mismatch
  const workerLayer = Provider.succeed(Cloudflare.Workers.Worker, worker);
  const cloudflare = Layer.effect(
    Cloudflare.Providers,
    Provider.collection([
      // Alchemy beta.63's ResourceClass has an exact-optional mismatch with collection().
      // @ts-expect-error upstream beta type mismatch
      Cloudflare.KV.Namespace,
      Cloudflare.Containers.ContainerPlatform,
      Cloudflare.Workers.Worker,
    ]),
  ).pipe(Layer.provide(Layer.mergeAll(kvLayer, containerLayer, workerLayer)));

  return Layer.mergeAll(cloudflare, github);
}
