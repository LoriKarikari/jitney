import { Data, Effect } from "effect";

export type ResourceReference = string;

export type ReceiptProbe = {
  resources: readonly ResourceReference[];
  terminal: boolean;
  lease?: { operation: string; expiresAt: number };
};

export class PlaneInvariantViolation extends Data.TaggedError("PlaneInvariantViolation")<{
  violation: "unrecorded_resource" | "terminal_live_lease";
  resource?: ResourceReference;
}> {}

export function assertPlaneInvariants(input: {
  resources: readonly ResourceReference[];
  receipts: readonly ReceiptProbe[];
}): Effect.Effect<void, PlaneInvariantViolation> {
  const recorded = new Set(input.receipts.flatMap((receipt) => receipt.resources));
  const unrecorded = input.resources.find((resource) => !recorded.has(resource));
  if (unrecorded !== undefined) {
    return Effect.fail(
      new PlaneInvariantViolation({ violation: "unrecorded_resource", resource: unrecorded }),
    );
  }
  if (input.receipts.some((receipt) => receipt.terminal && receipt.lease !== undefined)) {
    return Effect.fail(new PlaneInvariantViolation({ violation: "terminal_live_lease" }));
  }
  return Effect.void;
}
