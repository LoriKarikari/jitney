import { describe, expect, it } from "vitest";
import { githubAppManifest, listenForManifestCode } from "../src/github-app.js";

describe("githubAppManifest", () => {
  it("requests only the permissions and event Jitney needs", () => {
    const manifest = githubAppManifest(
      { workerName: "jitney-example", workerUrl: "https://jitney-example.example.workers.dev" },
      "http://127.0.0.1:1234/callback",
    );

    expect(manifest).toMatchObject({
      url: "https://github.com/LoriKarikari/jitney",
      hook_attributes: {
        url: "https://jitney-example.example.workers.dev/webhooks/github",
        active: true,
      },
      redirect_url: "http://127.0.0.1:1234/callback",
      public: false,
      default_events: ["workflow_job"],
      default_permissions: { actions: "read", administration: "write", variables: "write" },
    });
  });

  it("ignores callbacks with the wrong state", async () => {
    const callback = await listenForManifestCode("expected-state", {
      workerName: "jitney-example",
      workerUrl: "https://jitney-example.example.workers.dev",
    });
    const callbackUrl = callback.startUrl.replace("/start", "/callback");

    const rejected = await fetch(`${callbackUrl}?code=wrong&state=wrong-state`);
    expect(rejected.status).toBe(400);

    const accepted = await fetch(`${callbackUrl}?code=manifest-code&state=expected-state`);
    expect(accepted.status).toBe(200);
    await expect(callback.code).resolves.toBe("manifest-code");
  });
});
