import * as Containers from "@distilled.cloud/cloudflare/containers";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Array as Arr, Effect, Schedule, Stream } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { ExistingWorkerError, InstallerError } from "./errors.js";

/** Cloudflare Worker tag that marks a Worker as Jitney-shaped. */
export const JITNEY_WORKER_TAG = "jitney";

const DEPLOYMENT_TAG_PREFIX = "jitney-deployment:";

export const deploymentWorkerTag = (deploymentId: string): string =>
  `${DEPLOYMENT_TAG_PREFIX}${deploymentId}`;

export const runnerApplicationName = (name: string): string => `${name}-runner`;

export interface LiveWorker {
  readonly name: string;
  readonly jitneyTagged: boolean;
  /** Deployment ULID from the Worker's tag, the id proof for re-derivation. */
  readonly deploymentId: string | null;
}

export interface LiveApplication {
  readonly id: string;
  readonly name: string;
  readonly imageTag: string | null;
}

/** Everything Cloudflare currently reports for one account, in Deployment vocabulary. */
export interface AccountSnapshot {
  readonly workers: readonly LiveWorker[];
  readonly applications: readonly LiveApplication[];
}

type CloudflareApi = Credentials | HttpClient.HttpClient;

const imageTag = (image: string): string | null => {
  const separator = image.lastIndexOf(":");
  return separator < image.lastIndexOf("/") ? null : image.slice(separator + 1);
};

export const observeAccount = Effect.fn(function* (accountId: string) {
  const scripts = yield* Stream.runCollect(Workers.listScripts.items({ accountId }));
  const applications = yield* Containers.listContainerApplications({ accountId });
  return {
    workers: Arr.flatMap([...scripts], (script) =>
      script.id === null || script.id === undefined
        ? []
        : [
            {
              name: script.id,
              jitneyTagged: Arr.contains(script.tags ?? [], JITNEY_WORKER_TAG),
              deploymentId:
                (script.tags ?? [])
                  .find((tag) => tag.startsWith(DEPLOYMENT_TAG_PREFIX))
                  ?.slice(DEPLOYMENT_TAG_PREFIX.length) ?? null,
            },
          ],
    ),
    applications: applications.map((application) => ({
      id: application.id,
      name: application.name,
      imageTag: imageTag(application.configuration.image),
    })),
  } satisfies AccountSnapshot;
});

const deploymentPresent = (snapshot: AccountSnapshot, name: string) => ({
  worker: snapshot.workers.some((worker) => worker.name === name),
  application: snapshot.applications.some(
    (application) => application.name === runnerApplicationName(name),
  ),
});

/**
 * Refuse to install over live resources that already carry the deployment's
 * names, whether or not a receipt knows about them.
 */
export const ensureDeploymentAbsent = Effect.fn(function* (accountId: string, name: string) {
  const snapshot = yield* observeAccount(accountId).pipe(
    Effect.mapError(
      (cause) =>
        new InstallerError({
          step: "existing_worker_check",
          message: "Could not check for existing Cloudflare resources",
          cause,
        }),
    ),
  );
  const present = deploymentPresent(snapshot, name);
  if (present.worker) return yield* new ExistingWorkerError({ workerName: name });
  if (present.application) {
    return yield* new InstallerError({
      step: "existing_worker_check",
      message: `Container application ${runnerApplicationName(name)} already exists. Refusing to overwrite it.`,
    });
  }
});

/**
 * Poll until Cloudflare stops reporting the deployment's Worker and container
 * application, or fail after 30 seconds. Rollback and destroy call this after
 * deletion because the control plane acknowledges deletes before listings
 * reflect them.
 */
export const waitForDeploymentRemoval = (
  accountId: string,
  name: string,
): Effect.Effect<void, InstallerError, CloudflareApi> => {
  const pending = new InstallerError({
    step: "rollback",
    message: `Cloudflare is still reporting resources for ${name}`,
  });
  return observeAccount(accountId).pipe(
    Effect.flatMap((snapshot) => {
      const present = deploymentPresent(snapshot, name);
      return present.worker || present.application ? Effect.fail(pending) : Effect.void;
    }),
    Effect.retry({
      while: (error) => error === pending,
      schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(29)]),
    }),
    Effect.mapError((cause) =>
      cause instanceof InstallerError
        ? cause
        : new InstallerError({
            step: "rollback",
            message: "Could not verify removal of the partial Cloudflare deployment",
            cause,
          }),
    ),
  );
};
