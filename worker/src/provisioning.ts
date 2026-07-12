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
