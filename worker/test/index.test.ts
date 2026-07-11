import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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

function queuedPayload(): string {
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
  });
}

describe("worker entrypoint", () => {
  it("answers unknown routes with 404", async () => {
    const response = await exports.default.fetch("https://example.com/anything");
    expect(response.status).toBe(404);
  });

  it("rejects a GitHub webhook without a signature", async () => {
    const response = await exports.default.fetch(webhookUrl, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });

  it("rejects a webhook whose signature belongs to different raw bytes", async () => {
    const response = await exports.default.fetch(webhookUrl, {
      method: "POST",
      headers: { "X-Hub-Signature-256": await signature('{"action":"queued"}') },
      body: '{ "action": "queued" }',
    });
    expect(response.status).toBe(401);
  });

  it("ignores a signed unrelated GitHub event", async () => {
    const body = "{}";
    const response = await exports.default.fetch(webhookUrl, {
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

  it("durably accepts a signed private queued job before returning 202", async () => {
    const body = queuedPayload();
    const response = await exports.default.fetch(webhookUrl, {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await signature(body),
        "X-GitHub-Event": "workflow_job",
        "X-GitHub-Delivery": "delivery-accepted",
      },
      body,
    });

    expect(response.status).toBe(202);
    const job = await env.SCHEDULER.getByName("global").getJob(789);
    expect(job).toEqual({ workflowJobId: 789, state: "queued", repositoryId: 456, pending: true });
  });
});
