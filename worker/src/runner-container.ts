import { Container, type StopParams } from "@cloudflare/containers";
import { emit, type RunnerCorrelation } from "./log";

export type StartAttempt = RunnerCorrelation & { jitConfig: string };

type ContainerCorrelation = RunnerCorrelation & {
  containerId: string;
  deploymentId: string;
};

export class RunnerContainer extends Container<Env> {
  override sleepAfter = "10m";
  override enableInternet = true;

  async startAttempt(request: StartAttempt): Promise<void> {
    const { jitConfig, ...correlation } = request;
    await this.ctx.storage.put("correlation", correlation satisfies RunnerCorrelation);
    await this.start({ envVars: { JIT_CONFIG: jitConfig } });
  }

  override async onStart(): Promise<void> {
    emit({ event: "runner_container_started", ...(await this.#correlation()) });
  }

  override async onStop({ exitCode, reason }: StopParams): Promise<void> {
    emit({
      event: "runner_container_stopped",
      ...(await this.#correlation()),
      exitCode,
      stopReason: reason,
    });
  }

  override async onError(error: unknown): Promise<never> {
    emit({
      event: "runner_container_failed",
      ...(await this.#correlation()),
      outcome: error instanceof Error ? "classified_error" : "unknown_error",
    });
    throw error;
  }

  async #correlation(): Promise<ContainerCorrelation> {
    const correlation = await this.ctx.storage.get<RunnerCorrelation>("correlation");
    if (correlation === undefined) throw new Error("runner correlation is missing");
    return {
      ...correlation,
      containerId: this.ctx.id.toString(),
      deploymentId: this.env.CF_VERSION_METADATA.id,
    };
  }
}
