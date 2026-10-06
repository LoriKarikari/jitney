import { DurableObject } from "cloudflare:workers";
import { Data, Duration, Effect, Schedule } from "effect";
import { runnerContainerInactivityTimeoutMs } from "./lifecycle";
import { emit, type RunnerCorrelation } from "./log";

export type StartAttempt = RunnerCorrelation & { jitConfig: string };

class RunnerContainerError extends Data.TaggedError("RunnerContainerError")<{
  cause: unknown;
}> {}

type ContainerHandle = Pick<Container, "running" | "start" | "setInactivityTimeout">;

export function controlRunner(container: ContainerHandle, inactivityTimeoutMs: number) {
  // An instance starts without a timeout, including after a deploy restarts it.
  let armed = false;
  const arm = Effect.tryPromise({
    try: () => container.setInactivityTimeout(inactivityTimeoutMs),
    catch: (cause) => new RunnerContainerError({ cause }),
  }).pipe(Effect.tap(() => Effect.sync(() => (armed = true))));

  const start = (env: Record<string, string>) =>
    Effect.gen(function* () {
      if (!container.running) {
        yield* Effect.try({
          try: () => container.start({ env, enableInternet: true }),
          catch: (cause) => new RunnerContainerError({ cause }),
        });
      }
      if (!armed) yield* arm;
    }).pipe(
      // A runner that is up may already be running a Job. Never report it as failed.
      Effect.catch((error) => (container.running ? Effect.void : Effect.fail(error))),
      Effect.retry({ schedule: Schedule.spaced(Duration.seconds(2)), times: 14 }),
    );

  const isRunning = Effect.gen(function* () {
    if (container.running && !armed) yield* Effect.ignore(arm);
    return container.running;
  });

  return { start, isRunning };
}

export class RunnerContainer extends DurableObject<Env> {
  #runner = this.ctx.container
    ? controlRunner(
        this.ctx.container,
        runnerContainerInactivityTimeoutMs(Number(this.env.RUNTIME_TIMEOUT_MS) || undefined),
      )
    : undefined;

  startAttempt(request: StartAttempt): Promise<void> {
    const { jitConfig, ...correlation } = request;
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        if (this.#runner === undefined) {
          return yield* new RunnerContainerError({
            cause: new Error("RunnerContainer has no container binding"),
          });
        }
        yield* this.#runner.start({ JIT_CONFIG: jitConfig });
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

  isRunning(): Promise<boolean> {
    return this.#runner === undefined
      ? Promise.resolve(false)
      : Effect.runPromise(this.#runner.isRunning);
  }

  async destroy(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}
