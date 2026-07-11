import { Effect } from "effect";
import type { InstallationMismatch } from "./github";
import { generateJitConfig, ProvisioningError } from "./github";
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

export function createProvisioner(env: Env): Provision {
  return (request) =>
    generateJitConfig({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: request.installationId,
      repositoryId: request.repositoryId,
      repositoryOwner: request.repositoryOwner,
      repositoryName: request.repositoryName,
      runnerName: request.runnerName,
    }).pipe(
      Effect.andThen((jitConfig) =>
        Effect.tryPromise({
          try: () =>
            (
              env.RUNNER_CONTAINERS.getByName(
                request.containerName,
              ) as DurableObjectStub<RunnerContainer>
            ).startAttempt({
              jitConfig,
              installationId: request.installationId,
              repositoryId: request.repositoryId,
              workflowJobId: request.workflowJobId,
              runnerName: request.runnerName,
              containerName: request.containerName,
            }),
          catch: (cause) => new ProvisioningError({ step: "container_start", cause }),
        }),
      ),
    );
}
