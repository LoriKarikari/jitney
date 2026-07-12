import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAppAuth: vi.fn(),
  pagination: [] as Array<{ operation: string; perPage: number | undefined }>,
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
          listInstallations: Object.assign(
            vi.fn(async ({ page }: { page: number }) => ({
              data: page === 1 ? [{ id: 1 }] : [{ id: 2 }],
            })),
            { operation: "installations" },
          ),
          listReposAccessibleToInstallation: Object.assign(
            vi.fn(async ({ page }: { page: number }) => {
              if (installationId === 2) throw new Error("repository listing failed");
              return {
                data: {
                  repositories:
                    page === 1
                      ? [
                          {
                            id: 10,
                            name: "fixture",
                            private: true,
                            owner: { login: "owner" },
                          },
                        ]
                      : [
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
            { operation: "repositories" },
          ),
        },
        actions: {
          listWorkflowRunsForRepo: Object.assign(
            vi.fn(async ({ repo, page }: { repo: string; page: number }) => {
              if (page === 1) mocks.runListings.push(repo);
              if (repo === "broken" && page === 2) throw new Error("run listing failed");
              return { data: { workflow_runs: [{ id: page === 1 ? 100 : 101 }] } };
            }),
            { operation: "runs" },
          ),
          listJobsForWorkflowRun: Object.assign(
            vi.fn(async ({ run_id: runId, page }: { run_id: number; page: number }) => ({
              data: {
                jobs:
                  page === 1
                    ? [
                        { id: runId * 10, status: "queued", labels: ["jitney"] },
                        { id: runId * 10 + 1, status: "completed", labels: ["jitney"] },
                      ]
                    : [{ id: runId * 10 + 2, status: "queued", labels: ["jitney"] }],
              },
            })),
            { operation: "jobs" },
          ),
        },
      };
    }

    async paginate(
      method: ((options: Record<string, unknown>) => Promise<{ data: unknown }>) & {
        operation: string;
      },
      options: { per_page?: number },
    ): Promise<unknown[]> {
      mocks.pagination.push({ operation: method.operation, perPage: options.per_page });
      const items: unknown[] = [];
      for (const page of [1, 2]) {
        const { data } = await method({ ...options, page });
        if (Array.isArray(data)) items.push(...data);
        else if (isPage(data, "repositories")) items.push(...data.repositories);
        else if (isPage(data, "workflow_runs")) items.push(...data.workflow_runs);
        else if (isPage(data, "jobs")) items.push(...data.jobs);
      }
      return items;
    }
  },
}));

function isPage<Key extends string>(value: unknown, key: Key): value is Record<Key, unknown[]> {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, key));
}

import { discoverQueuedJobs } from "../src/github";

describe("discoverQueuedJobs", () => {
  it("paginates every listing and keeps partial discovery failures", async () => {
    mocks.pagination.length = 0;
    mocks.runListings.length = 0;

    const result = await Effect.runPromise(
      discoverQueuedJobs({ appId: "1", privateKey: "private-key" }),
    );

    expect(result.candidates).toEqual([
      candidate(1000),
      candidate(1002),
      candidate(1010),
      candidate(1012),
    ]);
    expect(result.failures).toEqual([
      { installationId: 1, repositoryId: 11, step: "run_listing" },
      { installationId: 2, step: "repository_listing" },
    ]);
    expect(mocks.runListings).toEqual(["fixture", "broken"]);
    expect(mocks.pagination).toEqual([
      { operation: "installations", perPage: 100 },
      { operation: "repositories", perPage: 100 },
      { operation: "runs", perPage: 100 },
      { operation: "jobs", perPage: 100 },
      { operation: "jobs", perPage: 100 },
      { operation: "runs", perPage: 100 },
      { operation: "repositories", perPage: 100 },
    ]);
  });
});

function candidate(workflowJobId: number) {
  return {
    installationId: 1,
    repositoryId: 10,
    repositoryOwner: "owner",
    repositoryName: "fixture",
    repositoryPrivate: true,
    workflowJobId,
    labels: ["jitney"],
  };
}
