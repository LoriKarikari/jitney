import { DateTime, Duration, Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { InstallerError, UpgradeRollbackError } from "../src/errors.js";
import { DeploymentReceipts } from "../src/install.js";
import { createDeploymentReceipt, type DeploymentReceipt } from "../src/receipts/schema.js";
import { makeReceiptStore, type ReceiptBackend } from "../src/receipts/store.js";
import {
  UpgradePlatform,
  changeDeploymentVersion,
  type VersionChangeOperation,
} from "../src/upgrade.js";

const deploymentId = "01JVQ8B95TQZD1P6DE00DE0001";

function fixtureReceipt(): DeploymentReceipt {
  const receipt = createDeploymentReceipt({
    id: deploymentId,
    name: "jitney",
    version: "0.3.0",
    now: DateTime.makeUnsafe("2026-07-20T12:00:00.000Z"),
    cloudflare: {
      accountId: "account-1",
      workerName: "jitney",
      applicationId: "application-id",
      applicationName: "jitney-runner",
      durableObjectClasses: ["Scheduler", "RunnerContainer"],
      registryRepo: "jitney-runner",
      tags: { current: "current-tag", previous: "previous-tag" },
    },
    github: {
      appId: 12345,
      appSlug: "jitney-x7k2",
      ownerLogin: "LoriKarikari",
      ownerType: "User",
      installations: [],
    },
    autoUpgrade: { enabled: false, channel: "patch" },
  });
  return {
    ...receipt,
    phase: "active",
    versions: { current: "0.3.0", previous: "0.2.0" },
  };
}

async function memoryBackend(receipt: DeploymentReceipt) {
  const values = await Effect.runPromise(
    Ref.make(new Map([[receipt.name, JSON.stringify(receipt)]])),
  );
  const service: ReceiptBackend = {
    get: (name) => Effect.map(Ref.get(values), (current) => current.get(name)),
    put: (name, value) =>
      Ref.update(values, (current) => new Map(current).set(name, value)).pipe(Effect.asVoid),
    remove: (name) =>
      Ref.update(values, (current) => {
        const next = new Map(current);
        next.delete(name);
        return next;
      }).pipe(Effect.asVoid),
    listKeys: () => Effect.map(Ref.get(values), (current) => [...current.keys()]),
    removeNamespace: () => Effect.void,
  };
  return {
    service,
    receipt: () =>
      Effect.runPromise(
        Effect.map(
          Ref.get(values),
          (current) => JSON.parse(current.get(receipt.name) ?? "null") as DeploymentReceipt,
        ),
      ),
  };
}

async function fakePlatform(options?: { failTarget?: boolean; failRollback?: boolean }) {
  const calls = await Effect.runPromise(Ref.make<string[]>([]));
  const call = (event: string) => Ref.update(calls, (current) => [...current, event]);
  const activate = (version: string) =>
    call(`activate:${version}`).pipe(
      Effect.andThen(
        (version === "0.4.0" && options?.failTarget === true) ||
          (version === "0.3.0" && options?.failRollback === true)
          ? Effect.fail(
              new InstallerError({ step: "health_check", message: `${version} is unhealthy` }),
            )
          : Effect.void,
      ),
    );
  return {
    calls,
    service: UpgradePlatform.of({
      prepare: (_receipt, operation: VersionChangeOperation, version, existingTag) =>
        call(`prepare:${operation}:${version}`).pipe(Effect.as(existingTag ?? "target-tag")),
      drain: () => call("drain"),
      activate: (_receipt, version) => activate(version),
      resume: () => call("resume"),
      prune: (_receipt, tag) => call(`prune:${tag}`),
    }),
  };
}

const run = async (
  backend: Awaited<ReturnType<typeof memoryBackend>>,
  platform: Awaited<ReturnType<typeof fakePlatform>>,
  operation: VersionChangeOperation,
) =>
  Effect.runPromise(
    changeDeploymentVersion({
      name: "jitney",
      actor: "lori@mbp",
      operation,
      ...(operation === "upgrade" ? { targetVersion: "0.4.0" } : {}),
    }).pipe(
      Effect.provideService(
        DeploymentReceipts,
        makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero }),
      ),
      Effect.provideService(UpgradePlatform, platform.service),
    ),
  );

describe("deployment version changes", () => {
  it("drains, activates, health-gates, rotates, and prunes an upgrade", async () => {
    const backend = await memoryBackend(fixtureReceipt());
    const platform = await fakePlatform();

    const receipt = await run(backend, platform, "upgrade");

    expect(await Effect.runPromise(Ref.get(platform.calls))).toEqual([
      "prepare:upgrade:0.4.0",
      "drain",
      "activate:0.4.0",
      "prune:previous-tag",
      "resume",
    ]);
    expect(receipt).toMatchObject({
      phase: "active",
      lease: null,
      versions: { current: "0.4.0", previous: "0.3.0" },
      cloudflare: { tags: { current: "target-tag", previous: "current-tag" } },
    });
    expect(receipt.history.at(-1)).toMatchObject({ operation: "upgrade", outcome: "succeeded" });
  });

  it("restores the previous pair and returns the original health failure", async () => {
    const backend = await memoryBackend(fixtureReceipt());
    const platform = await fakePlatform({ failTarget: true });

    const error = await Effect.runPromise(
      Effect.flip(
        changeDeploymentVersion({
          name: "jitney",
          actor: "lori@mbp",
          operation: "upgrade",
          targetVersion: "0.4.0",
        }).pipe(
          Effect.provideService(
            DeploymentReceipts,
            makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero }),
          ),
          Effect.provideService(UpgradePlatform, platform.service),
        ),
      ),
    );

    expect(error).toMatchObject({ message: "0.4.0 is unhealthy" });
    expect(await Effect.runPromise(Ref.get(platform.calls))).toEqual([
      "prepare:upgrade:0.4.0",
      "drain",
      "activate:0.4.0",
      "activate:0.3.0",
      "resume",
    ]);
    expect(await backend.receipt()).toMatchObject({
      phase: "active",
      lease: null,
      versions: { current: "0.3.0", previous: "0.2.0" },
      cloudflare: { tags: { current: "current-tag", previous: "previous-tag" } },
    });
  });

  it("freezes provisioning and keeps the receipt for repair when rollback fails", async () => {
    const backend = await memoryBackend(fixtureReceipt());
    const platform = await fakePlatform({ failTarget: true, failRollback: true });

    const error = await Effect.runPromise(
      Effect.flip(
        changeDeploymentVersion({
          name: "jitney",
          actor: "lori@mbp",
          operation: "upgrade",
          targetVersion: "0.4.0",
        }).pipe(
          Effect.provideService(
            DeploymentReceipts,
            makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero }),
          ),
          Effect.provideService(UpgradePlatform, platform.service),
        ),
      ),
    );

    expect(error).toBeInstanceOf(UpgradeRollbackError);
    expect(error).toMatchObject({
      cause: { message: "0.4.0 is unhealthy" },
      rollbackCause: { message: "0.3.0 is unhealthy" },
    });
    expect(await backend.receipt()).toMatchObject({
      phase: "upgrading",
      lease: { operation: "upgrade" },
      versions: { current: "0.4.0", previous: "0.3.0" },
    });
    expect(await Effect.runPromise(Ref.get(platform.calls))).not.toContain("resume");
  });

  it("swaps current and previous without pruning during an explicit rollback", async () => {
    const backend = await memoryBackend(fixtureReceipt());
    const platform = await fakePlatform();

    const receipt = await run(backend, platform, "rollback");

    expect(await Effect.runPromise(Ref.get(platform.calls))).toEqual([
      "prepare:rollback:0.2.0",
      "drain",
      "activate:0.2.0",
      "resume",
    ]);
    expect(receipt).toMatchObject({
      versions: { current: "0.2.0", previous: "0.3.0" },
      cloudflare: { tags: { current: "previous-tag", previous: "current-tag" } },
    });
  });
});
