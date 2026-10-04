// Failure modes this file guards. A leaked secret would not fail any live check.
// 1. A private key, JWT, installation token, webhook signature, or JIT configuration
//    reaches the logs.
// 2. A field outside the allowlist reaches the logs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../src/log";

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
});
