import { Container, type StopParams } from "@cloudflare/containers";
import { Data, Effect } from "effect";
import { emit, type RunnerCorrelation } from "./log";

export type StartAttempt = RunnerCorrelation & { jitConfig: string };

type ContainerCorrelation = RunnerCorrelation & {
  containerId: string;
  deploymentId: string;
};

type RunnerContainerOperation = "correlation_read" | "correlation_write" | "container_start";

class RunnerContainerError extends Data.TaggedError("RunnerContainerError")<{
  operation: RunnerContainerOperation;
  cause: unknown;
}> {}

export class RunnerContainer extends Container<Env> {
  override sleepAfter = "10m";
  override enableInternet = true;

  startAttempt(request: StartAttempt): Promise<void> {
    const { jitConfig, ...correlation } = request;
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* Effect.tryPromise({
          try: () => this.ctx.storage.put("correlation", correlation satisfies RunnerCorrelation),
          catch: (cause) => new RunnerContainerError({ operation: "correlation_write", cause }),
        });
        yield* Effect.tryPromise({
          try: () => this.start({ envVars: { JIT_CONFIG: jitConfig } }),
          catch: (cause) => new RunnerContainerError({ operation: "container_start", cause }),
        });
      }),
    );
  }

  override onStart(): Promise<void> {
    return Effect.runPromise(
      this.#correlation().pipe(
        Effect.tap((correlation) =>
          Effect.sync(() => emit({ event: "runner_container_started", ...correlation })),
        ),
        Effect.asVoid,
      ),
    );
  }

  override onStop({ exitCode, reason }: StopParams): Promise<void> {
    return Effect.runPromise(
      this.#correlation().pipe(
        Effect.tap((correlation) =>
          Effect.sync(() =>
            emit({
              event: "runner_container_stopped",
              ...correlation,
              exitCode,
              stopReason: reason,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    );
  }

  override async onError(error: unknown): Promise<never> {
    // Container hooks are the runtime boundary. Preserve the original rejection
    // after running the structured logging effect.
    await Effect.runPromise(
      this.#correlation().pipe(
        Effect.tap((correlation) =>
          Effect.sync(() =>
            emit({
              event: "runner_container_failed",
              ...correlation,
              outcome: error instanceof Error ? "classified_error" : "unknown_error",
            }),
          ),
        ),
      ),
    );
    throw error;
  }

  #correlation(): Effect.Effect<ContainerCorrelation, RunnerContainerError> {
    return Effect.tryPromise({
      try: () => this.ctx.storage.get<RunnerCorrelation>("correlation"),
      catch: (cause) => new RunnerContainerError({ operation: "correlation_read", cause }),
    }).pipe(
      Effect.flatMap((correlation) =>
        correlation === undefined
          ? Effect.fail(
              new RunnerContainerError({
                operation: "correlation_read",
                cause: new Error("runner correlation is missing"),
              }),
            )
          : Effect.succeed({
              ...correlation,
              containerId: this.ctx.id.toString(),
              deploymentId: this.env.CF_VERSION_METADATA.id,
            }),
      ),
    );
  }
}
