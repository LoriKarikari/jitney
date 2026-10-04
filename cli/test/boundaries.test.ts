// Failure modes this file guards. The live checks in e2e/ cannot reach them cheaply.
// 1. A failed subprocess escapes the Effect error channel and crashes the CLI instead of
//    reporting the step that failed.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { run } from "../src/process.js";
describe("subprocess boundary", () => {
  it("returns command failures through the Effect error channel", async () => {
    const exit = await Effect.runPromiseExit(
      run(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(2)"]),
    );
    expect(exit._tag).toBe("Failure");
  });
});
