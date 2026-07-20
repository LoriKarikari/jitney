import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  LifecycleGitHub,
  LifecycleGitHubError,
  lifecycleStatus,
  rewriteLifecycleOwnership,
  type LifecycleInstallation,
} from "../src/lifecycle-status";

const deploymentId = "01JVQ8B95TQZD1P6DE00DE0001";
const receipt = {
  id: deploymentId,
  github: {
    installations: [
      {
        id: 42,
        repositories: [
          { id: 100, fullName: "LoriKarikari/api" },
          { id: 101, fullName: "LoriKarikari/web" },
        ],
      },
    ],
  },
};

const inventory: LifecycleInstallation[] = receipt.github.installations;

function testEnv(value: unknown = receipt): Env {
  return {
    JITNEY_DEPLOYMENT: deploymentId,
    JITNEY_RECEIPT_NAME: "jitney",
    JITNEY_RECEIPTS: { get: () => Promise.resolve(value) },
  } as unknown as Env;
}

const noRewrites = () =>
  Effect.fail(
    new LifecycleGitHubError({
      operation: "ownership",
      cause: new Error("unexpected ownership rewrite"),
    }),
  );

describe("lifecycle ownership rewrite", () => {
  it("writes the deployment ULID to receipt-listed repositories", async () => {
    const written: string[] = [];
    const done = await Effect.runPromise(
      rewriteLifecycleOwnership(testEnv(), [
        { installationId: 42, fullName: "LoriKarikari/api" },
      ]).pipe(
        Effect.provideService(
          LifecycleGitHub,
          LifecycleGitHub.of({
            inventory: () => Effect.succeed(inventory),
            ownership: () => Effect.succeed(Option.some(deploymentId)),
            rewriteOwnership: (_installationId, fullName, value) =>
              Effect.sync(() => {
                written.push(`${fullName}=${value}`);
              }),
          }),
        ),
      ),
    );

    expect(done).toBe(true);
    expect(written).toEqual([`LoriKarikari/api=${deploymentId}`]);
  });

  it("refuses repositories the receipt does not list", async () => {
    let called = false;
    const done = await Effect.runPromise(
      rewriteLifecycleOwnership(testEnv(), [
        { installationId: 42, fullName: "LoriKarikari/other" },
      ]).pipe(
        Effect.provideService(
          LifecycleGitHub,
          LifecycleGitHub.of({
            inventory: () => Effect.succeed(inventory),
            ownership: () => Effect.succeed(Option.some(deploymentId)),
            rewriteOwnership: () =>
              Effect.sync(() => {
                called = true;
              }),
          }),
        ),
      ),
    );

    expect(done).toBe(false);
    expect(called).toBe(false);
  });

  it("refuses everything when the receipt belongs to another deployment", async () => {
    let called = false;
    const done = await Effect.runPromise(
      rewriteLifecycleOwnership(testEnv({ ...receipt, id: "different" }), [
        { installationId: 42, fullName: "LoriKarikari/api" },
      ]).pipe(
        Effect.provideService(
          LifecycleGitHub,
          LifecycleGitHub.of({
            inventory: () => Effect.succeed(inventory),
            ownership: () => Effect.succeed(Option.some(deploymentId)),
            rewriteOwnership: () =>
              Effect.sync(() => {
                called = true;
              }),
          }),
        ),
      ),
    );

    expect(done).toBe(false);
    expect(called).toBe(false);
  });
});

describe("lifecycle status", () => {
  it("reports matching installations and ownership without exposing inventory", async () => {
    const status = await Effect.runPromise(
      lifecycleStatus(testEnv()).pipe(
        Effect.provideService(
          LifecycleGitHub,
          LifecycleGitHub.of({
            inventory: () => Effect.succeed(inventory),
            ownership: () => Effect.succeed(Option.some(deploymentId)),
            rewriteOwnership: noRewrites,
          }),
        ),
      ),
    );

    expect(status).toEqual({
      app: "ok",
      installations: "ok",
      ownership: [
        { installationId: 42, repositoryId: 100, status: "ok" },
        { installationId: 42, repositoryId: 101, status: "ok" },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("LoriKarikari");
  });

  it("reports installation, missing ownership, and unreachable ownership separately", async () => {
    const status = await Effect.runPromise(
      lifecycleStatus(testEnv()).pipe(
        Effect.provideService(
          LifecycleGitHub,
          LifecycleGitHub.of({
            inventory: () =>
              Effect.succeed([
                {
                  id: 42,
                  repositories: [{ id: 100, fullName: "LoriKarikari/renamed" }],
                },
              ]),
            ownership: (_installationId, fullName) =>
              fullName.endsWith("/api")
                ? Effect.succeed(Option.none())
                : Effect.fail(
                    new LifecycleGitHubError({
                      operation: "ownership",
                      cause: new Error("timeout"),
                    }),
                  ),
            rewriteOwnership: noRewrites,
          }),
        ),
      ),
    );

    expect(status).toEqual({
      app: "ok",
      installations: "drifted",
      ownership: [
        { installationId: 42, repositoryId: 100, status: "missing" },
        { installationId: 42, repositoryId: 101, status: "unknown" },
      ],
    });
  });

  it("does not call GitHub when the receipt belongs to another deployment", async () => {
    let called = false;
    const status = await Effect.runPromise(
      lifecycleStatus(testEnv({ ...receipt, id: "different" })).pipe(
        Effect.provideService(
          LifecycleGitHub,
          LifecycleGitHub.of({
            inventory: () =>
              Effect.sync(() => {
                called = true;
                return inventory;
              }),
            ownership: () => Effect.succeed(Option.some(deploymentId)),
            rewriteOwnership: noRewrites,
          }),
        ),
      ),
    );

    expect(called).toBe(false);
    expect(status).toMatchObject({ app: "unknown", installations: "unknown" });
  });
});
