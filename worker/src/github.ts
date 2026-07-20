import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { Data, Effect, Result } from "effect";
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

export const discoverQueuedJobs: (input: {
  appId: string;
  privateKey: string;
}) => Effect.Effect<DiscoveryResult, DiscoveryError> = Effect.fn("GitHub.discoverQueuedJobs")(
  function* (input: { appId: string; privateKey: string }) {
    const { appId, privateKey } = input;
    const app = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
    const installations = yield* Effect.tryPromise({
      try: () => app.paginate(app.rest.apps.listInstallations, { per_page: 100 }),
      catch: (cause) => new DiscoveryError({ step: "installation_listing", cause }),
    });

    const result: DiscoveryResult = { candidates: [], failures: [] };
    for (const { id: installationId } of installations) {
      const installation = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId },
      });
      const repositories = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            installation.paginate(installation.rest.apps.listReposAccessibleToInstallation, {
              per_page: 100,
            }),
          catch: (cause) => new DiscoveryError({ step: "repository_listing", cause }),
        }),
      );
      if (Result.isFailure(repositories)) {
        result.failures.push({ installationId, step: repositories.failure.step });
        continue;
      }

      for (const repository of repositories.success) {
        if (!repository.private) continue;
        const { id: repositoryId, name: repositoryName, private: repositoryPrivate } = repository;
        const repositoryOwner = repository.owner.login;
        const correlation = { installationId, repositoryId };
        const runs = yield* Effect.result(
          Effect.tryPromise({
            try: () =>
              installation.paginate(installation.rest.actions.listWorkflowRunsForRepo, {
                owner: repositoryOwner,
                repo: repositoryName,
                status: "queued",
                per_page: 100,
              }),
            catch: (cause) => new DiscoveryError({ step: "run_listing", cause }),
          }),
        );
        if (Result.isFailure(runs)) {
          result.failures.push({ ...correlation, step: runs.failure.step });
          continue;
        }

        for (const run of runs.success) {
          const jobs = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                installation.paginate(installation.rest.actions.listJobsForWorkflowRun, {
                  owner: repositoryOwner,
                  repo: repositoryName,
                  run_id: run.id,
                  per_page: 100,
                }),
              catch: (cause) => new DiscoveryError({ step: "job_listing", cause }),
            }),
          );
          if (Result.isFailure(jobs)) {
            result.failures.push({ ...correlation, step: jobs.failure.step });
            continue;
          }

          for (const job of jobs.success) {
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
  },
);
