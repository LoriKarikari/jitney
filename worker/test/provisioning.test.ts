import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProvisionRequest } from "../src/provisioning";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const auth = vi.fn(async () => {
    calls.push("installation_token");
    return { token: "installation-token" };
  });

  return { calls, auth, createAppAuth: vi.fn(() => auth) };
});

vi.mock("@octokit/auth-app", () => ({ createAppAuth: mocks.createAppAuth }));
vi.mock("octokit", () => ({
  Octokit: class {
    rest = {
      actions: {
        listSelfHostedRunnersForRepo: vi.fn(async () => {
          mocks.calls.push("runner_lookup");
          return { data: { runners: [{ id: 7, name: "jitney-456-789-1" }] } };
        }),
        deleteSelfHostedRunnerFromRepo: vi.fn(async () => {
          mocks.calls.push("runner_deletion");
          return { status: 204 };
        }),
      },
    };
  },
}));

import { ProvisioningError } from "../src/github";
import { createReclaimer } from "../src/provisioning";

const request: ProvisionRequest = {
  installationId: 123,
  repositoryId: 456,
  repositoryOwner: "LoriKarikari",
  repositoryName: "jitney-test",
  workflowJobId: 789,
  runnerName: "jitney-456-789-1",
  containerName: "attempt-456-789-1",
};

function reclaimerEnv(destroy: () => Promise<void>): Env {
  return {
    GITHUB_APP_ID: "4271277",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    RUNNER_CONTAINERS: {
      getByName: (name: string) => {
        expect(name).toBe(request.containerName);
        return { destroy };
      },
    },
  } as unknown as Env;
}

describe("createReclaimer", () => {
  it("destroys the container before deleting the runner registration", async () => {
    mocks.calls.length = 0;
    const env = reclaimerEnv(async () => {
      mocks.calls.push("container_destroy");
    });

    await Effect.runPromise(createReclaimer(env)(request));

    expect(mocks.calls).toEqual([
      "container_destroy",
      "installation_token",
      "runner_lookup",
      "runner_deletion",
    ]);
  });

  it("does not touch GitHub when the container destroy fails", async () => {
    mocks.calls.length = 0;
    const env = reclaimerEnv(async () => {
      throw new Error("destroy failed");
    });

    const result = await Effect.runPromiseExit(createReclaimer(env)(request));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && result.cause._tag === "Fail") {
      expect(result.cause.error).toBeInstanceOf(ProvisioningError);
      expect(result.cause.error.step).toBe("container_destroy");
    }
    expect(mocks.calls).toEqual([]);
  });
});
