import { DurableObject } from "cloudflare:workers";
import { Data, Effect } from "effect";
import { runnerContainerInactivityTimeoutMs } from "./lifecycle";
import { emit, type RunnerCorrelation } from "./log";

export type StartAttempt = RunnerCorrelation & { jitConfig: string };

class RunnerContainerError extends Data.TaggedError("RunnerContainerError")<{
  cause: unknown;
}> {}

export class RunnerContainer extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A restarted instance loses the inactivity timeout, and Cloudflare then stops the container.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => this.#keepAlive(container));
  }

  startAttempt(request: StartAttempt): Promise<void> {
    const { jitConfig, ...correlation } = request;
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const container = this.ctx.container;
        if (container === undefined) {
          return yield* new RunnerContainerError({
            cause: new Error("RunnerContainer has no container binding"),
          });
        }
        if (container.running) return;
        yield* Effect.tryPromise({
          try: () => {
            container.start({ env: { JIT_CONFIG: jitConfig }, enableInternet: true });
            return this.#keepAlive(container);
          },
          catch: (cause) => new RunnerContainerError({ cause }),
        });
        yield* Effect.sync(() =>
          emit({
            event: "runner_container_started",
            ...correlation,
            containerId: this.ctx.id.toString(),
            deploymentId: this.env.CF_VERSION_METADATA.id,
          }),
        );
      }),
    );
  }

  isRunning(): boolean {
    return this.ctx.container?.running === true;
  }

  async destroy(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }

  #keepAlive(container: Container): Promise<void> {
    return container.setInactivityTimeout(
      runnerContainerInactivityTimeoutMs(Number(this.env.RUNTIME_TIMEOUT_MS) || undefined),
    );
  }
}
