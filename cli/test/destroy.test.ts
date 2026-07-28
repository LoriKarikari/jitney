import { DateTime, Duration, Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
  DestroyPlatform,
  DestroyResidueError,
  destroyDeployment,
  type DestroyPlan,
} from "../src/destroy.js";
import { DeploymentReceipts } from "../src/install.js";
import {
  createDeploymentReceipt,
  type DeploymentReceipt,
  type DestroyResidue,
} from "../src/receipts/schema.js";
import { makeReceiptStore, type ReceiptBackend } from "../src/receipts/store.js";

const deploymentId = "01JVQ8B95TQZD1P6DE00DE0001";

function fixtureReceipt(name = "staging"): DeploymentReceipt {
  const receipt = createDeploymentReceipt({
    id: deploymentId,
    name,
    version: "0.3.0",
    now: DateTime.makeUnsafe("2026-07-20T12:00:00.000Z"),
    cloudflare: {
      accountId: "account-1",
      workerName: name,
      applicationId: "application-id",
      applicationName: `${name}-runner`,
      durableObjectClasses: ["Scheduler", "RunnerContainer"],
      registryRepo: `${name}-runner`,
      tags: { current: "0.3.0", previous: "0.2.0" },
    },
    github: {
      appId: 12345,
      appSlug: `${name}-x7k2`,
      ownerLogin: "LoriKarikari",
      ownerType: "User",
      installations: [
        {
          id: 42,
          accountLogin: "LoriKarikari",
          accountType: "User",
          repositories: [{ id: 100, name: "api", fullName: "LoriKarikari/api" }],
        },
      ],
    },
    autoUpgrade: { enabled: false, channel: "patch" },
  });
  return { ...receipt, phase: "active" };
}

async function memoryBackend(receipts: readonly DeploymentReceipt[]) {
  const values = await Effect.runPromise(
    Ref.make(new Map(receipts.map((receipt) => [receipt.name, JSON.stringify(receipt)]))),
  );
  let namespaceRemoved = false;
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
    removeNamespace: () => Effect.sync(() => void (namespaceRemoved = true)),
  };
  return {
    service,
    receipt: (name: string) =>
      Effect.runPromise(
        Effect.map(Ref.get(values), (current) => {
          const value = current.get(name);
          return value === undefined ? undefined : (JSON.parse(value) as DeploymentReceipt);
        }),
      ),
    namespaceRemoved: () => namespaceRemoved,
  };
}

function platform(input?: {
  confirm?: boolean;
  residue?: readonly DestroyResidue[];
  calls?: Ref.Ref<string[]>;
  exported?: Ref.Ref<DeploymentReceipt[]>;
}) {
  const call = (name: string) =>
    input?.calls === undefined
      ? Effect.void
      : Ref.update(input.calls, (current) => [...current, name]);
  return DestroyPlatform.of({
    exportReceipt: (receipt) =>
      input?.exported === undefined
        ? call("export")
        : Ref.update(input.exported, (current) => [...current, receipt]).pipe(
            Effect.andThen(call("export")),
          ),
    confirm: () => call("confirm").pipe(Effect.as(input?.confirm ?? true)),
    suspend: () => call("suspend"),
    drain: () => call("drain"),
    deleteOwnership: () => call("delete_ownership"),
    deleteInstallations: () => call("delete_installations"),
    destroyCloudflare: () => call("destroy_cloudflare"),
    pruneImages: (_receipt, protectedTags) =>
      call(`prune_images:${[...protectedTags].sort().join(",")}`),
    deleteApp: () => call("delete_app"),
    verify: () => call("verify").pipe(Effect.as(input?.residue ?? [])),
  });
}

async function runDestroy(
  receipts: readonly DeploymentReceipt[],
  destroyPlatform: ReturnType<typeof platform>,
  options?: { dryRun?: boolean; now?: boolean; exportPath?: string },
) {
  const backend = await memoryBackend(receipts);
  const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });
  const effect = destroyDeployment({
    name: "staging",
    actor: "lori@mbp",
    ...options,
  }).pipe(
    Effect.provideService(DeploymentReceipts, store),
    Effect.provideService(DestroyPlatform, destroyPlatform),
  );
  return { backend, effect };
}

const expectedPlan: DestroyPlan = {
  name: "staging",
  deploymentId,
  workerName: "staging",
  applicationId: "application-id",
  appSlug: "staging-x7k2",
  installationIds: [42],
  repositories: ["LoriKarikari/api"],
  imageTags: ["0.3.0", "0.2.0"],
};

describe("destroy", () => {
  it("previews the receipt-referenced inventory without acquiring a lease", async () => {
    const calls = await Effect.runPromise(Ref.make<string[]>([]));
    const { backend, effect } = await runDestroy([fixtureReceipt()], platform({ calls }), {
      dryRun: true,
    });

    const result = await Effect.runPromise(effect);

    expect(result).toEqual({ status: "dry_run", plan: expectedPlan });
    expect(await Ref.get(calls).pipe(Effect.runPromise)).toEqual([]);
    expect(await backend.receipt("staging")).toMatchObject({ phase: "active", lease: null });
  });

  it("does nothing when confirmation is refused", async () => {
    const calls = await Effect.runPromise(Ref.make<string[]>([]));
    const { backend, effect } = await runDestroy(
      [fixtureReceipt()],
      platform({ calls, confirm: false }),
    );

    const result = await Effect.runPromise(effect);

    expect(result.status).toBe("cancelled");
    expect(await Ref.get(calls).pipe(Effect.runPromise)).toEqual(["confirm"]);
    expect(await backend.receipt("staging")).toMatchObject({ phase: "active", lease: null });
  });

  it("deletes in dependency order and removes the final receipt", async () => {
    const calls = await Effect.runPromise(Ref.make<string[]>([]));
    const other = {
      ...fixtureReceipt("production"),
      id: "01JVQ8B95TQZD1P6DE00DE0002",
      cloudflare: {
        ...fixtureReceipt("production").cloudflare,
        tags: { current: "0.4.0", previous: "0.3.0" },
      },
    };
    const { backend, effect } = await runDestroy([fixtureReceipt(), other], platform({ calls }));

    const result = await Effect.runPromise(effect);

    expect(result).toEqual({ status: "destroyed", plan: expectedPlan });
    expect(await Ref.get(calls).pipe(Effect.runPromise)).toEqual([
      "confirm",
      "suspend",
      "drain",
      "delete_ownership",
      "delete_installations",
      "destroy_cloudflare",
      "prune_images:0.3.0,0.4.0",
      "delete_app",
      "verify",
    ]);
    expect(await backend.receipt("staging")).toBeUndefined();
    expect(backend.namespaceRemoved()).toBe(false);
  });

  it("skips draining with --now", async () => {
    const calls = await Effect.runPromise(Ref.make<string[]>([]));
    const { effect } = await runDestroy([fixtureReceipt()], platform({ calls }), {
      now: true,
    });

    await Effect.runPromise(effect);

    expect(await Ref.get(calls).pipe(Effect.runPromise)).not.toContain("drain");
  });

  it("exports the redacted receipt before confirmation", async () => {
    const calls = await Effect.runPromise(Ref.make<string[]>([]));
    const exported = await Effect.runPromise(Ref.make<DeploymentReceipt[]>([]));
    const { effect } = await runDestroy(
      [fixtureReceipt()],
      platform({ calls, exported, confirm: false }),
      { exportPath: "receipt.json" },
    );

    await Effect.runPromise(effect);

    expect(await Ref.get(calls).pipe(Effect.runPromise)).toEqual(["export", "confirm"]);
    expect(await Ref.get(exported).pipe(Effect.runPromise)).toEqual([
      expect.objectContaining({ lease: null }),
    ]);
  });

  it("resumes an interrupted destroy left in phase destroying", async () => {
    const interrupted: DeploymentReceipt = {
      ...fixtureReceipt(),
      phase: "destroying",
      residue: [
        {
          plane: "registry",
          resource: "image_tag",
          id: "staging-runner:0.3.0",
          reason: "The registry still reports the tag",
        },
      ],
      history: [
        {
          operation: "destroy",
          actor: "lori@mbp",
          startedAt: DateTime.makeUnsafe("2026-07-20T11:00:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-07-20T11:10:00.000Z"),
          outcome: "failed",
        },
      ],
    };
    const calls = await Effect.runPromise(Ref.make<string[]>([]));
    const { backend, effect } = await runDestroy([interrupted], platform({ calls }));

    const result = await Effect.runPromise(effect);

    expect(result.status).toBe("destroyed");
    expect(await Ref.get(calls).pipe(Effect.runPromise)).toContain("verify");
    expect(await backend.receipt("staging")).toBeUndefined();
  });

  it("retains a destroying receipt and exits with the final residue", async () => {
    const residue: DestroyResidue[] = [
      {
        plane: "github",
        resource: "repository_variable",
        id: "LoriKarikari/api:JITNEY_DEPLOYMENT",
        reason: "Worker credentials were already gone",
      },
    ];
    const { backend, effect } = await runDestroy([fixtureReceipt()], platform({ residue }));

    const error = await Effect.runPromise(effect.pipe(Effect.flip));

    expect(error).toBeInstanceOf(DestroyResidueError);
    expect(error).toMatchObject({ name: "staging", residue });
    expect(await backend.receipt("staging")).toMatchObject({
      phase: "destroying",
      lease: null,
      residue,
      history: [expect.objectContaining({ operation: "destroy", outcome: "failed" })],
    });
  });
});
