import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { CloudflarePlane } from "../src/planes/cloudflare.js";
import { GitHubPlane } from "../src/planes/github.js";
import { InjectedFailure, ResourceNotFound } from "../src/planes/errors.js";
import { makeCloudflarePlaneFake, makeGitHubPlaneFake } from "../src/planes/testing/fakes.js";
import { assertPlaneInvariants } from "../src/planes/testing/invariants.js";

function runCloudflare<A, E>(
  fake: ReturnType<typeof makeCloudflarePlaneFake>,
  effect: Effect.Effect<A, E, CloudflarePlane>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(fake.layer)));
}

function runGitHub<A, E>(
  fake: ReturnType<typeof makeGitHubPlaneFake>,
  effect: Effect.Effect<A, E, GitHubPlane>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(fake.layer)));
}

describe("Cloudflare plane fake", () => {
  it("keeps the container application when its Worker is deleted", async () => {
    const fake = makeCloudflarePlaneFake();
    const application = await runCloudflare(
      fake,
      Effect.gen(function* () {
        const plane = yield* CloudflarePlane;
        yield* plane.putWorker({ name: "jitney", version: "0.3.0" });
        const created = yield* plane.createApplication({
          name: "jitney-runner",
          workerName: "jitney",
          image: "jitney:0.3.0",
        });
        yield* plane.deleteWorker("jitney");
        return created;
      }),
    );

    expect(
      await runCloudflare(
        fake,
        CloudflarePlane.pipe(
          Effect.flatMap((p) => p.getWorker("jitney")),
          Effect.exit,
        ),
      ),
    ).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", error: { _tag: "ResourceNotFound" } },
    });
    const inventory = await runCloudflare(
      fake,
      Effect.gen(function* () {
        const plane = yield* CloudflarePlane;
        return {
          workers: yield* plane.listWorkers(),
          applications: yield* plane.listApplications(),
        };
      }),
    );
    expect(inventory).toEqual({ workers: [], applications: [application] });
  });

  it("returns ResourceNotFound when deletion is repeated", async () => {
    const fake = makeCloudflarePlaneFake({ workers: [{ name: "jitney", version: "0.3.0" }] });
    await runCloudflare(
      fake,
      CloudflarePlane.pipe(Effect.flatMap((p) => p.deleteWorker("jitney"))),
    );

    const exit = await Effect.runPromiseExit(
      CloudflarePlane.pipe(
        Effect.flatMap((plane) => plane.deleteWorker("jitney")),
        Effect.provide(fake.layer),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ResourceNotFound);
    }
  });

  it("overwrites KV values and garbage-collects only unreferenced layers", async () => {
    const fake = makeCloudflarePlaneFake();
    const collected = await runCloudflare(
      fake,
      Effect.gen(function* () {
        const plane = yield* CloudflarePlane;
        yield* plane.ensureKVNamespace("jitney-receipts");
        yield* plane.putKV("jitney-receipts", "prod", "first");
        yield* plane.putKV("jitney-receipts", "prod", "second");
        yield* plane.putRegistryImage({
          repository: "jitney",
          tag: "0.2.0",
          layers: ["base", "old"],
        });
        yield* plane.putRegistryImage({
          repository: "jitney",
          tag: "0.3.0",
          layers: ["base", "new"],
        });
        yield* plane.deleteRegistryTag("jitney", "0.2.0");
        return {
          value: yield* plane.getKV("jitney-receipts", "prod"),
          layers: yield* plane.collectRegistryGarbage("jitney"),
        };
      }),
    );

    expect(collected).toEqual({ value: "second", layers: ["old"] });
    expect(fake.registryLayers("jitney")).toEqual(["base", "new"]);
  });
});

describe("GitHub plane fake", () => {
  it("suspends and deletes installations and manages repository variables", async () => {
    const fake = makeGitHubPlaneFake({
      apps: [{ id: 7, slug: "jitney-prod" }],
      installations: [{ appId: 7, id: 11, owner: "LoriKarikari", suspended: false }],
    });

    await runGitHub(
      fake,
      Effect.gen(function* () {
        const plane = yield* GitHubPlane;
        yield* plane.putRepositoryVariable("LoriKarikari/jitney", "JITNEY_DEPLOYMENT", "01JTEST");
        yield* plane.suspendInstallation(7, 11);
        expect(yield* plane.getRepositoryVariable("LoriKarikari/jitney", "JITNEY_DEPLOYMENT")).toBe(
          "01JTEST",
        );
        expect(yield* plane.listInstallations(7)).toMatchObject([{ id: 11, suspended: true }]);
        yield* plane.deleteRepositoryVariable("LoriKarikari/jitney", "JITNEY_DEPLOYMENT");
        yield* plane.deleteInstallation(7, 11);
      }),
    );

    const missing = await runGitHub(
      fake,
      GitHubPlane.pipe(
        Effect.flatMap((plane) => plane.deleteInstallation(7, 11)),
        Effect.flip,
      ),
    );
    expect(missing).toBeInstanceOf(ResourceNotFound);
  });
});

describe("plane fault injection and invariants", () => {
  it("injects a typed failure or a crash at the selected operation step", async () => {
    const failure = makeCloudflarePlaneFake({ fault: { failAt: 2 } });
    const failed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const plane = yield* CloudflarePlane;
        yield* plane.putWorker({ name: "one", version: "0.3.0" });
        yield* plane.putWorker({ name: "two", version: "0.3.0" });
      }).pipe(Effect.provide(failure.layer)),
    );
    expect(Exit.isFailure(failed) && failed.cause._tag === "Fail").toBe(true);
    if (Exit.isFailure(failed) && failed.cause._tag === "Fail") {
      expect(failed.cause.error).toBeInstanceOf(InjectedFailure);
    }

    const crash = makeCloudflarePlaneFake({ fault: { crashAt: 1 } });
    const crashed = await Effect.runPromiseExit(
      CloudflarePlane.pipe(
        Effect.flatMap((plane) => plane.putWorker({ name: "one", version: "0.3.0" })),
        Effect.provide(crash.layer),
      ),
    );
    expect(Exit.isFailure(crashed) && crashed.cause._tag === "Die").toBe(true);
  });

  it("rejects unrecorded resources and live leases on terminal receipts", async () => {
    const cloudflare = makeCloudflarePlaneFake({
      workers: [{ name: "jitney", version: "0.3.0" }],
    });

    const orphan = await Effect.runPromise(
      assertPlaneInvariants({
        resources: cloudflare.resources(),
        receipts: [],
      }).pipe(Effect.flip),
    );
    expect(orphan).toMatchObject({ violation: "unrecorded_resource" });

    const staleLease = await Effect.runPromise(
      assertPlaneInvariants({
        resources: cloudflare.resources(),
        receipts: [
          {
            resources: cloudflare.resources(),
            terminal: true,
            lease: { operation: "install", expiresAt: Date.now() + 60_000 },
          },
        ],
      }).pipe(Effect.flip),
    );
    expect(staleLease).toMatchObject({ violation: "terminal_live_lease" });

    await expect(
      Effect.runPromise(
        assertPlaneInvariants({
          resources: cloudflare.resources(),
          receipts: [
            {
              resources: cloudflare.resources(),
              terminal: true,
            },
          ],
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
