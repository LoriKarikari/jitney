import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../src";

const webhookUrl = "https://example.com/webhooks/github";
const webhookSecret = "test-webhook-secret";

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256=${hex}`;
}

function queuedPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "queued",
    installation: { id: 123 },
    repository: {
      id: 456,
      name: "jitney-test",
      private: true,
      owner: { login: "LoriKarikari" },
    },
    workflow_job: { id: 789, labels: ["jitney"], runner_name: null, conclusion: null },
    ...overrides,
  });
}

async function fetch(url: string, init?: RequestInit): Promise<Response> {
  return handler.fetch(new Request(url, init), env);
}

describe("worker entrypoint", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports the deployed Jitney version", async () => {
    const response = await fetch("https://example.com/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "dev" });
  });

  it("answers unknown routes with 404", async () => {
    const response = await fetch("https://example.com/anything");
    expect(response.status).toBe(404);
  });

  it("rejects an oversized GitHub webhook once", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await fetch(webhookUrl, {
      method: "POST",
      body: "x".repeat(1_048_577),
    });

    expect(response.status).toBe(413);
    const classifications = logged.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => record.event === "webhook_classified");
    expect(classifications).toHaveLength(1);
    expect(classifications).toMatchObject([{ outcome: "payload_too_large" }]);
  });

  it("rejects a GitHub webhook without a signature", async () => {
    const response = await fetch(webhookUrl, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });

  it("rejects a webhook whose signature belongs to different raw bytes", async () => {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "X-Hub-Signature-256": await signature('{"action":"queued"}') },
      body: '{ "action": "queued" }',
    });
    expect(response.status).toBe(401);
  });

  it("ignores a signed unrelated GitHub event", async () => {
    const body = "{}";
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await signature(body),
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-ping",
      },
      body,
    });
    expect(response.status).toBe(204);
  });

  it("returns 400 for a signed malformed workflow job", async () => {
    const body = JSON.stringify({ action: "queued" });
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await signature(body),
        "X-GitHub-Event": "workflow_job",
        "X-GitHub-Delivery": "delivery-malformed",
      },
      body,
    });
    expect(response.status).toBe(400);
  });

  it.each([
    [
      "public repositories",
      {
        repository: {
          id: 456,
          name: "jitney-test",
          private: false,
          owner: { login: "LoriKarikari" },
        },
      },
    ],
    ["unsupported labels", { workflow_job: { id: 789, labels: ["ubuntu-latest"] } }],
    ["additional unsatisfied labels", { workflow_job: { id: 789, labels: ["jitney", "gpu"] } }],
  ])("ignores %s", async (_case, override) => {
    const body = queuedPayload(override);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await signature(body),
        "X-GitHub-Event": "workflow_job",
        "X-GitHub-Delivery": `delivery-${_case}`,
      },
      body,
    });
    expect(response.status).toBe(204);
  });

  it("durably accepts a signed private queued job before returning 202", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const body = queuedPayload();
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await signature(body),
        "X-GitHub-Event": "workflow_job",
        "X-GitHub-Delivery": "delivery-accepted",
      },
      body,
    });

    expect(response.status).toBe(202);
    const classifications = logged.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => record.event === "webhook_classified");
    expect(classifications).toHaveLength(1);
    expect(classifications).toMatchObject([
      {
        deliveryId: "delivery-accepted",
        installationId: 123,
        repositoryId: 456,
        workflowJobId: 789,
        runnerName: "jitney-456-789-1",
        action: "queued",
        outcome: "accepted",
      },
    ]);
    const job = await env.SCHEDULER.getByName("global-v3").getJob(789);
    expect(job).toEqual({ workflowJobId: 789, state: "queued", repositoryId: 456, pending: true });
  });
});
