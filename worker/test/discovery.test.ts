import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAppAuth: vi.fn(),
  runListings: [] as string[],
}));

vi.mock("@octokit/auth-app", () => ({ createAppAuth: mocks.createAppAuth }));
vi.mock("octokit", () => ({
  Octokit: class {
    rest;

    constructor(options: { auth?: { installationId?: number } }) {
      const installationId = options.auth?.installationId;
      this.rest = {
        apps: {
          listInstallations: vi.fn(async () => ({ data: [{ id: 1 }, { id: 2 }] })),
          listReposAccessibleToInstallation: vi.fn(async () => {
            if (installationId === 2) throw new Error("repository listing failed");
            return {
              data: {
                repositories: [
                  {
                    id: 10,
                    name: "fixture",
                    private: true,
                    owner: { login: "owner" },
                  },
                  {
                    id: 11,
                    name: "broken",
                    private: true,
                    owner: { login: "owner" },
                  },
                  {
                    id: 12,
                    name: "public",
                    private: false,
                    owner: { login: "owner" },
                  },
                ],
              },
            };
          }),
        },
        actions: {
          listWorkflowRunsForRepo: vi.fn(async ({ repo }: { repo: string }) => {
            mocks.runListings.push(repo);
            if (repo === "broken") throw new Error("run listing failed");
            return { data: { workflow_runs: [{ id: 100 }] } };
          }),
          listJobsForWorkflowRun: vi.fn(async () => ({
            data: {
              jobs: [
                { id: 1000, status: "queued", labels: ["jitney"] },
                { id: 1001, status: "completed", labels: ["jitney"] },
              ],
            },
          })),
        },
      };
    }
  },
}));

import { discoverQueuedJobs } from "../src/github";

describe("discoverQueuedJobs", () => {
  it("shapes queued private jobs and keeps partial discovery failures", async () => {
    mocks.runListings.length = 0;

    const result = await Effect.runPromise(
      discoverQueuedJobs({ appId: "1", privateKey: "private-key" }),
    );

    expect(result.candidates).toEqual([
      {
        installationId: 1,
        repositoryId: 10,
        repositoryOwner: "owner",
        repositoryName: "fixture",
        repositoryPrivate: true,
        workflowJobId: 1000,
        labels: ["jitney"],
      },
    ]);
    expect(result.failures).toEqual([
      { installationId: 1, repositoryId: 11, step: "run_listing" },
      { installationId: 2, step: "repository_listing" },
    ]);
    expect(mocks.runListings).toEqual(["fixture", "broken"]);
  });
});
