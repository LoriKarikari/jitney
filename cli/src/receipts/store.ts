import { Array as Arr, Data, DateTime, Effect, Option, Schema } from "effect";
import {
  DeploymentReceiptSchema,
  type DeploymentOperation,
  type DeploymentPhase,
  type DeploymentReceipt,
  type OperationLease,
} from "./schema.js";

export interface ReceiptBackend {
  readonly get: (name: string) => Effect.Effect<string | undefined, ReceiptBackendError>;
  readonly put: (name: string, value: string) => Effect.Effect<void, ReceiptBackendError>;
  readonly remove: (name: string) => Effect.Effect<void, ReceiptBackendError>;
  readonly listKeys: () => Effect.Effect<readonly string[], ReceiptBackendError>;
  readonly removeNamespace: () => Effect.Effect<void, ReceiptBackendError>;
}

export class ReceiptBackendError extends Data.TaggedError("ReceiptBackendError")<{
  operation: "get" | "put" | "remove" | "list_keys" | "find_namespace" | "remove_namespace";
  cause: unknown;
}> {}

export class InvalidReceiptError extends Data.TaggedError("InvalidReceiptError")<{
  name: string;
  cause: unknown;
}> {}

export class ReceiptNotFoundError extends Data.TaggedError("ReceiptNotFoundError")<{
  name: string;
}> {}

export class ReceiptAlreadyExistsError extends Data.TaggedError("ReceiptAlreadyExistsError")<{
  name: string;
  existingId: string;
}> {}

export class ReceiptCreationRaceError extends Data.TaggedError("ReceiptCreationRaceError")<{
  name: string;
  attemptedId: string;
  observedId: string | null;
}> {}

export class LeaseHeldError extends Data.TaggedError("LeaseHeldError")<{
  name: string;
  lease: OperationLease;
  expired: boolean;
}> {}

export class LeaseRaceError extends Data.TaggedError("LeaseRaceError")<{
  name: string;
  attempted: OperationLease;
  observed: OperationLease | null;
}> {}

export class LeaseOwnershipError extends Data.TaggedError("LeaseOwnershipError")<{
  name: string;
  expected: OperationLease;
  observed: OperationLease | null;
}> {}

export class LeaseExpiredError extends Data.TaggedError("LeaseExpiredError")<{
  name: string;
  lease: OperationLease;
}> {}

export class DeploymentOwnershipError extends Data.TaggedError("DeploymentOwnershipError")<{
  name: string;
  expectedId: string;
  observedId: string;
}> {}

export type ReceiptReadError = ReceiptBackendError | InvalidReceiptError;
export type ReceiptStoreError =
  | ReceiptReadError
  | ReceiptNotFoundError
  | ReceiptAlreadyExistsError
  | ReceiptCreationRaceError
  | LeaseHeldError
  | LeaseRaceError
  | LeaseOwnershipError
  | LeaseExpiredError
  | DeploymentOwnershipError;

export interface OperationCompletion {
  readonly now: DateTime.Utc;
  readonly phase: DeploymentPhase;
  readonly outcome: "succeeded" | "failed";
  readonly versions?: DeploymentReceipt["versions"];
  readonly cloudflare?: DeploymentReceipt["cloudflare"];
  readonly github?: DeploymentReceipt["github"];
  readonly autoUpgrade?: DeploymentReceipt["autoUpgrade"];
}

export interface ReceiptStore {
  readonly get: (name: string) => Effect.Effect<Option.Option<DeploymentReceipt>, ReceiptReadError>;
  readonly create: (receipt: DeploymentReceipt) => Effect.Effect<void, ReceiptStoreError>;
  readonly acquireLease: (
    name: string,
    operation: DeploymentOperation,
    actor: string,
    now: DateTime.Utc,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly renewLease: (
    name: string,
    lease: OperationLease,
    now: DateTime.Utc,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly finishOperation: (
    name: string,
    lease: OperationLease,
    completion: OperationCompletion,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly releaseExpiredLeaseForRepair: (
    name: string,
    actor: string,
    now: DateTime.Utc,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly deleteReceipt: (
    name: string,
    deploymentId: string,
    lease: OperationLease,
    now: DateTime.Utc,
  ) => Effect.Effect<{ readonly namespaceRemoved: boolean }, ReceiptStoreError>;
}

const decodeReceipt = (name: string, value: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(DeploymentReceiptSchema)(JSON.parse(value)),
    catch: (cause) => new InvalidReceiptError({ name, cause }),
  });

const encodeReceipt = (receipt: DeploymentReceipt) =>
  JSON.stringify(Schema.encodeSync(DeploymentReceiptSchema)(receipt));

const phaseForOperation = (operation: DeploymentOperation): DeploymentPhase => {
  switch (operation) {
    case "install":
      return "installing";
    case "upgrade":
    case "rollback":
      return "upgrading";
    case "repair":
      return "repairing";
    case "destroy":
      return "destroying";
  }
};

const leaseMatches = (left: OperationLease, right: OperationLease): boolean =>
  left.operation === right.operation &&
  left.actor === right.actor &&
  DateTime.Equivalence(left.expiresAt, right.expiresAt);

const finishLatestHistory = (
  receipt: DeploymentReceipt,
  lease: OperationLease,
  completedAt: DateTime.Utc,
  outcome: "succeeded" | "failed" | "interrupted",
) =>
  Arr.map(receipt.history, (entry, index) =>
    index === receipt.history.length - 1 &&
    entry.operation === lease.operation &&
    entry.actor === lease.actor &&
    entry.completedAt === null
      ? { ...entry, completedAt, outcome }
      : entry,
  );

const requireLease = (
  name: string,
  expected: OperationLease,
  receipt: DeploymentReceipt,
  now: DateTime.Utc,
): Effect.Effect<void, LeaseOwnershipError | LeaseExpiredError> => {
  if (receipt.lease === null || !leaseMatches(expected, receipt.lease)) {
    return Effect.fail(
      new LeaseOwnershipError({
        name,
        expected,
        observed: receipt.lease,
      }),
    );
  }
  return DateTime.toEpochMillis(receipt.lease.expiresAt) <= DateTime.toEpochMillis(now)
    ? Effect.fail(new LeaseExpiredError({ name, lease: receipt.lease }))
    : Effect.void;
};

export function makeReceiptStore(backend: ReceiptBackend): ReceiptStore {
  const get: ReceiptStore["get"] = (name) =>
    backend
      .get(name)
      .pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.succeed(Option.none<DeploymentReceipt>())
            : Effect.map(decodeReceipt(name, value), Option.some),
        ),
      );

  const getRequired = (name: string) =>
    get(name).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ReceiptNotFoundError({ name })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const putAndConfirmLease = (
    receipt: DeploymentReceipt,
    attempted: OperationLease,
  ): Effect.Effect<DeploymentReceipt, ReceiptStoreError> =>
    Effect.gen(function* () {
      yield* backend.put(receipt.name, encodeReceipt(receipt));
      const observedReceipt = yield* get(receipt.name);
      if (Option.isNone(observedReceipt)) {
        return yield* new LeaseRaceError({
          name: receipt.name,
          attempted,
          observed: null,
        });
      }
      const observed = observedReceipt.value.lease;
      if (observed === null || !leaseMatches(attempted, observed)) {
        return yield* new LeaseRaceError({
          name: receipt.name,
          attempted,
          observed,
        });
      }
      return observedReceipt.value;
    });

  return {
    get,
    create: (receipt) =>
      Effect.gen(function* () {
        const existing = yield* get(receipt.name);
        if (Option.isSome(existing)) {
          return yield* new ReceiptAlreadyExistsError({
            name: receipt.name,
            existingId: existing.value.id,
          });
        }
        yield* backend.put(receipt.name, encodeReceipt(receipt));
        const observed = yield* get(receipt.name);
        if (Option.isNone(observed) || observed.value.id !== receipt.id) {
          return yield* new ReceiptCreationRaceError({
            name: receipt.name,
            attemptedId: receipt.id,
            observedId: Option.isSome(observed) ? observed.value.id : null,
          });
        }
      }),
    acquireLease: (name, operation, actor, now) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(name);
        if (receipt.lease !== null) {
          return yield* new LeaseHeldError({
            name,
            lease: receipt.lease,
            expired: DateTime.toEpochMillis(receipt.lease.expiresAt) <= DateTime.toEpochMillis(now),
          });
        }
        const lease: OperationLease = {
          operation,
          actor,
          expiresAt: DateTime.addDuration(now, "15 minutes"),
        };
        const next: DeploymentReceipt = {
          ...receipt,
          updatedAt: now,
          phase: phaseForOperation(operation),
          lease,
          history: Arr.takeRight(
            [
              ...receipt.history,
              {
                operation,
                actor,
                startedAt: now,
                completedAt: null,
                outcome: null,
              },
            ],
            20,
          ),
        };
        return yield* putAndConfirmLease(next, lease);
      }),
    renewLease: (name, lease, now) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(name);
        yield* requireLease(name, lease, receipt, now);
        const renewed = {
          ...lease,
          expiresAt: DateTime.addDuration(now, "15 minutes"),
        };
        return yield* putAndConfirmLease({ ...receipt, updatedAt: now, lease: renewed }, renewed);
      }),
    finishOperation: (name, lease, completion) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(name);
        yield* requireLease(name, lease, receipt, completion.now);
        const next: DeploymentReceipt = {
          ...receipt,
          ...(completion.versions === undefined ? {} : { versions: completion.versions }),
          ...(completion.cloudflare === undefined ? {} : { cloudflare: completion.cloudflare }),
          ...(completion.github === undefined ? {} : { github: completion.github }),
          ...(completion.autoUpgrade === undefined ? {} : { autoUpgrade: completion.autoUpgrade }),
          updatedAt: completion.now,
          phase: completion.phase,
          lease: null,
          history: finishLatestHistory(receipt, lease, completion.now, completion.outcome),
        };
        yield* backend.put(name, encodeReceipt(next));
        return yield* getRequired(name);
      }),
    releaseExpiredLeaseForRepair: (name, actor, now) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(name);
        if (receipt.lease === null) return receipt;
        if (DateTime.toEpochMillis(receipt.lease.expiresAt) > DateTime.toEpochMillis(now)) {
          return yield* new LeaseHeldError({
            name,
            lease: receipt.lease,
            expired: false,
          });
        }
        const history = finishLatestHistory(receipt, receipt.lease, now, "interrupted");
        const next: DeploymentReceipt = {
          ...receipt,
          updatedAt: now,
          lease: null,
          history: Arr.takeRight(
            [
              ...history,
              {
                operation: "repair",
                actor,
                startedAt: now,
                completedAt: now,
                outcome: "succeeded",
              },
            ],
            20,
          ),
        };
        yield* backend.put(name, encodeReceipt(next));
        return yield* getRequired(name);
      }),
    deleteReceipt: (name, deploymentId, lease, now) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(name);
        yield* requireLease(name, lease, receipt, now);
        if (receipt.id !== deploymentId) {
          return yield* new DeploymentOwnershipError({
            name,
            expectedId: deploymentId,
            observedId: receipt.id,
          });
        }
        yield* backend.remove(name);
        const remaining = yield* backend.listKeys();
        if (remaining.length > 0) return { namespaceRemoved: false };
        yield* backend.removeNamespace();
        return { namespaceRemoved: true };
      }),
  };
}
