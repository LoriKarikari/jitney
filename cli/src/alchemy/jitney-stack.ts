import * as Alchemy from "alchemy";
import type * as Provider from "alchemy/Provider";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Output from "alchemy/Output";
import {
  JITNEY_WORKER_TAG,
  deploymentWorkerTag,
  runnerApplicationName,
} from "../cloudflare-inventory.js";
import { RECEIPT_NAMESPACE_TITLE } from "../receipts/cloudflare.js";
import { GitHubApp, type GitHubAppResource } from "./github-app.js";

export interface JitneyStackInput {
  deploymentId: string;
  workerName: string;
  workerBundlePath: string;
  version: string;
  organization?: string;
  manageGitHubApp?: boolean;
  uninstallSecret: Redacted.Redacted<string>;
  githubCredentials?: {
    appId: Redacted.Redacted<string>;
    privateKey: Redacted.Redacted<string>;
    webhookSecret: Redacted.Redacted<string>;
  };
}

type JitneyProviders = Cloudflare.Providers | Provider.Provider<GitHubAppResource>;
type JitneyRequirements = JitneyProviders | Alchemy.StackServices;
type JitneyStackProps = Alchemy.StackProps<JitneyRequirements>;
export type JitneyProviderLayer = JitneyStackProps["providers"];

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
        title: RECEIPT_NAMESPACE_TITLE,
      }).pipe(adopt(true), retain());
      const runnerApplication = yield* Cloudflare.Containers.ContainerPlatform(
        "RunnerApplication",
        {
          name: runnerApplicationName(input.workerName),
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
        crons: input.githubCredentials === undefined ? [] : ["*/5 * * * *"],
        observability: {
          enabled: true,
          headSamplingRate: 1,
        },
        tags: [JITNEY_WORKER_TAG, deploymentWorkerTag(input.deploymentId)],
        env: {
          SCHEDULER: scheduler,
          RUNNER_CONTAINERS: runnerContainers,
          JITNEY_RECEIPTS: receipts,
          JITNEY_DEPLOYMENT: input.deploymentId,
          JITNEY_RECEIPT_NAME: input.workerName,
          JITNEY_VERSION: input.version,
          CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
          RUNTIME_TIMEOUT_MS: "3600000",
          SCHEDULER_TICK_MS: "1000",
          JITNEY_UNINSTALL_SECRET: input.uninstallSecret,
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
      if (input.manageGitHubApp === true) {
        // GitHub App deletion requires browser confirmation and residue verification,
        // so the command owns that step after Alchemy removes the Cloudflare resources.
        yield* GitHubApp("GitHubApp", {
          name: input.workerName,
          webhookUrl: worker.url.as<string>().pipe(Output.map((url) => `${url}/webhooks/github`)),
          ...(input.organization === undefined ? {} : { organization: input.organization }),
        }).pipe(retain());
      }

      return {
        deploymentId: input.deploymentId,
        workerName: worker.workerName,
        workerUrl: worker.url.as<string>(),
        runnerApplicationId: runnerApplication.applicationId,
        runnerImage: runnerApplication.configuration.pipe(
          Output.map((configuration) => configuration.image),
        ),
        receiptNamespaceId: receipts.namespaceId,
      };
    }),
  );
}
