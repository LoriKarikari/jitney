import { Effect } from "effect";
import type { InstallationMismatch } from "./github";
import { deleteRunner, generateJitConfig, ProvisioningError } from "./github";
import type { RunnerContainer } from "./runner-container";

export type ProvisionRequest = {
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  workflowJobId: number;
  runnerName: string;
  containerName: string;
};

export type Provision = (
  request: ProvisionRequest,
) => Effect.Effect<void, InstallationMismatch | ProvisioningError>;

export type Reclaim = (request: ProvisionRequest) => Effect.Effect<void, ProvisioningError>;

export function createReclaimer(env: Env): Reclaim {
  // Destroy the container before touching GitHub: a runner that is still
  // executing a job cannot be deleted (GitHub rejects deleting a busy
  // runner), and the container is the resource Jitney pays for.
  return (request) =>
    Effect.tryPromise({
      try: () =>
        (
          env.RUNNER_CONTAINERS.getByName(
            request.containerName,
          ) as DurableObjectStub<RunnerContainer>
        ).destroy(),
      catch: (cause) => new ProvisioningError({ step: "container_destroy", cause }),
    }).pipe(
      Effect.andThen(
        deleteRunner({
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
          installationId: request.installationId,
          repositoryId: request.repositoryId,
          repositoryOwner: request.repositoryOwner,
          repositoryName: request.repositoryName,
          runnerName: request.runnerName,
        }),
      ),
    );
}

export function createProvisioner(env: Env): Provision {
  return (request) => {
    const {
      installationId,
      repositoryId,
      repositoryOwner,
      repositoryName,
      workflowJobId,
      runnerName,
      containerName,
    } = request;
    return generateJitConfig({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId,
      repositoryId,
      repositoryOwner,
      repositoryName,
      runnerName,
    }).pipe(
      Effect.andThen((jitConfig) =>
        Effect.tryPromise({
          try: () =>
            (
              env.RUNNER_CONTAINERS.getByName(containerName) as DurableObjectStub<RunnerContainer>
            ).startAttempt({
              jitConfig,
              installationId,
              repositoryId,
              workflowJobId,
              runnerName,
              containerName,
            }),
          catch: (cause) => new ProvisioningError({ step: "container_start", cause }),
        }),
      ),
    );
  };
}
