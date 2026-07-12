import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { Data, Effect, Either } from "effect";
import type { QueuedJobCandidate } from "./domain";

export type DiscoveryFailureStep =
  | "installation_listing"
  | "repository_listing"
  | "run_listing"
  | "job_listing";

export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  step: DiscoveryFailureStep;
  cause: unknown;
}> {}

type DiscoveryFailure = {
  step: DiscoveryFailureStep;
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
}): Effect.Effect<DiscoveryResult, DiscoveryError> {
  const { appId, privateKey } = input;

  return Effect.gen(function* () {
    const app = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
    const installations = yield* Effect.tryPromise({
      try: () => app.rest.apps.listInstallations(),
      catch: (cause) => new DiscoveryError({ step: "installation_listing", cause }),
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
          catch: (cause) => new DiscoveryError({ step: "repository_listing", cause }),
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
            catch: (cause) => new DiscoveryError({ step: "run_listing", cause }),
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
              catch: (cause) => new DiscoveryError({ step: "job_listing", cause }),
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
