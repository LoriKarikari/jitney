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
