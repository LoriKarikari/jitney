import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../src/log";

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

    emit("error", "runner_provisioning_failed", {
      workflowJobId: 789,
      runnerName: canary,
      step: "container_start",
    });

    expect(logged).toHaveBeenCalledOnce();
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).not.toContain(canary);
    expect(line).toContain("[REDACTED]");
  });

  it("drops fields outside the runtime allowlist", () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const canary = "RAW_ERROR_CANARY";

    emit("info", "scheduler_transition", {
      workflowJobId: 789,
      rawError: canary,
    } as Parameters<typeof emit>[2]);

    expect(String(logged.mock.calls[0]?.[0])).not.toContain(canary);
    expect(String(logged.mock.calls[0]?.[0])).not.toContain("rawError");
  });

  it("emits the correlation fields as one structured record", () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emit("info", "scheduler_transition", {
      deliveryId: "delivery-1",
      installationId: 123,
      repositoryId: 456,
      workflowJobId: 789,
      attempt: 1,
      runnerName: "jitney-456-789-1",
      containerName: "attempt-456-789-1",
      action: "queued",
      outcome: "accepted",
      state: "created",
    });

    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      event: "scheduler_transition",
      deliveryId: "delivery-1",
      installationId: 123,
      repositoryId: 456,
      workflowJobId: 789,
      attempt: 1,
      runnerName: "jitney-456-789-1",
      containerName: "attempt-456-789-1",
      action: "queued",
      outcome: "accepted",
      state: "created",
    });
  });
});
