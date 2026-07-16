import { describe, expect, it } from "vitest";
import { renderWranglerConfig, validateWorkerName } from "../src/config.js";

describe("renderWranglerConfig", () => {
  const base = {
    accountId: "account-id",
    image: "registry.cloudflare.com/account-id/jitney:0.1.0",
    workerName: "jitney-example",
  };

  it("creates an inert bootstrap deployment", () => {
    const config = JSON.parse(renderWranglerConfig({ ...base, configured: false }));
    expect(config.name).toBe("jitney-example");
    expect(config.account_id).toBe("account-id");
    expect(config.containers[0]).toMatchObject({
      name: "jitney-example-runner",
      image: base.image,
    });
    expect(config).not.toHaveProperty("triggers");
    expect(config).not.toHaveProperty("secrets");
  });

  it("enables reconciliation only after credentials are stored", () => {
    const config = JSON.parse(renderWranglerConfig({ ...base, configured: true }));
    expect(config.triggers.crons).toEqual(["*/5 * * * *"]);
    expect(config.secrets.required).toEqual([
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
    ]);
  });
});

describe("validateWorkerName", () => {
  it.each(["jitney", "jitney-example", "j1"])("accepts %s", (name) => {
    expect(validateWorkerName(name)).toBe(name);
  });

  it.each(["Jitney", "1jitney", "jitney_example", `j${"x".repeat(50)}`])("rejects %s", (name) => {
    expect(() => validateWorkerName(name)).toThrow("Worker name");
  });
});
