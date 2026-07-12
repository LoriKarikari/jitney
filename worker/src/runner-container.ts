import { Container, type StopParams } from "@cloudflare/containers";
import { emit, type LifecycleFields } from "./log";

export type StartAttempt = {
  jitConfig: string;
  installationId: number;
  repositoryId: number;
  workflowJobId: number;
  runnerName: string;
  containerName: string;
};

export class RunnerContainer extends Container<Env> {
  override sleepAfter = "10m";
  override enableInternet = true;

  async startAttempt(request: StartAttempt): Promise<void> {
    const { jitConfig, ...correlation } = request;
    await this.ctx.storage.put("correlation", correlation satisfies LifecycleFields);
    await this.start({ envVars: { JIT_CONFIG: jitConfig } });
  }

  override async onStart(): Promise<void> {
    emit("info", "runner_container_started", await this.#fields());
  }

  override async onStop({ exitCode, reason }: StopParams): Promise<void> {
    emit("info", "runner_container_stopped", {
      ...(await this.#fields()),
      exitCode,
      stopReason: reason,
    });
  }

  override async onError(error: unknown): Promise<never> {
    emit("error", "runner_container_failed", {
      ...(await this.#fields()),
      outcome: error instanceof Error ? "classified_error" : "unknown_error",
    });
    throw error;
  }

  async #fields(): Promise<LifecycleFields> {
    const correlation = await this.ctx.storage.get<LifecycleFields>("correlation");
    return {
      ...correlation,
      containerId: this.ctx.id.toString(),
      deploymentId: this.env.CF_VERSION_METADATA.id,
    };
  }
}
