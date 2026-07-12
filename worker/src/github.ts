import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { Data, Effect } from "effect";

export class InstallationMismatch extends Data.TaggedError("InstallationMismatch")<{
  expected: number;
  actual: number;
}> {}

export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
  step: string;
  cause: unknown;
}> {}

export type ProvisioningInput = {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  runnerName: string;
};

export function generateJitConfig(
  input: ProvisioningInput,
): Effect.Effect<string, InstallationMismatch | ProvisioningError> {
  const {
    appId,
    privateKey,
    installationId,
    repositoryId,
    repositoryOwner,
    repositoryName,
    runnerName,
  } = input;

  return Effect.gen(function* () {
    const auth = createAppAuth({ appId, privateKey });
    const app = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey },
    });

    const installation = yield* Effect.tryPromise({
      try: () =>
        app.rest.apps.getRepoInstallation({
          owner: repositoryOwner,
          repo: repositoryName,
        }),
      catch: (cause) => new ProvisioningError({ step: "installation_verification", cause }),
    });

    if (installation.data.id !== installationId) {
      return yield* Effect.fail(
        new InstallationMismatch({ expected: installationId, actual: installation.data.id }),
      );
    }

    const { token } = yield* Effect.tryPromise({
      try: () =>
        auth({
          type: "installation",
          installationId,
          repositoryIds: [repositoryId],
          permissions: { administration: "write", actions: "read" },
        }),
      catch: (cause) => new ProvisioningError({ step: "installation_token", cause }),
    });

    const repo = new Octokit({ auth: token });
    const { data } = yield* Effect.tryPromise({
      try: () =>
        repo.rest.actions.generateRunnerJitconfigForRepo({
          owner: repositoryOwner,
          repo: repositoryName,
          name: runnerName,
          runner_group_id: 1,
          labels: ["jitney"],
          work_folder: "_work",
        }),
      catch: (cause) => new ProvisioningError({ step: "jit_config", cause }),
    });

    return data.encoded_jit_config;
  });
}
