import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker entrypoint", () => {
  it("answers unknown routes with 404", async () => {
    const response = await exports.default.fetch("https://example.com/anything");
    expect(response.status).toBe(404);
  });

  it("rejects a GitHub webhook without a signature", async () => {
    const response = await exports.default.fetch("https://example.com/webhooks/github", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(401);
  });

  it("rejects a webhook whose signature belongs to different raw bytes", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-webhook-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode('{"action":"queued"}'),
    );
    const hex = Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    const response = await exports.default.fetch("https://example.com/webhooks/github", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${hex}` },
      body: '{ "action": "queued" }',
    });

    expect(response.status).toBe(401);
  });
});
