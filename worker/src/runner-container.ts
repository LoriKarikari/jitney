import { Container, type StopParams } from "@cloudflare/containers";

export class RunnerContainer extends Container<Env> {
  override sleepAfter = "10m";
  override enableInternet = true;

  async startAttempt(jitConfig: string): Promise<void> {
    await this.start({
      envVars: { JIT_CONFIG: jitConfig },
    });
  }

  override onStart(): void {
    console.log(
      JSON.stringify({ event: "runner_container_started", containerId: this.ctx.id.toString() }),
    );
  }

  override onStop({ exitCode, reason }: StopParams): void {
    console.log(
      JSON.stringify({
        event: "runner_container_stopped",
        containerId: this.ctx.id.toString(),
        exitCode,
        reason,
      }),
    );
  }

  override onError(error: unknown): never {
    console.error(
      JSON.stringify({
        event: "runner_container_failed",
        containerId: this.ctx.id.toString(),
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    throw error;
  }
}
