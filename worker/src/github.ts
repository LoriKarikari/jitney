import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { Data, Effect, Either } from "effect";
import type { QueuedJobCandidate } from "./domain";

export class InstallationMismatch extends Data.TaggedError("InstallationMismatch")<{
  expected: number;
  actual: number;
}> {}

export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
  step: string;
  cause: unknown;
}> {}

type ProvisioningInput = {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  runnerName: string;
};

type RunnerCleanupInput = {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  runnerName: string;
};

type DiscoveryFailure = {
  step: string;
  installationId: number;
  repositoryId?: number;
};

export type DiscoveryResult = {
  candidates: QueuedJobCandidate[];
  failures: DiscoveryFailure[];
};

export function discoverQueuedJobs(input: {
  appId: string;
  privateKey: string;
}): Effect.Effect<DiscoveryResult, ProvisioningError> {
  const { appId, privateKey } = input;

  return Effect.gen(function* () {
    const app = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
    const installations = yield* Effect.tryPromise({
      try: () => app.rest.apps.listInstallations(),
      catch: (cause) => new ProvisioningError({ step: "installation_listing", cause }),
    });

    const result: DiscoveryResult = { candidates: [], failures: [] };
    for (const { id: installationId } of installations.data) {
      const installation = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId },
      });
      const repositories = yield* Effect.either(
        Effect.tryPromise({
          try: () => installation.rest.apps.listReposAccessibleToInstallation(),
          catch: (cause) => new ProvisioningError({ step: "repository_listing", cause }),
        }),
      );
      if (Either.isLeft(repositories)) {
        result.failures.push({ installationId, step: repositories.left.step });
        continue;
      }

      for (const repository of repositories.right.data.repositories) {
        if (!repository.private) continue;
        const { id: repositoryId, name: repositoryName, private: repositoryPrivate } = repository;
        const repositoryOwner = repository.owner.login;
        const correlation = { installationId, repositoryId };
        const runs = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              installation.rest.actions.listWorkflowRunsForRepo({
                owner: repositoryOwner,
                repo: repositoryName,
                status: "queued",
              }),
            catch: (cause) => new ProvisioningError({ step: "run_listing", cause }),
          }),
        );
        if (Either.isLeft(runs)) {
          result.failures.push({ ...correlation, step: runs.left.step });
          continue;
        }

        for (const run of runs.right.data.workflow_runs) {
          const jobs = yield* Effect.either(
            Effect.tryPromise({
              try: () =>
                installation.rest.actions.listJobsForWorkflowRun({
                  owner: repositoryOwner,
                  repo: repositoryName,
                  run_id: run.id,
                }),
              catch: (cause) => new ProvisioningError({ step: "job_listing", cause }),
            }),
          );
          if (Either.isLeft(jobs)) {
            result.failures.push({ ...correlation, step: jobs.left.step });
            continue;
          }

          for (const job of jobs.right.data.jobs) {
            if (job.status !== "queued") continue;
            result.candidates.push({
              ...correlation,
              repositoryOwner,
              repositoryName,
              repositoryPrivate,
              workflowJobId: job.id,
              labels: [...job.labels],
            });
          }
        }
      }
    }
    return result;
  });
}

export function deleteRunner(input: RunnerCleanupInput): Effect.Effect<void, ProvisioningError> {
  const { appId, privateKey, installationId, repositoryId, repositoryOwner, repositoryName } =
    input;

  return Effect.gen(function* () {
    const auth = createAppAuth({ appId, privateKey });
    const { token } = yield* Effect.tryPromise({
      try: () =>
        auth({
          type: "installation",
          installationId,
          repositoryIds: [repositoryId],
          permissions: { administration: "write" },
        }),
      catch: (cause) => new ProvisioningError({ step: "installation_token", cause }),
    });

    const repo = new Octokit({ auth: token });
    const { data } = yield* Effect.tryPromise({
      try: () =>
        repo.rest.actions.listSelfHostedRunnersForRepo({
          owner: repositoryOwner,
          repo: repositoryName,
        }),
      catch: (cause) => new ProvisioningError({ step: "runner_lookup", cause }),
    });

    const runner = data.runners.find((candidate) => candidate.name === input.runnerName);
    if (runner === undefined) return;

    yield* Effect.tryPromise({
      try: () =>
        repo.rest.actions.deleteSelfHostedRunnerFromRepo({
          owner: repositoryOwner,
          repo: repositoryName,
          runner_id: runner.id,
        }),
      catch: (cause) => new ProvisioningError({ step: "runner_deletion", cause }),
    });
  });
}

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
