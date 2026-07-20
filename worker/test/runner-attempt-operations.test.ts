import { Cause, Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    failAt: undefined as string | undefined,
    installationId: 123,
    runners: [{ id: 7, name: "jitney-456-789-1" }],
  };
  function step<Result>(name: string, result: Result): Result {
    state.calls.push(name);
    if (state.failAt === name) throw new Error(`${name} failed`);
    return result;
  }
  const auth = vi.fn(async () => step("installation_token", { token: "installation-token" }));
  const createAppAuth = vi.fn(() => auth);
  const constructors: unknown[] = [];
  return { state, step, auth, createAppAuth, constructors };
});

vi.mock("@octokit/auth-app", () => ({ createAppAuth: mocks.createAppAuth }));
vi.mock("octokit", () => ({
  Octokit: class {
    rest;

    constructor(options: unknown) {
      mocks.constructors.push(options);
      this.rest = {
        apps: {
          getRepoInstallation: vi.fn(async () =>
            mocks.step("installation_verification", { data: { id: mocks.state.installationId } }),
          ),
        },
        actions: {
          generateRunnerJitconfigForRepo: vi.fn(async () =>
            mocks.step("jit_config", { data: { encoded_jit_config: "jit-config" } }),
          ),
          listSelfHostedRunnersForRepo: vi.fn(async () =>
            mocks.step("runner_lookup", { data: { runners: mocks.state.runners } }),
          ),
          deleteSelfHostedRunnerFromRepo: vi.fn(async () =>
            mocks.step("runner_deletion", { status: 204 }),
          ),
        },
      };
    }
  },
}));

import {
  createRunnerAttemptOperations,
  RunnerAttemptFailure,
  type RunnerAttemptRequest,
} from "../src/runner-attempt-operations";

const request: RunnerAttemptRequest = {
  installationId: 123,
  repositoryId: 456,
  repositoryOwner: "LoriKarikari",
  repositoryName: "jitney-test",
  workflowJobId: 789,
  runnerName: "jitney-456-789-1",
  containerName: "attempt-456-789-1",
};

function environment(): Env {
  return {
    GITHUB_APP_ID: "4271277",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    RUNNER_CONTAINERS: {
      getByName: (name: string) => {
        expect(name).toBe(request.containerName);
        return {
          startAttempt: vi.fn(async (input) => mocks.step("container_start", input)),
          destroy: vi.fn(async () => mocks.step("container_destroy", undefined)),
        };
      },
    },
  } as unknown as Env;
}

beforeEach(() => {
  mocks.state.calls.length = 0;
  mocks.state.failAt = undefined;
  mocks.state.installationId = 123;
  mocks.state.runners = [{ id: 7, name: request.runnerName }];
  mocks.auth.mockClear();
  mocks.createAppAuth.mockClear();
  mocks.constructors.length = 0;
});

describe("Runner Attempt Operations", () => {
  it("provisions through repository-scoped credentials before starting the Container", async () => {
    await Effect.runPromise(createRunnerAttemptOperations(environment()).provision(request));

    expect(mocks.state.calls).toEqual([
      "installation_verification",
      "installation_token",
      "jit_config",
      "container_start",
    ]);
    expect(mocks.constructors[0]).toEqual({
      authStrategy: mocks.createAppAuth,
      auth: { appId: "4271277", privateKey: "private-key" },
    });
    expect(mocks.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 123,
      repositoryIds: [456],
      permissions: { administration: "write", actions: "read" },
    });
  });

  it("destroys the Container before deleting the runner registration", async () => {
    await Effect.runPromise(createRunnerAttemptOperations(environment()).reclaim(request));

    expect(mocks.state.calls).toEqual([
      "container_destroy",
      "installation_token",
      "runner_lookup",
      "runner_deletion",
    ]);
    expect(mocks.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 123,
      repositoryIds: [456],
      permissions: { administration: "write" },
    });
  });

  it("finishes reclaim when GitHub has already removed the JIT runner", async () => {
    mocks.state.runners = [];

    await Effect.runPromise(createRunnerAttemptOperations(environment()).reclaim(request));

    expect(mocks.state.calls).toEqual(["container_destroy", "installation_token", "runner_lookup"]);
  });

  it("classifies a repository installation mismatch before minting credentials", async () => {
    mocks.state.installationId = 999;

    const result = await Effect.runPromiseExit(
      createRunnerAttemptOperations(environment()).provision(request),
    );

    expectFailure(result, "installation_mismatch");
    expect(mocks.state.calls).toEqual(["installation_verification"]);
  });

  it.each([
    ["provision", "installation_verification"],
    ["provision", "installation_token"],
    ["provision", "jit_config"],
    ["provision", "container_start"],
    ["reclaim", "container_destroy"],
    ["reclaim", "installation_token"],
    ["reclaim", "runner_lookup"],
    ["reclaim", "runner_deletion"],
  ] as const)("classifies %s failure at %s", async (operation, step) => {
    mocks.state.failAt = step;
    const operations = createRunnerAttemptOperations(environment());

    const result = await Effect.runPromiseExit(operations[operation](request));

    expectFailure(result, step);
    expect(mocks.state.calls.at(-1)).toBe(step);
  });
});

function expectFailure(
  result: Awaited<ReturnType<typeof Effect.runPromiseExit>>,
  step: RunnerAttemptFailure["step"],
): void {
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    const failure = Cause.findErrorOption(result.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value).toBeInstanceOf(RunnerAttemptFailure);
      if (failure.value instanceof RunnerAttemptFailure) expect(failure.value.step).toBe(step);
    }
  }
}
