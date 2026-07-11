import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const auth = vi.fn(async () => ({ token: "installation-token" }));
  const createAppAuth = vi.fn(() => auth);
  const constructors: unknown[] = [];

  return { auth, createAppAuth, constructors };
});

vi.mock("@octokit/auth-app", () => ({ createAppAuth: mocks.createAppAuth }));
vi.mock("octokit", () => ({
  Octokit: class {
    rest;

    constructor(options: unknown) {
      mocks.constructors.push(options);
      this.rest = {
        apps: {
          getRepoInstallation: vi.fn(async () => ({ data: { id: 123 } })),
        },
        actions: {
          generateRunnerJitconfigForRepo: vi.fn(async () => ({
            data: { encoded_jit_config: "jit-config" },
          })),
        },
      };
    }
  },
}));

import { generateJitConfig } from "../src/github";

describe("GitHub App authentication", () => {
  it("passes the createAppAuth strategy factory to Octokit", async () => {
    const result = await Effect.runPromise(
      generateJitConfig({
        appId: "4271277",
        privateKey: "private-key",
        installationId: 123,
        repositoryId: 456,
        repositoryOwner: "LoriKarikari",
        repositoryName: "jitney-test",
        runnerName: "jitney-456-789-1",
      }),
    );

    expect(result).toBe("jit-config");
    expect(mocks.constructors[0]).toEqual({
      authStrategy: mocks.createAppAuth,
      auth: { appId: "4271277", privateKey: "private-key" },
    });
  });
});
