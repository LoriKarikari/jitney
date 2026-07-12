import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { Data, Effect } from "effect";
import type { RunnerContainer } from "./runner-container";

export type RunnerAttemptRequest = {
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  workflowJobId: number;
  runnerName: string;
  containerName: string;
};

export type RunnerAttemptFailureStep =
  | "installation_verification"
  | "installation_mismatch"
  | "installation_token"
  | "jit_config"
  | "container_start"
  | "container_destroy"
  | "runner_lookup"
  | "runner_deletion";

export class RunnerAttemptFailure extends Data.TaggedError("RunnerAttemptFailure")<{
  step: RunnerAttemptFailureStep;
  cause: unknown;
}> {}

export type RunnerAttemptOperations = {
  provision(request: RunnerAttemptRequest): Effect.Effect<void, RunnerAttemptFailure>;
  reclaim(request: RunnerAttemptRequest): Effect.Effect<void, RunnerAttemptFailure>;
};

export function createRunnerAttemptOperations(env: Env): RunnerAttemptOperations {
  const auth = createAppAuth({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY });

  function repositoryToken(
    request: RunnerAttemptRequest,
    actions: "read" | undefined,
  ): Effect.Effect<string, RunnerAttemptFailure> {
    return Effect.tryPromise({
      try: async () => {
        const result = await auth({
          type: "installation",
          installationId: request.installationId,
          repositoryIds: [request.repositoryId],
          permissions: { administration: "write", ...(actions && { actions }) },
        });
        return result.token;
      },
      catch: (cause) => new RunnerAttemptFailure({ step: "installation_token", cause }),
    });
  }

  function provision(request: RunnerAttemptRequest): Effect.Effect<void, RunnerAttemptFailure> {
    const { repositoryOwner: owner, repositoryName: repo } = request;
    return Effect.gen(function* () {
      const app = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
      });
      const installation = yield* Effect.tryPromise({
        try: () => app.rest.apps.getRepoInstallation({ owner, repo }),
        catch: (cause) => new RunnerAttemptFailure({ step: "installation_verification", cause }),
      });
      if (installation.data.id !== request.installationId) {
        return yield* Effect.fail(
          new RunnerAttemptFailure({
            step: "installation_mismatch",
            cause: { expected: request.installationId, actual: installation.data.id },
          }),
        );
      }

      const token = yield* repositoryToken(request, "read");
      const github = new Octokit({ auth: token });
      const { data } = yield* Effect.tryPromise({
        try: () =>
          github.rest.actions.generateRunnerJitconfigForRepo({
            owner,
            repo,
            name: request.runnerName,
            runner_group_id: 1,
            labels: ["jitney"],
            work_folder: "_work",
          }),
        catch: (cause) => new RunnerAttemptFailure({ step: "jit_config", cause }),
      });

      yield* Effect.tryPromise({
        try: () =>
          (
            env.RUNNER_CONTAINERS.getByName(
              request.containerName,
            ) as DurableObjectStub<RunnerContainer>
          ).startAttempt({
            jitConfig: data.encoded_jit_config,
            installationId: request.installationId,
            repositoryId: request.repositoryId,
            workflowJobId: request.workflowJobId,
            runnerName: request.runnerName,
            containerName: request.containerName,
          }),
        catch: (cause) => new RunnerAttemptFailure({ step: "container_start", cause }),
      });
    });
  }

  function reclaim(request: RunnerAttemptRequest): Effect.Effect<void, RunnerAttemptFailure> {
    const { repositoryOwner: owner, repositoryName: repo } = request;
    return Effect.gen(function* () {
      // Bound the paid resource first. GitHub rejects deletion while a runner
      // is busy, but destroying its Container is always the required first step.
      yield* Effect.tryPromise({
        try: () =>
          (
            env.RUNNER_CONTAINERS.getByName(
              request.containerName,
            ) as DurableObjectStub<RunnerContainer>
          ).destroy(),
        catch: (cause) => new RunnerAttemptFailure({ step: "container_destroy", cause }),
      });

      const token = yield* repositoryToken(request, undefined);
      const github = new Octokit({ auth: token });
      const { data } = yield* Effect.tryPromise({
        try: () => github.rest.actions.listSelfHostedRunnersForRepo({ owner, repo }),
        catch: (cause) => new RunnerAttemptFailure({ step: "runner_lookup", cause }),
      });
      const runner = data.runners.find((candidate) => candidate.name === request.runnerName);
      if (runner === undefined) return;

      yield* Effect.tryPromise({
        try: () =>
          github.rest.actions.deleteSelfHostedRunnerFromRepo({
            owner,
            repo,
            runner_id: runner.id,
          }),
        catch: (cause) => new RunnerAttemptFailure({ step: "runner_deletion", cause }),
      });
    });
  }

  return { provision, reclaim };
}
