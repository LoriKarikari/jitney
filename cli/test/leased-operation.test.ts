import { DateTime, Duration, Effect, Fiber, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { InstallerError } from "../src/errors.js";
import { beginInstallOperation, beginLeasedOperation } from "../src/receipts/leased-operation.js";
import { createDeploymentReceipt, type DeploymentReceipt } from "../src/receipts/schema.js";
import { makeReceiptStore, type ReceiptBackend } from "../src/receipts/store.js";

const startedAt = DateTime.makeUnsafe("2026-07-20T12:00:00.000Z");

function fixtureReceipt(): DeploymentReceipt {
  return createDeploymentReceipt({
    id: "01J00000000000000000000000",
    name: "staging",
    version: "0.3.0",
    now: startedAt,
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
      appId: null,
      appSlug: null,
      ownerLogin: null,
      ownerType: "User",
      installations: [],
    },
    autoUpgrade: { enabled: false, channel: "patch" },
  });
}

async function makeMemoryBackend(): Promise<{
  service: ReceiptBackend;
  currentLeaseExpiry: () => Promise<string | undefined>;
  clearLease: () => Promise<void>;
}> {
  const data = await Effect.runPromise(Ref.make(new Map<string, string>()));
  const service: ReceiptBackend = {
    get: (name) => Effect.map(Ref.get(data), (values) => values.get(name)),
    put: (name, value) =>
      Ref.update(data, (values) => new Map(values).set(name, value)).pipe(Effect.asVoid),
    remove: (name) =>
      Ref.update(data, (values) => {
        const next = new Map(values);
        next.delete(name);
        return next;
      }).pipe(Effect.asVoid),
    listKeys: () => Effect.map(Ref.get(data), (values) => [...values.keys()]),
    removeNamespace: () => Effect.void,
  };
  const read = () =>
    Effect.runPromise(
      Effect.map(Ref.get(data), (values) => {
        const value = values.get("staging");
        return value === undefined
          ? undefined
          : (JSON.parse(value) as { lease: { expiresAt: string } | null });
      }),
    );
  return {
    service,
    currentLeaseExpiry: async () => (await read())?.lease?.expiresAt,
    clearLease: () =>
      Effect.runPromise(
        Ref.update(data, (values) => {
          const value = values.get("staging");
          if (value === undefined) return values;
          const parsed = JSON.parse(value) as Record<string, unknown>;
          return new Map(values).set("staging", JSON.stringify({ ...parsed, lease: null }));
        }),
      ).then(() => undefined),
  };
}

describe("leased operation", () => {
  it("renews the lease on a schedule while a guarded step runs", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });

    const expiry = await Effect.runPromise(
      Effect.gen(function* () {
        const held = yield* beginInstallOperation(
          store,
          fixtureReceipt(),
          "lori@mbp",
          yield* DateTime.now,
        );
        const fiber = yield* held.guard(Effect.sleep("21 minutes")).pipe(Effect.forkChild);
        yield* TestClock.adjust("21 minutes");
        yield* Fiber.join(fiber);
        return (yield* held.receipt()).lease.expiresAt;
      }).pipe(Effect.provide(TestClock.layer())),
    );

    // The TestClock starts at the epoch. Renewals ran at entry and at the
    // 5/10/15/20-minute heartbeats; the lease now expires 15 minutes after the
    // last heartbeat, well past the guarded step's 21-minute end.
    expect(DateTime.formatIso(expiry)).toBe("1970-01-01T00:35:00.000Z");
    expect(await backend.currentLeaseExpiry()).toBe("1970-01-01T00:35:00.000Z");
  });

  it("fails a record once the stored lease has been lost", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const held = yield* beginInstallOperation(
          store,
          fixtureReceipt(),
          "lori@mbp",
          yield* DateTime.now,
        );
        yield* Effect.promise(() => backend.clearLease());
        return yield* held
          .record((current) => ({ cloudflare: current.cloudflare }))
          .pipe(Effect.flip);
      }),
    );

    expect(error).toBeInstanceOf(InstallerError);
    expect(error).toMatchObject({ step: "receipt_store" });
  });

  it("acquires, records, and settles an operation on an existing receipt", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });

    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        const held = yield* beginLeasedOperation(store, "staging", "repair", "lori@mbp");
        yield* held.record((current) => ({
          versions: { ...current.versions, previous: "0.2.0" },
        }));
        return yield* held.finish({ phase: "active", outcome: "succeeded" });
      }),
    );

    expect(receipt).toMatchObject({
      phase: "active",
      lease: null,
      versions: { current: "0.3.0", previous: "0.2.0" },
    });
    expect(receipt.history.at(-1)).toMatchObject({ operation: "repair", outcome: "succeeded" });
  });

  it("keeps the settled receipt readable through get", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });

    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const held = yield* beginInstallOperation(
          store,
          fixtureReceipt(),
          "lori@mbp",
          yield* DateTime.now,
        );
        yield* held.finish({ phase: "active", outcome: "succeeded" });
        return yield* store.get("staging");
      }),
    );

    expect(Option.getOrThrow(stored)).toMatchObject({ phase: "active", lease: null });
  });
});
