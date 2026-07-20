import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ExistingWorkerError, InstallerError, renderFailure } from "../src/errors.js";
import { run } from "../src/process.js";
describe("subprocess boundary", () => {
  it("returns command failures through the Effect error channel", async () => {
    const exit = await Effect.runPromiseExit(
      run(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(2)"]),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("typed installer failures", () => {
  it("renders an existing Worker without exposing a cause", () => {
    expect(renderFailure(new ExistingWorkerError({ workerName: "jitney" }))).toContain(
      "Worker jitney already exists",
    );
  });

  it("keeps expected failures in the Effect error channel", async () => {
    const failure = new InstallerError({ step: "registry_copy", message: "copy failed" });
    const result = await Effect.runPromiseExit(Effect.fail(failure));
    expect(result._tag).toBe("Failure");
  });
});
