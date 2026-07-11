import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker entrypoint", () => {
  it("answers unknown routes with 404", async () => {
    const response = await exports.default.fetch("https://example.com/anything");
    expect(response.status).toBe(404);
  });
});
