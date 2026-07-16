import { describe, expect, it } from "vitest";
import { githubAppManifest } from "../src/github-app.js";

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
      default_permissions: { actions: "read", administration: "write" },
    });
  });
});
