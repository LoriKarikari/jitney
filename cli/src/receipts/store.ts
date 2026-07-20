import { Array as Arr, Data, DateTime, Duration, Effect, Option, Schema } from "effect";
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

/** The lease a running command holds, bundled with the deployment it locks. */
export interface LeaseContext {
  readonly name: string;
  readonly lease: OperationLease;
  readonly now: DateTime.Utc;
}

export interface OperationUpdate {
  readonly versions?: DeploymentReceipt["versions"];
  readonly cloudflare?: DeploymentReceipt["cloudflare"];
  readonly github?: DeploymentReceipt["github"];
  readonly autoUpgrade?: DeploymentReceipt["autoUpgrade"];
}

export interface OperationCompletion extends OperationUpdate {
  readonly phase: DeploymentPhase;
  readonly outcome: "succeeded" | "failed";
}

export interface ReceiptStoreOptions {
  /**
   * Wait before confirming an empty key listing and deleting the shared
   * namespace. KV key listing is eventually consistent, so one empty list can
   * be stale while another deployment's receipt is still propagating.
   *
   * @default 1 minute
   */
  readonly namespaceRemovalDelay?: Duration.Input;
}

export interface ReceiptStore {
  readonly get: (name: string) => Effect.Effect<Option.Option<DeploymentReceipt>, ReceiptReadError>;
  readonly list: () => Effect.Effect<readonly DeploymentReceipt[], ReceiptReadError>;
  readonly create: (receipt: DeploymentReceipt) => Effect.Effect<void, ReceiptStoreError>;
  readonly createWithInstallLease: (
    receipt: DeploymentReceipt,
    actor: string,
    now: DateTime.Utc,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly acquireLease: (
    name: string,
    operation: DeploymentOperation,
    actor: string,
    now: DateTime.Utc,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly renewLease: (
    context: LeaseContext,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly updateOperation: (
    context: LeaseContext,
    update: OperationUpdate,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly finishOperation: (
    context: LeaseContext,
    completion: OperationCompletion,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly releaseExpiredLeaseForRepair: (
    name: string,
    actor: string,
    now: DateTime.Utc,
  ) => Effect.Effect<DeploymentReceipt, ReceiptStoreError>;
  readonly deleteReceipt: (
    context: LeaseContext,
    deploymentId: string,
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
  context: LeaseContext,
  receipt: DeploymentReceipt,
): Effect.Effect<void, LeaseOwnershipError | LeaseExpiredError> => {
  if (receipt.lease === null || !leaseMatches(context.lease, receipt.lease)) {
    return Effect.fail(
      new LeaseOwnershipError({
        name: context.name,
        expected: context.lease,
        observed: receipt.lease,
      }),
    );
  }
  return DateTime.toEpochMillis(receipt.lease.expiresAt) <= DateTime.toEpochMillis(context.now)
    ? Effect.fail(new LeaseExpiredError({ name: context.name, lease: receipt.lease }))
    : Effect.void;
};

export function makeReceiptStore(
  backend: ReceiptBackend,
  options?: ReceiptStoreOptions,
): ReceiptStore {
  const namespaceRemovalDelay = options?.namespaceRemovalDelay ?? Duration.minutes(1);

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
    list: () =>
      backend.listKeys().pipe(
        Effect.map((keys) => [...keys].sort()),
        Effect.flatMap((keys) => Effect.forEach(keys, get)),
        Effect.map((receipts) => Arr.flatMap(receipts, Option.toArray)),
      ),
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
    createWithInstallLease: (receipt, actor, now) =>
      Effect.gen(function* () {
        const existing = yield* get(receipt.name);
        if (Option.isSome(existing)) {
          return yield* new ReceiptAlreadyExistsError({
            name: receipt.name,
            existingId: existing.value.id,
          });
        }
        const lease: OperationLease = {
          operation: "install",
          actor,
          expiresAt: DateTime.addDuration(now, "15 minutes"),
        };
        const attempted: DeploymentReceipt = {
          ...receipt,
          updatedAt: now,
          phase: "installing",
          lease,
          history: [
            {
              operation: "install",
              actor,
              startedAt: now,
              completedAt: null,
              outcome: null,
            },
          ],
        };
        yield* backend.put(receipt.name, encodeReceipt(attempted));
        const observed = yield* get(receipt.name);
        if (Option.isNone(observed) || observed.value.id !== receipt.id) {
          return yield* new ReceiptCreationRaceError({
            name: receipt.name,
            attemptedId: receipt.id,
            observedId: Option.isSome(observed) ? observed.value.id : null,
          });
        }
        if (observed.value.lease === null || !leaseMatches(lease, observed.value.lease)) {
          return yield* new LeaseRaceError({
            name: receipt.name,
            attempted: lease,
            observed: observed.value.lease,
          });
        }
        return observed.value;
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
    renewLease: (context) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(context.name);
        yield* requireLease(context, receipt);
        const renewed = {
          ...context.lease,
          expiresAt: DateTime.addDuration(context.now, "15 minutes"),
        };
        return yield* putAndConfirmLease(
          { ...receipt, updatedAt: context.now, lease: renewed },
          renewed,
        );
      }),
    updateOperation: (context, update) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(context.name);
        yield* requireLease(context, receipt);
        const next: DeploymentReceipt = {
          ...receipt,
          ...(update.versions === undefined ? {} : { versions: update.versions }),
          ...(update.cloudflare === undefined ? {} : { cloudflare: update.cloudflare }),
          ...(update.github === undefined ? {} : { github: update.github }),
          ...(update.autoUpgrade === undefined ? {} : { autoUpgrade: update.autoUpgrade }),
          updatedAt: context.now,
        };
        return yield* putAndConfirmLease(next, context.lease);
      }),
    finishOperation: (context, completion) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(context.name);
        yield* requireLease(context, receipt);
        const next: DeploymentReceipt = {
          ...receipt,
          ...(completion.versions === undefined ? {} : { versions: completion.versions }),
          ...(completion.cloudflare === undefined ? {} : { cloudflare: completion.cloudflare }),
          ...(completion.github === undefined ? {} : { github: completion.github }),
          ...(completion.autoUpgrade === undefined ? {} : { autoUpgrade: completion.autoUpgrade }),
          updatedAt: context.now,
          phase: completion.phase,
          lease: null,
          history: finishLatestHistory(receipt, context.lease, context.now, completion.outcome),
        };
        yield* backend.put(context.name, encodeReceipt(next));
        return yield* getRequired(context.name);
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
    deleteReceipt: (context, deploymentId) =>
      Effect.gen(function* () {
        const receipt = yield* getRequired(context.name);
        yield* requireLease(context, receipt);
        if (receipt.id !== deploymentId) {
          return yield* new DeploymentOwnershipError({
            name: context.name,
            expectedId: deploymentId,
            observedId: receipt.id,
          });
        }
        yield* backend.remove(context.name);
        const remaining = yield* backend.listKeys();
        if (remaining.length > 0) return { namespaceRemoved: false };
        // KV key listing is eventually consistent. Wait and list once more so a
        // concurrently created receipt cannot be lost with the namespace.
        yield* Effect.sleep(namespaceRemovalDelay);
        const confirmed = yield* backend.listKeys();
        if (confirmed.length > 0) return { namespaceRemoved: false };
        yield* backend.removeNamespace();
        return { namespaceRemoved: true };
      }),
  };
}
