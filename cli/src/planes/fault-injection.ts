import { Effect } from "effect";
import { InjectedCrash, InjectedFailure } from "./errors.js";

export type FaultPlan = {
  failAt?: number;
  crashAt?: number;
};

export class FaultInjector {
  #step = 0;

  constructor(private readonly plan: FaultPlan = {}) {}

  before(operation: string): Effect.Effect<void, InjectedFailure> {
    return Effect.suspend(() => {
      const step = ++this.#step;
      if (this.plan.crashAt === step) return Effect.die(new InjectedCrash(operation, step));
      if (this.plan.failAt === step) {
        return Effect.fail(new InjectedFailure({ operation, step }));
      }
      return Effect.void;
    });
  }
}
