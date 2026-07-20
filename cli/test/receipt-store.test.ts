import { DateTime, Duration, Effect, Option, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
  createDeploymentReceipt,
  generateDeploymentId,
  type DeploymentReceipt,
} from "../src/receipts/schema.js";
import {
  LeaseExpiredError,
  LeaseHeldError,
  LeaseOwnershipError,
  LeaseRaceError,
  ReceiptAlreadyExistsError,
  ReceiptCreationRaceError,
  makeReceiptStore,
  type ReceiptBackend,
} from "../src/receipts/store.js";

describe("deployment receipt store", () => {
  it("mints a ULID deployment identity", async () => {
    const id = await Effect.runPromise(generateDeploymentId);

    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("creates and reads a schema-v1 receipt", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const receipt = fixtureReceipt();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create(receipt);
        return yield* store.get(receipt.name);
      }),
    );

    expect(Option.getOrThrow(result)).toEqual(receipt);
    expect(await backend.values()).toEqual([
      ["staging", expect.stringContaining('"schemaVersion":1')],
    ]);
  });

  it("creates an installing receipt with its lease in one write", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const now = DateTime.makeUnsafe("2026-07-20T13:00:00.000Z");

    const created = await Effect.runPromise(
      store.createWithInstallLease(fixtureReceipt(), "lori@mbp", now),
    );

    expect(created).toMatchObject({
      phase: "installing",
      lease: { operation: "install", actor: "lori@mbp" },
      history: [
        {
          operation: "install",
          actor: "lori@mbp",
          completedAt: null,
          outcome: null,
        },
      ],
    });
    expect(await backend.putCount()).toBe(1);
  });

  it("does not persist fields outside the receipt schema", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const receipt = {
      ...fixtureReceipt(),
      github: { ...fixtureReceipt().github, privateKey: "must-not-be-stored" },
    } as DeploymentReceipt;

    await Effect.runPromise(store.create(receipt));

    expect(JSON.stringify(await backend.values())).not.toContain("must-not-be-stored");
    expect(JSON.stringify(await backend.values())).not.toContain("privateKey");
  });

  it("refuses to replace a deployment with the same name", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const receipt = fixtureReceipt();

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create(receipt);
        return yield* store.create({ ...receipt, id: "01J00000000000000000000001" });
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(ReceiptAlreadyExistsError);
    expect(error).toMatchObject({ name: "staging", existingId: receipt.id });
  });

  it("detects another installer winning the receipt creation race", async () => {
    const backend = await makeMemoryBackend({
      afterPut: (name, value, values) => {
        const parsed = JSON.parse(value) as { id: string };
        if (parsed.id === "01J00000000000000000000000") {
          values.set(
            name,
            value.replace("01J00000000000000000000000", "01J00000000000000000000001"),
          );
        }
      },
    });
    const store = makeReceiptStore(backend.service);

    const error = await Effect.runPromise(store.create(fixtureReceipt()).pipe(Effect.flip));

    expect(error).toBeInstanceOf(ReceiptCreationRaceError);
    expect(error).toMatchObject({
      name: "staging",
      attemptedId: "01J00000000000000000000000",
      observedId: "01J00000000000000000000001",
    });
  });

  it("acquires a 15-minute lease and moves the receipt into the operation phase", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const now = DateTime.makeUnsafe("2026-07-20T13:00:00.000Z");

    const acquired = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        return yield* store.acquireLease("staging", "upgrade", "lori@mbp", now);
      }),
    );

    expect(acquired.phase).toBe("upgrading");
    expect(acquired.lease).toMatchObject({ operation: "upgrade", actor: "lori@mbp" });
    expect(DateTime.toEpochMillis(acquired.lease!.expiresAt)).toBe(
      DateTime.toEpochMillis(now) + 15 * 60 * 1_000,
    );
    expect(acquired.history).toEqual([
      {
        operation: "upgrade",
        actor: "lori@mbp",
        startedAt: now,
        completedAt: null,
        outcome: null,
      },
    ]);
  });

  it.each([
    ["live", "2026-07-20T13:10:00.000Z", false],
    ["expired", "2026-07-20T13:20:00.000Z", true],
  ])("refuses acquisition while a %s lease remains recorded", async (_, at, expired) => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const acquiredAt = DateTime.makeUnsafe("2026-07-20T13:00:00.000Z");

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        yield* store.acquireLease("staging", "upgrade", "lori@mbp", acquiredAt);
        return yield* store.acquireLease(
          "staging",
          "destroy",
          "other@host",
          DateTime.makeUnsafe(at),
        );
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LeaseHeldError);
    expect(error).toMatchObject({ name: "staging", expired });
  });

  it("renews the lease from the time of renewal", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const acquiredAt = DateTime.makeUnsafe("2026-07-20T13:00:00.000Z");
    const renewedAt = DateTime.makeUnsafe("2026-07-20T13:05:00.000Z");

    const renewed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        const acquired = yield* store.acquireLease("staging", "upgrade", "lori@mbp", acquiredAt);
        return yield* store.renewLease({ name: "staging", lease: acquired.lease!, now: renewedAt });
      }),
    );

    expect(DateTime.toEpochMillis(renewed.lease!.expiresAt)).toBe(
      DateTime.toEpochMillis(renewedAt) + 15 * 60 * 1_000,
    );
    expect(renewed.history).toHaveLength(1);
  });

  it("records resources while keeping the operation lease", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const updatedAt = DateTime.makeUnsafe("2026-07-20T13:01:00.000Z");

    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create(fixtureReceipt());
        const acquired = yield* store.acquireLease(
          "staging",
          "install",
          "lori@mbp",
          DateTime.makeUnsafe("2026-07-20T13:00:00.000Z"),
        );
        return yield* store.updateOperation(
          { name: "staging", lease: acquired.lease!, now: updatedAt },
          {
            cloudflare: {
              ...acquired.cloudflare,
              applicationId: "application-id",
            },
          },
        );
      }),
    );

    expect(updated.cloudflare.applicationId).toBe("application-id");
    expect(updated.lease).not.toBeNull();
    expect(updated.updatedAt).toEqual(updatedAt);
    expect(updated.history).toHaveLength(1);
  });

  it("does not revive a lease after its expiry", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        const acquired = yield* store.acquireLease(
          "staging",
          "upgrade",
          "lori@mbp",
          DateTime.makeUnsafe("2026-07-20T13:00:00.000Z"),
        );
        return yield* store.renewLease({
          name: "staging",
          lease: acquired.lease!,
          now: DateTime.makeUnsafe("2026-07-20T13:20:00.000Z"),
        });
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LeaseExpiredError);
  });

  it("finishes an operation by updating state and clearing its lease in one receipt write", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const finishedAt = DateTime.makeUnsafe("2026-07-20T13:06:00.000Z");

    const finished = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        const acquired = yield* store.acquireLease(
          "staging",
          "upgrade",
          "lori@mbp",
          DateTime.makeUnsafe("2026-07-20T13:00:00.000Z"),
        );
        return yield* store.finishOperation(
          { name: "staging", lease: acquired.lease!, now: finishedAt },
          {
            phase: "active",
            outcome: "succeeded",
            versions: { current: "0.4.0", previous: "0.3.0" },
          },
        );
      }),
    );

    expect(finished).toMatchObject({
      phase: "active",
      lease: null,
      versions: { current: "0.4.0", previous: "0.3.0" },
    });
    expect(finished.history.at(-1)).toMatchObject({
      completedAt: finishedAt,
      outcome: "succeeded",
    });
  });

  it("rejects renewal by a caller that does not own the recorded lease", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        const acquired = yield* store.acquireLease(
          "staging",
          "upgrade",
          "lori@mbp",
          DateTime.makeUnsafe("2026-07-20T13:00:00.000Z"),
        );
        return yield* store.renewLease({
          name: "staging",
          lease: { ...acquired.lease!, actor: "other@host" },
          now: DateTime.makeUnsafe("2026-07-20T13:05:00.000Z"),
        });
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LeaseOwnershipError);
  });

  it("lets repair release an expired lease but not a live one", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service);
    const acquiredAt = DateTime.makeUnsafe("2026-07-20T13:00:00.000Z");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        const acquired = yield* store.acquireLease("staging", "upgrade", "lori@mbp", acquiredAt);
        const liveError = yield* store
          .releaseExpiredLeaseForRepair(
            "staging",
            "repairer@host",
            DateTime.makeUnsafe("2026-07-20T13:10:00.000Z"),
          )
          .pipe(Effect.flip);
        const released = yield* store.releaseExpiredLeaseForRepair(
          "staging",
          "repairer@host",
          DateTime.makeUnsafe("2026-07-20T13:20:00.000Z"),
        );
        return { acquired, liveError, released };
      }),
    );

    expect(result.liveError).toBeInstanceOf(LeaseHeldError);
    expect(result.released.lease).toBeNull();
    expect(result.released.history.at(-2)).toMatchObject({ outcome: "interrupted" });
    expect(result.released.history.at(-1)).toMatchObject({
      operation: "repair",
      actor: "repairer@host",
      outcome: "succeeded",
    });
  });

  it("deletes the shared namespace only after its final receipt", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service, {
      namespaceRemovalDelay: Duration.zero,
    });
    const other = {
      ...fixtureReceipt(),
      id: "01J00000000000000000000001",
      name: "production",
    } as DeploymentReceipt;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create(fixtureReceipt());
        yield* store.create(other);
        const now = DateTime.makeUnsafe("2026-07-20T13:00:00.000Z");
        const staging = yield* store.acquireLease("staging", "destroy", "lori@mbp", now);
        const production = yield* store.acquireLease("production", "destroy", "lori@mbp", now);
        const deleteAt = DateTime.makeUnsafe("2026-07-20T13:01:00.000Z");
        const first = yield* store.deleteReceipt(
          { name: "staging", lease: staging.lease!, now: deleteAt },
          fixtureReceipt().id,
        );
        const second = yield* store.deleteReceipt(
          { name: "production", lease: production.lease!, now: deleteAt },
          other.id,
        );
        return { first, second };
      }),
    );

    expect(result.first.namespaceRemoved).toBe(false);
    expect(result.second.namespaceRemoved).toBe(true);
    expect(await backend.namespaceRemovals()).toBe(1);
  });

  it("keeps the namespace when another receipt appears before the confirmation list", async () => {
    const backend = await makeMemoryBackend({
      afterListKeys: (callCount, values) => {
        if (callCount === 1) values.set("racing", "{}");
      },
    });
    const store = makeReceiptStore(backend.service, {
      namespaceRemovalDelay: Duration.zero,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create(fixtureReceipt());
        const held = yield* store.acquireLease(
          "staging",
          "destroy",
          "lori@mbp",
          DateTime.makeUnsafe("2026-07-20T13:00:00.000Z"),
        );
        return yield* store.deleteReceipt(
          {
            name: "staging",
            lease: held.lease!,
            now: DateTime.makeUnsafe("2026-07-20T13:01:00.000Z"),
          },
          fixtureReceipt().id,
        );
      }),
    );

    expect(result.namespaceRemoved).toBe(false);
    expect(await backend.namespaceRemovals()).toBe(0);
  });

  it("detects another writer winning the KV lease race", async () => {
    const backend = await makeMemoryBackend({
      afterPut: (name, value, values) => {
        const parsed = JSON.parse(value) as { lease: null | { actor: string } };
        if (parsed.lease?.actor === "lori@mbp") {
          values.set(name, value.replace("lori@mbp", "other@host"));
        }
      },
    });
    const store = makeReceiptStore(backend.service);

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.create({ ...fixtureReceipt(), phase: "active" });
        return yield* store.acquireLease(
          "staging",
          "upgrade",
          "lori@mbp",
          DateTime.makeUnsafe("2026-07-20T13:00:00.000Z"),
        );
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LeaseRaceError);
    expect(error).toMatchObject({
      name: "staging",
      attempted: { operation: "upgrade", actor: "lori@mbp" },
      observed: { operation: "upgrade", actor: "other@host" },
    });
  });
});

function fixtureReceipt(): DeploymentReceipt {
  return createDeploymentReceipt({
    id: "01J00000000000000000000000",
    name: "staging",
    version: "0.3.0",
    now: DateTime.makeUnsafe("2026-07-20T12:00:00.000Z"),
    cloudflare: {
      accountId: "account-1",
      workerName: "staging",
      applicationId: null,
      applicationName: "staging-runner",
      durableObjectClasses: ["Scheduler", "RunnerContainer"],
      registryRepo: "staging",
      tags: { current: "0.3.0", previous: null },
    },
    github: {
      appId: null,
      appSlug: null,
      ownerLogin: "LoriKarikari",
      ownerType: "User",
      installations: [],
    },
    autoUpgrade: { enabled: false, channel: "patch" },
  });
}

async function makeMemoryBackend(options?: {
  afterPut?: (name: string, value: string, values: Map<string, string>) => void;
  afterListKeys?: (callCount: number, values: Map<string, string>) => void;
}) {
  const data = await Effect.runPromise(Ref.make(new Map<string, string>()));
  const removals = await Effect.runPromise(Ref.make(0));
  const puts = await Effect.runPromise(Ref.make(0));
  const listCalls = await Effect.runPromise(Ref.make(0));
  const service: ReceiptBackend = {
    get: (name) => Effect.map(Ref.get(data), (values) => values.get(name)),
    put: (name, value) =>
      Ref.update(puts, (count) => count + 1).pipe(
        Effect.andThen(
          Ref.update(data, (values) => {
            const next = new Map(values).set(name, value);
            options?.afterPut?.(name, value, next);
            return next;
          }),
        ),
      ),
    remove: (name) =>
      Ref.update(data, (values) => {
        const next = new Map(values);
        next.delete(name);
        return next;
      }),
    listKeys: () =>
      Effect.gen(function* () {
        const callCount = yield* Ref.updateAndGet(listCalls, (count) => count + 1);
        const values = yield* Ref.get(data);
        options?.afterListKeys?.(callCount, values);
        return [...values.keys()];
      }),
    removeNamespace: () => Ref.update(removals, (count) => count + 1),
  };
  return {
    service,
    values: () => Effect.runPromise(Effect.map(Ref.get(data), (values) => [...values])),
    putCount: () => Effect.runPromise(Ref.get(puts)),
    namespaceRemovals: () => Effect.runPromise(Ref.get(removals)),
  };
}
