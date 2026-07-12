import { afterEach, describe, expect, it, vi } from "vitest";
import { emit, type LifecycleRecord } from "../src/log";

const correlation = {
  deliveryId: "delivery-1",
  installationId: 123,
  repositoryId: 456,
  workflowJobId: 789,
  runnerName: "jitney-456-789-1",
  containerName: "attempt-456-789-1",
};

afterEach(() => vi.restoreAllMocks());

describe("lifecycle logging", () => {
  it.each([
    ["private key", "-----BEGIN PRIVATE KEY-----\nPRIVATE_KEY_CANARY\n-----END PRIVATE KEY-----"],
    ["JWT", "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJjYW5hcnkifQ.signature-canary"],
    ["installation token", `ghs_${"TOKEN_CANARY".repeat(4)}`],
    ["webhook signature", `sha256=${"a".repeat(64)}`],
    ["JIT configuration", btoa("SINGLE_USE_JIT_CANARY".repeat(20))],
  ])("redacts a %s", (_kind, canary) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    emit({
      event: "runner_provisioning_failed",
      ...correlation,
      runnerName: canary,
      step: "container_start",
    });

    expect(logged).toHaveBeenCalledOnce();
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).not.toContain(canary);
    expect(line).toContain("[REDACTED]");
  });

  it("renders every approved field across representative records", () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line) => output.push(String(line)));
    const records = [
      {
        event: "scheduler_transition",
        ...correlation,
        deploymentId: "deployment-1",
        attempt: 1,
        action: "completed",
        outcome: "recorded",
        state: "completed",
        conclusion: "success",
      },
      {
        event: "reconciliation_completed",
        deploymentId: "deployment-1",
        discovered: 5,
        submitted: 2,
        suppressed: 1,
        ignored: 1,
        failures: 1,
      },
      {
        event: "runner_container_stopped",
        installationId: 123,
        repositoryId: 456,
        workflowJobId: 789,
        runnerName: "jitney-456-789-1",
        containerName: "attempt-456-789-1",
        containerId: "container-id",
        deploymentId: "deployment-1",
        exitCode: 0,
        stopReason: "exited",
      },
      {
        event: "runner_provisioning_failed",
        ...correlation,
        deploymentId: "deployment-1",
        step: "container_start",
      },
    ] satisfies LifecycleRecord[];

    for (const record of records) emit(record);

    expect(output).toHaveLength(records.length);
    for (const [index, record] of records.entries()) {
      expect(JSON.parse(output[index] ?? "")).toMatchObject(record);
    }
  });

  it("drops fields outside the runtime allowlist", () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const canary = "RAW_ERROR_CANARY";

    emit({
      event: "scheduler_transition",
      ...correlation,
      action: "queued",
      outcome: "accepted",
      rawError: canary,
    } as Parameters<typeof emit>[0]);

    expect(String(logged.mock.calls[0]?.[0])).not.toContain(canary);
    expect(String(logged.mock.calls[0]?.[0])).not.toContain("rawError");
  });

  it("emits the correlation fields as one structured record", () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emit({
      event: "scheduler_transition",
      ...correlation,
      attempt: 1,
      action: "queued",
      outcome: "accepted",
      state: "created",
    });

    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      event: "scheduler_transition",
      ...correlation,
      attempt: 1,
      action: "queued",
      outcome: "accepted",
      state: "created",
    });
  });

  it("classifies rejected webhooks as warnings", () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    emit({
      event: "webhook_classified",
      deliveryId: "delivery-rejected",
      deploymentId: "deployment-1",
      outcome: "invalid_signature",
    });

    expect(logged).toHaveBeenCalledOnce();
  });
});
