import { DateTime, Duration, Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import type { AccountSnapshot } from "../src/cloudflare-inventory.js";
import { InstallerError } from "../src/errors.js";
import { DeploymentReceipts } from "../src/install.js";
import {
  RepairPlatform,
  repairDeployment,
  renderRepairPlan,
  type OwnershipProbe,
  type RepairInput,
} from "../src/repair.js";
import {
  createDeploymentReceipt,
  type DeploymentReceipt,
  type OperationLease,
} from "../src/receipts/schema.js";
import { makeReceiptStore, type ReceiptBackend } from "../src/receipts/store.js";

const createdAt = DateTime.makeUnsafe("2026-07-20T12:00:00.000Z");
const deploymentId = "01JVQ8B95TQZD1P6DE00DE0001";

const baseInput: RepairInput = { name: "staging", actor: "lori@mbp" };

function fixtureReceipt(overrides?: {
  phase?: DeploymentReceipt["phase"];
  lease?: OperationLease | null;
  applicationId?: string | null;
  history?: DeploymentReceipt["history"];
}): DeploymentReceipt {
  const base = createDeploymentReceipt({
    id: deploymentId,
    name: "staging",
    version: "0.3.0",
    now: createdAt,
    cloudflare: {
      accountId: "account-1",
      workerName: "staging",
      applicationId: null,
      applicationName: "staging-runner",
      durableObjectClasses: ["Scheduler", "RunnerContainer"],
      registryRepo: "staging-runner",
      tags: { current: "0.3.0", previous: null },
    },
    github: {
      appId: 12345,
      appSlug: "staging-x7k2",
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
  return {
    ...base,
    phase: overrides?.phase ?? "active",
    lease: overrides?.lease ?? null,
    history: overrides?.history ?? base.history,
    cloudflare: {
      ...base.cloudflare,
      applicationId:
        overrides?.applicationId === undefined ? "application-id" : overrides.applicationId,
    },
  };
}

const snapshot: AccountSnapshot = {
  workers: [
    { name: "staging", jitneyTagged: true, deploymentId },
    { name: "unrelated", jitneyTagged: false, deploymentId: null },
  ],
  applications: [
    { id: "application-id", name: "staging-runner", imageTag: "0.3.0" },
    { id: "a034dae7", name: "staging-runner-old", imageTag: "0.1.0" },
  ],
};

const ownershipOk: OwnershipProbe[] = [{ fullName: "LoriKarikari/api", class: "ok" }];

function fakePlatform(overrides?: {
  snapshot?: AccountSnapshot;
  ownership?: readonly OwnershipProbe[];
  confirm?: boolean;
  rewrites?: Ref.Ref<string[]>;
}) {
  return RepairPlatform.of({
    snapshot: () => Effect.succeed(overrides?.snapshot ?? snapshot),
    ownership: () => Effect.succeed(overrides?.ownership ?? ownershipOk),
    rewriteOwnership: (_receipt, fullNames) =>
      overrides?.rewrites === undefined
        ? Effect.void
        : Ref.update(overrides.rewrites, (current) => [...current, ...fullNames]),
    confirm: () => Effect.succeed(overrides?.confirm ?? true),
  });
}

async function makeMemoryBackend(
  receipts: readonly DeploymentReceipt[],
): Promise<{ service: ReceiptBackend; read: (name: string) => Promise<DeploymentReceipt> }> {
  const data = await Effect.runPromise(
    Ref.make(
      new Map(
        receipts.map((receipt) => [receipt.name, JSON.parse(JSON.stringify(receipt))]),
      ) as Map<string, unknown>,
    ),
  );
  const service: ReceiptBackend = {
    get: (name) =>
      Effect.map(Ref.get(data), (values) => {
        const value = values.get(name) as DeploymentReceipt | undefined;
        return value === undefined ? undefined : JSON.stringify(value);
      }),
    put: (name, value) =>
      Ref.update(data, (values) => new Map(values).set(name, JSON.parse(value))).pipe(
        Effect.asVoid,
      ),
    remove: (name) =>
      Ref.update(data, (values) => {
        const next = new Map(values);
        next.delete(name);
        return next;
      }).pipe(Effect.asVoid),
    listKeys: () => Effect.map(Ref.get(data), (values) => [...values.keys()]),
    removeNamespace: () => Effect.void,
  };
  return {
    service,
    read: (name) =>
      Effect.runPromise(
        Effect.map(Ref.get(data), (values) => values.get(name) as DeploymentReceipt),
      ),
  };
}

async function runRepair(
  receipt: DeploymentReceipt,
  platform: ReturnType<typeof fakePlatform>,
  input: RepairInput = baseInput,
) {
  const backend = await makeMemoryBackend([receipt]);
  const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });
  const plan = await Effect.runPromise(
    repairDeployment(input).pipe(
      Effect.provideService(DeploymentReceipts, store),
      Effect.provideService(RepairPlatform, platform),
    ),
  );
  return { plan, backend };
}

describe("repair", () => {
  it("releases an expired lease without touching anything else", async () => {
    const lease: OperationLease = {
      operation: "install",
      actor: "lori@laptop",
      expiresAt: createdAt,
    };
    const receipt = fixtureReceipt({
      lease,
      history: [
        {
          operation: "install",
          actor: "lori@laptop",
          startedAt: createdAt,
          completedAt: null,
          outcome: null,
        },
      ],
    });
    const { plan, backend } = await runRepair(receipt, fakePlatform());

    expect(plan.actions).toEqual([
      { kind: "release_expired_lease", operation: "install", actor: "lori@laptop" },
    ]);
    const stored = await backend.read("staging");
    expect(stored.lease).toBeNull();
    expect(stored.history.find((entry) => entry.operation === "install")).toMatchObject({
      outcome: "interrupted",
    });
    expect(stored.history.at(-1)).toMatchObject({ operation: "repair", outcome: "succeeded" });
  });

  it("refuses to repair under a live lease", async () => {
    const lease: OperationLease = {
      operation: "upgrade",
      actor: "lori@laptop",
      expiresAt: DateTime.addDuration(createdAt, "1 day"),
    };
    const backend = await makeMemoryBackend([fixtureReceipt({ lease })]);
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });

    const error = await Effect.runPromise(
      repairDeployment(baseInput).pipe(
        Effect.provideService(DeploymentReceipts, store),
        Effect.provideService(RepairPlatform, fakePlatform()),
        Effect.flip,
      ),
    );

    expect(error).toMatchObject({ step: "repair" });
    expect(String(error.message)).toContain("live upgrade lease");
  });

  it("frees the dead lease and redirects an interrupted install to deploy", async () => {
    const lease: OperationLease = {
      operation: "install",
      actor: "lori@laptop",
      expiresAt: createdAt,
    };
    const receipt = fixtureReceipt({ phase: "installing", lease, applicationId: null });
    const { plan, backend } = await runRepair(receipt, fakePlatform());

    expect(plan.redirect).toBe("deploy");
    expect(plan.actions).toHaveLength(1);
    const stored = await backend.read("staging");
    expect(stored.lease).toBeNull();
    expect(stored.phase).toBe("installing");
    expect(stored.cloudflare.applicationId).toBeNull();
  });

  it("re-derives a lost application id proven by the worker's deployment tag", async () => {
    const receipt = fixtureReceipt({ applicationId: null });
    const { plan, backend } = await runRepair(receipt, fakePlatform());

    expect(plan.actions).toContainEqual({
      kind: "record_application",
      applicationId: "application-id",
      proof: "worker_tag",
    });
    const stored = await backend.read("staging");
    expect(stored.cloudflare.applicationId).toBe("application-id");
    expect(stored.lease).toBeNull();
    expect(stored.history.at(-1)).toMatchObject({ operation: "repair", outcome: "succeeded" });
  });

  it("blocks an unprovable application and points at explicit adoption", async () => {
    const noTagSnapshot: AccountSnapshot = {
      ...snapshot,
      workers: [{ name: "staging", jitneyTagged: true, deploymentId: null }],
    };
    const receipt = fixtureReceipt({ applicationId: null });
    const { plan, backend } = await runRepair(receipt, fakePlatform({ snapshot: noTagSnapshot }));

    expect(plan.actions).toEqual([]);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toMatchObject({
      command: "npx get-jitney repair staging --adopt application:application-id",
    });
    const stored = await backend.read("staging");
    expect(stored.cloudflare.applicationId).toBeNull();
  });

  it("adopts an unprovable application only when named explicitly", async () => {
    const noTagSnapshot: AccountSnapshot = {
      ...snapshot,
      workers: [{ name: "staging", jitneyTagged: true, deploymentId: null }],
    };
    const receipt = fixtureReceipt({ applicationId: null });
    const { plan, backend } = await runRepair(receipt, fakePlatform({ snapshot: noTagSnapshot }), {
      ...baseInput,
      adopt: ["application:application-id"],
    });

    expect(plan.actions).toContainEqual({
      kind: "record_application",
      applicationId: "application-id",
      proof: "explicit_adopt",
    });
    expect((await backend.read("staging")).cloudflare.applicationId).toBe("application-id");
  });

  it("refuses to adopt an application Cloudflare does not report", async () => {
    const backend = await makeMemoryBackend([fixtureReceipt({ applicationId: null })]);
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });

    const error = await Effect.runPromise(
      repairDeployment({ ...baseInput, adopt: ["application:ghost"] }).pipe(
        Effect.provideService(DeploymentReceipts, store),
        Effect.provideService(RepairPlatform, fakePlatform()),
        Effect.flip,
      ),
    );

    expect(String(error.message)).toContain("ghost");
  });

  it("rewrites missing ownership markers but never foreign ones", async () => {
    const rewrites = await Effect.runPromise(Ref.make<string[]>([]));
    const ownership: OwnershipProbe[] = [
      { fullName: "LoriKarikari/api", class: "missing" },
      { fullName: "LoriKarikari/web", class: "drifted", value: "01JVQ8B95TQZD1P6AAAABBBBCC" },
    ];
    const { plan } = await runRepair(fixtureReceipt(), fakePlatform({ ownership, rewrites }));

    expect(plan.actions).toContainEqual({
      kind: "rewrite_ownership",
      fullName: "LoriKarikari/api",
    });
    expect(plan.blockers).toHaveLength(1);
    expect(String(plan.blockers[0]!.reason)).toContain("foreign ownership");
    expect(await Effect.runPromise(Ref.get(rewrites))).toEqual(["LoriKarikari/api"]);
  });

  it("changes nothing when the plan is declined", async () => {
    const rewrites = await Effect.runPromise(Ref.make<string[]>([]));
    const ownership: OwnershipProbe[] = [{ fullName: "LoriKarikari/api", class: "missing" }];
    const { plan, backend } = await runRepair(
      fixtureReceipt(),
      fakePlatform({ ownership, rewrites, confirm: false }),
    );

    expect(plan.actions).toHaveLength(1);
    expect(await Effect.runPromise(Ref.get(rewrites))).toEqual([]);
    expect((await backend.read("staging")).lease).toBeNull();
  });

  it("points a missing Worker at deploy without recreating it", async () => {
    const noWorkerSnapshot: AccountSnapshot = {
      ...snapshot,
      workers: [{ name: "unrelated", jitneyTagged: false, deploymentId: null }],
    };
    const { plan } = await runRepair(
      fixtureReceipt(),
      fakePlatform({ snapshot: noWorkerSnapshot }),
    );

    expect(plan.actions).toEqual([]);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        command: "npx get-jitney deploy --name staging",
      }),
    );
  });

  it("treats an unreachable GitHub probe as a blocker, never a guess", async () => {
    const failing = RepairPlatform.of({
      snapshot: () => Effect.succeed(snapshot),
      ownership: () =>
        Effect.fail(new InstallerError({ step: "repair", message: "Worker is unavailable" })),
      rewriteOwnership: () => Effect.void,
      confirm: () => Effect.succeed(true),
    });
    const { plan } = await runRepair(fixtureReceipt(), failing);

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        reason: expect.stringContaining("unreachable"),
        command: "npx get-jitney list",
      }),
    );
  });

  it("renders the plan with actions, blockers, and fix commands", () => {
    const output = renderRepairPlan({
      name: "staging",
      deploymentId,
      phase: "active",
      redirect: null,
      actions: [
        { kind: "release_expired_lease", operation: "upgrade", actor: "lori@mbp" },
        { kind: "rewrite_ownership", fullName: "LoriKarikari/api" },
      ],
      blockers: [
        {
          reason: "container application staging-runner-old carries no id proof",
          command: "npx get-jitney repair staging --adopt application:a034dae7",
        },
      ],
    });

    expect(output).toContain("WILL DO");
    expect(output).toContain("release expired lease (upgrade, lori@mbp)");
    expect(output).toContain("rewrite JITNEY_DEPLOYMENT on LoriKarikari/api (missing)");
    expect(output).toContain("WON'T TOUCH (needs you)");
    expect(output).toContain("--adopt application:a034dae7");
  });
});
