// Failure modes this file guards. The live checks in e2e/ cannot reach them cheaply.
// 1. Adopt records a receipt that misses a resource, or rewrites markers that already exist.
// 2. A Worker whose receipt was lost gets a new ULID, orphaning its markers.
// 3. Adopt takes a resource, Worker, or name another receipt owns.
// 4. A failed step loses the Deployment or its installing receipt.
// 5. Adopt claims a repository another Deployment's marker owns.
// 6. Adopt finishes while a recorded repository's marker is unaccounted for.
// 7. A resumed adoption mints a second ULID.
import { Cause, DateTime, Duration, Effect, Exit, Option, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
  AdoptPlatform,
  adoptDeployment,
  type AdoptInput,
  type AdoptionCandidate,
} from "../src/adopt.js";
import { InstallerError, isInstallFailure, renderFailure } from "../src/errors.js";
import { DeploymentReceipts } from "../src/install.js";
import { createDeploymentReceipt, type DeploymentReceipt } from "../src/receipts/schema.js";
import { makeReceiptStore, type ReceiptBackend } from "../src/receipts/store.js";

const input: AdoptInput = {
  name: "jitney",
  accountId: "account-id",
  version: "0.4.0",
  actor: "lori@mbp",
};

const app = {
  appId: 3000,
  appSlug: "jitney-jitney-f7c3",
  ownerLogin: "LoriKarikari",
  ownerType: "User" as const,
};

const spike: AdoptionCandidate = {
  worker: {
    durableObjectClasses: ["Scheduler", "RunnerContainer"],
    secretNames: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"],
    deploymentId: null,
  },
  application: { id: "a03a65c5" },
};

const installations = [
  {
    id: 42,
    accountLogin: "LoriKarikari",
    accountType: "User" as const,
    repositories: [
      { id: 100, name: "jitney-test", fullName: "LoriKarikari/jitney-test" },
      { id: 101, name: "api", fullName: "LoriKarikari/api" },
    ],
  },
];

type Overrides = Partial<AdoptPlatform["Service"]> & { candidate?: AdoptionCandidate };

async function harness(overrides: Overrides = {}, seed: readonly DeploymentReceipt[] = []) {
  const data = await Effect.runPromise(Ref.make(new Map<string, string>()));
  const backend: ReceiptBackend = {
    get: (name) => Effect.map(Ref.get(data), (values) => values.get(name)),
    put: (name, value) => Ref.update(data, (values) => new Map(values).set(name, value)),
    remove: (name) =>
      Ref.update(data, (values) => {
        const next = new Map(values);
        next.delete(name);
        return next;
      }),
    listKeys: () => Effect.map(Ref.get(data), (values) => [...values.keys()]),
    removeNamespace: () => Effect.void,
  };
  const store = makeReceiptStore(backend, { namespaceRemovalDelay: Duration.zero });
  for (const receipt of seed) await Effect.runPromise(store.create(receipt));
  const events = await Effect.runPromise(Ref.make<string[]>([]));
  const record = (event: string) => Ref.update(events, (current) => [...current, event]);
  const platform = AdoptPlatform.of({
    inspect: () => record("inspect").pipe(Effect.as(overrides.candidate ?? spike)),
    deploy: () =>
      record("deploy").pipe(
        Effect.as({
          applicationId: "a03a65c5",
          registryTag: "0.4.0",
        }),
      ),
    inventory: () => record("inventory").pipe(Effect.as({ app, installations })),
    ownership: () =>
      record("ownership").pipe(
        Effect.as([
          { fullName: "LoriKarikari/jitney-test", status: "missing" as const },
          { fullName: "LoriKarikari/api", status: "ok" as const },
        ]),
      ),
    writeOwnership: (_receipt, fullNames) => record(`write-ownership:${fullNames.join(",")}`),
    ...overrides,
  });
  const run = () =>
    Effect.runPromiseExit(
      adoptDeployment(input).pipe(
        Effect.provideService(DeploymentReceipts, store),
        Effect.provideService(AdoptPlatform, platform),
      ),
    );
  return {
    run,
    store,
    events: () => Effect.runPromise(Ref.get(events)),
    stored: () => Effect.runPromise(store.get(input.name)).then(Option.getOrUndefined),
  };
}

function receiptFor(
  overrides: { name: string; id: string; applicationId: string },
  phase: DeploymentReceipt["phase"] = "active",
): DeploymentReceipt {
  const base = createDeploymentReceipt({
    id: overrides.id,
    name: overrides.name,
    version: "0.3.0",
    now: DateTime.makeUnsafe("2026-09-29T12:00:00.000Z"),
    cloudflare: {
      accountId: "account-id",
      workerName: overrides.name,
      applicationId: overrides.applicationId,
      applicationName: `${overrides.name}-runner`,
      durableObjectClasses: ["Scheduler", "RunnerContainer"],
      registryRepo: `${overrides.name}-runner`,
      tags: { current: "0.3.0", previous: null },
    },
    github: { appId: null, appSlug: null, ownerLogin: null, ownerType: "User", installations: [] },
    autoUpgrade: { enabled: false, channel: "patch" },
  });
  return { ...base, phase };
}

function failureMessage(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) throw new Error("expected adoption to fail");
  const failure = Cause.squash(exit.cause);
  return isInstallFailure(failure) ? renderFailure(failure) : String(failure);
}

describe("adopt", () => {
  it("records a receipt for the existing resources and claims only missing markers", async () => {
    const adoption = await harness();

    const exit = await adoption.run();

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(await adoption.events()).toEqual([
      "inspect",
      "deploy",
      "inventory",
      "ownership",
      "write-ownership:LoriKarikari/jitney-test",
    ]);
    expect(await adoption.stored()).toMatchObject({
      name: "jitney",
      phase: "active",
      lease: null,
      cloudflare: {
        workerName: "jitney",
        applicationId: "a03a65c5",
        applicationName: "jitney-runner",
        registryRepo: "jitney-runner",
        tags: { current: "0.4.0", previous: null },
      },
      github: { ...app, installations },
    });
  });

  it("reuses the deployment ULID of a Worker whose receipt was lost", async () => {
    const lost = "01JVQ8B95TQZD1P6DE00DE0009";
    const adoption = await harness({
      candidate: { ...spike, worker: { ...spike.worker!, deploymentId: lost } },
    });

    await adoption.run();

    expect((await adoption.stored())?.id).toBe(lost);
  });

  it.each([
    ["there is no Worker to adopt", { ...spike, worker: null }, "No Worker named jitney"],
    [
      "the Worker lacks the Scheduler",
      { ...spike, worker: { ...spike.worker!, durableObjectClasses: ["RunnerContainer"] } },
      "Scheduler",
    ],
    [
      "the Worker lacks the GitHub App key",
      {
        ...spike,
        worker: { ...spike.worker!, secretNames: ["GITHUB_APP_ID", "GITHUB_WEBHOOK_SECRET"] },
      },
      "GITHUB_APP_PRIVATE_KEY",
    ],
    ["there is no runner application", { ...spike, application: null }, "jitney-runner"],
  ])("refuses before writing a receipt when %s", async (_case, candidate, message) => {
    const adoption = await harness({ candidate });

    const exit = await adoption.run();

    expect(failureMessage(exit)).toContain(message);
    expect(await adoption.stored()).toBeUndefined();
    expect(await adoption.events()).not.toContain("deploy");
  });

  it("refuses resources that another receipt records", async () => {
    const other = receiptFor({
      name: "staging",
      id: "01JVQ8B95TQZD1P6DE00DE0002",
      applicationId: "a03a65c5",
    });
    const adoption = await harness({}, [other]);

    expect(failureMessage(await adoption.run())).toContain("staging");
    expect(await adoption.stored()).toBeUndefined();
  });

  it("refuses a Worker tagged with a deployment another receipt owns", async () => {
    const owned = "01JVQ8B95TQZD1P6DE00DE0003";
    const other = receiptFor({ name: "staging", id: owned, applicationId: "other-app" });
    const adoption = await harness(
      { candidate: { ...spike, worker: { ...spike.worker!, deploymentId: owned } } },
      [other],
    );

    expect(failureMessage(await adoption.run())).toContain("staging");
    expect(await adoption.stored()).toBeUndefined();
  });

  it("refuses a name that already has an active receipt", async () => {
    const existing = receiptFor({
      name: "jitney",
      id: "01JVQ8B95TQZD1P6DE00DE0004",
      applicationId: "a03a65c5",
    });
    const adoption = await harness({}, [existing]);

    expect(failureMessage(await adoption.run())).toContain("already exists");
    expect(await adoption.events()).toEqual([]);
  });

  it("keeps the Deployment and an installing receipt when a later step fails", async () => {
    const adoption = await harness({
      inventory: () =>
        Effect.fail(new InstallerError({ step: "adopt", message: "GitHub timed out" })),
    });

    expect(failureMessage(await adoption.run())).toContain("GitHub timed out");
    expect(await adoption.stored()).toMatchObject({ phase: "installing", lease: null });
    expect((await adoption.stored())?.history.at(-1)).toMatchObject({ outcome: "failed" });
  });

  it("refuses to claim a repository another Deployment's marker owns", async () => {
    const adoption = await harness({
      ownership: () =>
        Effect.succeed([
          { fullName: "LoriKarikari/jitney-test", status: "missing" as const },
          { fullName: "LoriKarikari/api", status: "drifted" as const },
        ]),
    });

    expect(failureMessage(await adoption.run())).toContain("LoriKarikari/api");
    expect(await adoption.events()).not.toContainEqual(expect.stringMatching(/^write-ownership/));
    expect(await adoption.stored()).toMatchObject({ phase: "installing", lease: null });
  });

  it("does not finish while a recorded repository's marker is unaccounted for", async () => {
    const adoption = await harness({
      ownership: () => Effect.succeed([{ fullName: "LoriKarikari/api", status: "ok" as const }]),
    });

    expect(failureMessage(await adoption.run())).toContain("LoriKarikari/jitney-test");
    expect(await adoption.stored()).toMatchObject({ phase: "installing", lease: null });
  });

  it("resumes a failed adoption with the same ULID", async () => {
    let failInventory = true;
    const adoption = await harness({
      inventory: () =>
        failInventory
          ? Effect.fail(new InstallerError({ step: "adopt", message: "GitHub timed out" }))
          : Effect.succeed({ app, installations }),
    });
    await adoption.run();
    const firstId = (await adoption.stored())?.id;

    failInventory = false;
    const exit = await adoption.run();

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(await adoption.stored()).toMatchObject({ id: firstId, phase: "active" });
  });
});
