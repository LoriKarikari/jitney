import { describe, expect, it } from "vitest";
import { classifyDelivery } from "../src/delivery-classification";

const webhookSecret = "test-webhook-secret";
const webhookUrl = "https://example.com/webhooks/github";

async function signature(body: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const signed = await crypto.subtle.sign("HMAC", key, bytes);
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

type RequestOptions = {
  contentLength?: number;
  deliveryId?: string;
  eventName?: string;
  signature?: string;
  signed?: boolean;
};

async function webhookRequest(body: string, options: RequestOptions = {}): Promise<Request> {
  const headers = new Headers();
  if (options.contentLength !== undefined) {
    headers.set("Content-Length", String(options.contentLength));
  }
  if (options.deliveryId !== undefined) headers.set("X-GitHub-Delivery", options.deliveryId);
  if (options.eventName !== undefined) headers.set("X-GitHub-Event", options.eventName);
  if (options.signature !== undefined) headers.set("X-Hub-Signature-256", options.signature);
  if (options.signed) headers.set("X-Hub-Signature-256", await signature(body));
  return new Request(webhookUrl, { method: "POST", headers, body });
}

describe("Delivery classification", () => {
  it.each([
    {
      name: "rejects an oversized body before signature verification",
      body: "x".repeat(1_048_577),
      options: {},
      expected: { status: 413, outcome: "payload_too_large", deliveryId: null },
    },
    {
      name: "rejects a declared oversized body without reading it",
      body: "small",
      options: { contentLength: 1_048_577 },
      expected: { status: 413, outcome: "payload_too_large", deliveryId: null },
    },
    {
      name: "rejects a missing signature",
      body: "{}",
      options: { deliveryId: "delivery-unsigned", eventName: "workflow_job" },
      expected: { status: 401, outcome: "invalid_signature", deliveryId: "delivery-unsigned" },
    },
    {
      name: "rejects a signature for different bytes",
      body: "{}",
      options: {
        deliveryId: "delivery-wrong-signature",
        eventName: "workflow_job",
        signature: `sha256=${"0".repeat(64)}`,
      },
      expected: {
        status: 401,
        outcome: "invalid_signature",
        deliveryId: "delivery-wrong-signature",
      },
    },
    {
      name: "rejects a malformed signature",
      body: "{}",
      options: {
        deliveryId: "delivery-malformed-signature",
        eventName: "workflow_job",
        signature: "zz",
      },
      expected: {
        status: 401,
        outcome: "invalid_signature",
        deliveryId: "delivery-malformed-signature",
      },
    },
    {
      name: "ignores an unrelated signed event",
      body: "{}",
      options: { deliveryId: "delivery-ping", eventName: "ping", signed: true },
      expected: { status: 204, outcome: "ignored", deliveryId: "delivery-ping" },
    },
    {
      name: "rejects a workflow job without Delivery identity",
      body: queuedPayload(),
      options: { eventName: "workflow_job", signed: true },
      expected: { status: 400, outcome: "malformed", deliveryId: null },
    },
    {
      name: "rejects malformed workflow job JSON",
      body: "{",
      options: {
        deliveryId: "delivery-malformed",
        eventName: "workflow_job",
        signed: true,
      },
      expected: { status: 400, outcome: "malformed", deliveryId: "delivery-malformed" },
    },
    {
      name: "ignores an unsupported workflow action",
      body: JSON.stringify({ action: "requested" }),
      options: {
        deliveryId: "delivery-unsupported",
        eventName: "workflow_job",
        signed: true,
      },
      expected: { status: 204, outcome: "ignored", deliveryId: "delivery-unsupported" },
    },
    {
      name: "ignores an inadmissible workflow job",
      body: queuedPayload({ workflow_job: { id: 789, labels: ["ubuntu-latest"] } }),
      options: {
        deliveryId: "delivery-inadmissible",
        eventName: "workflow_job",
        signed: true,
      },
      expected: { status: 204, outcome: "ignored", deliveryId: "delivery-inadmissible" },
    },
  ])("$name", async ({ body, options, expected }) => {
    const request = await webhookRequest(body, options);

    expect(await classifyDelivery(request, webhookSecret)).toEqual(expected);
  });

  it("classifies an unreadable request body as malformed", async () => {
    const request = await webhookRequest("{}", {
      deliveryId: "delivery-unreadable",
      eventName: "workflow_job",
      signed: true,
    });
    const reader = request.body?.getReader();
    if (reader === undefined) throw new Error("expected request body");

    try {
      expect(await classifyDelivery(request, webhookSecret)).toEqual({
        status: 400,
        outcome: "malformed",
        deliveryId: "delivery-unreadable",
      });
    } finally {
      reader.releaseLock();
    }
  });

  it("verifies the signature against raw non-UTF-8 bytes", async () => {
    const body = new Uint8Array([0xff]);
    const request = new Request(webhookUrl, {
      method: "POST",
      headers: {
        "X-GitHub-Delivery": "delivery-binary",
        "X-GitHub-Event": "workflow_job",
        "X-Hub-Signature-256": await signature(body),
      },
      body,
    });

    expect(await classifyDelivery(request, webhookSecret)).toEqual({
      status: 400,
      outcome: "malformed",
      deliveryId: "delivery-binary",
    });
  });

  it("classifies an empty signed workflow job as malformed", async () => {
    const request = await webhookRequest("", {
      deliveryId: "delivery-empty",
      eventName: "workflow_job",
      signed: true,
    });

    expect(await classifyDelivery(request, webhookSecret)).toEqual({
      status: 400,
      outcome: "malformed",
      deliveryId: "delivery-empty",
    });
  });

  it("allows a body exactly at the one-megabyte limit", async () => {
    const body = "x".repeat(1_048_576);
    const request = await webhookRequest(body, {
      deliveryId: "delivery-at-limit",
      eventName: "workflow_job",
      signed: true,
    });

    expect(await classifyDelivery(request, webhookSecret)).toEqual({
      status: 400,
      outcome: "malformed",
      deliveryId: "delivery-at-limit",
    });
  });

  it("returns a decoded Workflow Event for an accepted Delivery", async () => {
    const request = await webhookRequest(queuedPayload(), {
      deliveryId: "delivery-accepted",
      eventName: "workflow_job",
      signed: true,
    });

    expect(await classifyDelivery(request, webhookSecret)).toEqual({
      status: 202,
      outcome: "accepted",
      deliveryId: "delivery-accepted",
      event: {
        deliveryId: "delivery-accepted",
        action: "queued",
        installationId: 123,
        repositoryId: 456,
        repositoryOwner: "LoriKarikari",
        repositoryName: "jitney-test",
        repositoryPrivate: true,
        workflowJobId: 789,
        labels: ["jitney"],
      },
    });
  });
});
