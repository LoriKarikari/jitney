import { DateTime, Effect, Ref } from "effect";
import { InstallerError } from "../errors.js";
import type { DeploymentReceipt, OperationLease } from "./schema.js";
import type {
  LeaseContext,
  OperationCompletion,
  OperationUpdate,
  ReceiptStore,
  ReceiptStoreError,
} from "./store.js";

export type HeldDeploymentReceipt = DeploymentReceipt & { readonly lease: OperationLease };

/**
 * How often a running command re-extends its Operation Lease while a long
 * step (image copy, browser wait, drain) is still in flight. Must stay well
 * inside the 15-minute lease TTL from ADR-0002.
 */
const HEARTBEAT_INTERVAL = "5 minutes";

/**
 * One lifecycle command's exclusive session with a Deployment Receipt.
 *
 * Every effect passed through `guard` runs while a background heartbeat keeps
 * the lease alive. `record` updates inventory mid-operation without releasing
 * the lease. Exactly one of `finish` or `deleteReceipt` settles the receipt;
 * a command that does neither leaves the deployment for `repair`.
 */
export interface HeldOperation {
  readonly guard: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | InstallerError, R>;
  readonly record: (
    update: (current: HeldDeploymentReceipt) => OperationUpdate,
  ) => Effect.Effect<HeldDeploymentReceipt, InstallerError>;
  readonly finish: (
    completion: OperationCompletion,
  ) => Effect.Effect<DeploymentReceipt, InstallerError>;
  readonly deleteReceipt: (
    deploymentId: string,
  ) => Effect.Effect<{ readonly namespaceRemoved: boolean }, InstallerError>;
  readonly receipt: () => Effect.Effect<HeldDeploymentReceipt>;
}

const receiptError = (message: string) =>
  Effect.mapError(
    (cause: ReceiptStoreError) => new InstallerError({ step: "receipt_store", message, cause }),
  );

const requireHeld = (
  receipt: DeploymentReceipt,
): Effect.Effect<HeldDeploymentReceipt, InstallerError> =>
  receipt.lease === null
    ? Effect.fail(
        new InstallerError({
          step: "receipt_store",
          message: `Deployment ${receipt.name} lost its operation lease`,
        }),
      )
    : Effect.succeed({ ...receipt, lease: receipt.lease });

const makeHeldOperation = (
  store: ReceiptStore,
  initial: HeldDeploymentReceipt,
): Effect.Effect<HeldOperation> =>
  Effect.gen(function* () {
    const name = initial.name;
    const operation = initial.lease.operation;
    const held = yield* Ref.make(initial);
    const context = (receipt: HeldDeploymentReceipt, now: DateTime.Utc): LeaseContext => ({
      name,
      lease: receipt.lease,
      now,
    });

    const renew = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const current = yield* Ref.get(held);
      const renewed = yield* store
        .renewLease(context(current, now))
        .pipe(
          receiptError(`Could not renew the ${operation} lease for ${name}`),
          Effect.flatMap(requireHeld),
        );
      yield* Ref.set(held, renewed);
    });

    const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      renew.pipe(
        Effect.andThen(
          Effect.raceFirst(
            effect,
            Effect.forever(Effect.sleep(HEARTBEAT_INTERVAL).pipe(Effect.andThen(renew))),
          ),
        ),
      );

    const record = (update: (current: HeldDeploymentReceipt) => OperationUpdate) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const current = yield* Ref.get(held);
        const next = yield* store
          .updateOperation(context(current, now), update(current))
          .pipe(
            receiptError(`Could not record ${operation} progress for ${name}`),
            Effect.flatMap(requireHeld),
          );
        yield* Ref.set(held, next);
        return next;
      });

    const finish = (completion: OperationCompletion) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const current = yield* Ref.get(held);
        return yield* store
          .finishOperation(context(current, now), completion)
          .pipe(receiptError(`Could not complete the ${operation} for ${name}`));
      });

    const deleteReceipt = (deploymentId: string) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const current = yield* Ref.get(held);
        return yield* store
          .deleteReceipt(context(current, now), deploymentId)
          .pipe(receiptError(`Could not remove the receipt for ${name}`));
      });

    return { guard, record, finish, deleteReceipt, receipt: () => Ref.get(held) };
  });

/**
 * Create a new receipt and its install lease in one write, then hold it.
 */
export const beginInstallOperation = (
  store: ReceiptStore,
  receipt: DeploymentReceipt,
  actor: string,
  now: DateTime.Utc,
): Effect.Effect<HeldOperation, InstallerError> =>
  store.createWithInstallLease(receipt, actor, now).pipe(
    receiptError("Could not create the deployment receipt"),
    Effect.flatMap(requireHeld),
    Effect.flatMap((held) => makeHeldOperation(store, held)),
  );

/**
 * Acquire a lease on an existing receipt and hold it. This is the entry
 * point for upgrade, repair, destroy, and rollback commands.
 */
export const beginLeasedOperation = (
  store: ReceiptStore,
  name: string,
  operation: OperationLease["operation"],
  actor: string,
): Effect.Effect<HeldOperation, InstallerError> =>
  DateTime.now.pipe(
    Effect.flatMap((now) =>
      store.acquireLease(name, operation, actor, now).pipe(
        receiptError(`Could not acquire the ${operation} lease for ${name}`),
        Effect.flatMap(requireHeld),
        Effect.flatMap((held) => makeHeldOperation(store, held)),
      ),
    ),
  );
