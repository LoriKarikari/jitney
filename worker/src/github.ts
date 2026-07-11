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
  return Effect.gen(function* () {
    const auth = createAppAuth({ appId: input.appId, privateKey: input.privateKey });
    const app = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: input.appId, privateKey: input.privateKey },
    });

    const installation = yield* Effect.tryPromise({
      try: () =>
        app.rest.apps.getRepoInstallation({
          owner: input.repositoryOwner,
          repo: input.repositoryName,
        }),
      catch: (cause) => new ProvisioningError({ step: "installation_verification", cause }),
    });

    if (installation.data.id !== input.installationId) {
      return yield* Effect.fail(
        new InstallationMismatch({ expected: input.installationId, actual: installation.data.id }),
      );
    }

    const { token } = yield* Effect.tryPromise({
      try: () =>
        auth({
          type: "installation",
          installationId: input.installationId,
          repositoryIds: [input.repositoryId],
          permissions: { administration: "write", actions: "read" },
        }),
      catch: (cause) => new ProvisioningError({ step: "installation_token", cause }),
    });

    const repo = new Octokit({ auth: token });
    const { data } = yield* Effect.tryPromise({
      try: () =>
        repo.rest.actions.generateRunnerJitconfigForRepo({
          owner: input.repositoryOwner,
          repo: input.repositoryName,
          name: input.runnerName,
          runner_group_id: 1,
          labels: ["jitney"],
          work_folder: "_work",
        }),
      catch: (cause) => new ProvisioningError({ step: "jit_config", cause }),
    });

    return data.encoded_jit_config;
  });
}
