import * as Alchemy from "alchemy";
import type * as Provider from "alchemy/Provider";
import { retain } from "alchemy/RemovalPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Output from "alchemy/Output";
import { GitHubApp, type GitHubAppResource } from "./github-app.js";

export interface JitneyStackInput {
  deploymentId: string;
  workerName: string;
  workerBundlePath: string;
  version: string;
  organization?: string;
  githubCredentials?: {
    appId: Redacted.Redacted<string>;
    privateKey: Redacted.Redacted<string>;
    webhookSecret: Redacted.Redacted<string>;
  };
}

type JitneyProviders = Cloudflare.Providers | Provider.Provider<GitHubAppResource>;
type JitneyRequirements = JitneyProviders | Alchemy.StackServices;
type JitneyStackProps = Alchemy.StackProps<JitneyRequirements>;

export function jitneyStack(
  input: JitneyStackInput,
  options: {
    providers: JitneyStackProps["providers"];
    state?: JitneyStackProps["state"];
  },
) {
  return Alchemy.Stack(
    "Jitney",
    {
      providers: options.providers,
      state: options.state ?? Cloudflare.state(),
    },
    Effect.gen(function* () {
      const receipts = yield* Cloudflare.KV.Namespace("LifecycleReceipts", {
        title: "jitney-receipts",
      }).pipe(retain());
      const runnerApplication = yield* Cloudflare.Containers.ContainerPlatform(
        "RunnerApplication",
        {
          name: `${input.workerName}-runner`,
          image: `ghcr.io/lorikarikari/jitney:${input.version}`,
          instances: 0,
          maxInstances: 5,
          instanceType: "standard-2",
        },
      );
      const scheduler = Cloudflare.DurableObject("SCHEDULER", { className: "Scheduler" });
      const runnerContainers = Cloudflare.DurableObject("RUNNER_CONTAINERS", {
        className: "RunnerContainer",
      });
      const worker = yield* Cloudflare.Worker("ControlPlane", {
        name: input.workerName,
        main: input.workerBundlePath,
        bundle: false,
        compatibility: {
          date: "2026-07-01",
          flags: ["nodejs_compat"],
        },
        crons: ["*/5 * * * *"],
        observability: {
          enabled: true,
          headSamplingRate: 1,
        },
        env: {
          SCHEDULER: scheduler,
          RUNNER_CONTAINERS: runnerContainers,
          JITNEY_RECEIPTS: receipts,
          JITNEY_DEPLOYMENT: input.deploymentId,
          CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
          RUNTIME_TIMEOUT_MS: "3600000",
          SCHEDULER_TICK_MS: "1000",
          ...(input.githubCredentials === undefined
            ? {}
            : {
                GITHUB_APP_ID: input.githubCredentials.appId,
                GITHUB_APP_PRIVATE_KEY: input.githubCredentials.privateKey,
                GITHUB_WEBHOOK_SECRET: input.githubCredentials.webhookSecret,
              }),
        },
      });
      yield* runnerApplication.bind("RUNNER_CONTAINERS", {
        durableObjects: {
          namespaceId: worker.durableObjectNamespaces.pipe(
            Output.map((names) => {
              const namespaceId = names.RUNNER_CONTAINERS;
              if (namespaceId === undefined) {
                throw new Error("RUNNER_CONTAINERS namespace is missing");
              }
              return namespaceId;
            }),
          ),
        },
      });
      yield* worker.bind("RunnerApplication", {
        containers: [{ className: "RunnerContainer", dev: undefined }],
      });
      // GitHub App deletion requires browser confirmation and residue verification,
      // so the command owns that step after Alchemy removes the Cloudflare resources.
      const githubApp = yield* GitHubApp("GitHubApp", {
        name: input.workerName,
        webhookUrl: worker.url.as<string>().pipe(Output.map((url) => `${url}/webhook`)),
        ...(input.organization === undefined ? {} : { organization: input.organization }),
      }).pipe(retain());

      return {
        deploymentId: input.deploymentId,
        workerName: worker.workerName,
        workerUrl: worker.url.as<string>(),
        runnerApplicationId: runnerApplication.applicationId,
        receiptNamespaceId: receipts.namespaceId,
        githubAppId: githubApp.appId,
        githubAppSlug: githubApp.slug,
      };
    }),
  );
}
