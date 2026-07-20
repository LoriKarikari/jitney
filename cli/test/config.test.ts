import { describe, expect, it } from "vitest";
import { validateWorkerName } from "../src/config.js";

describe("validateWorkerName", () => {
  it.each(["jitney", "jitney-example", "j1"])("accepts %s", (name) => {
    expect(validateWorkerName(name)).toBe(name);
  });

  it.each(["Jitney", "1jitney", "jitney_example", `j${"x".repeat(50)}`])("rejects %s", (name) => {
    expect(() => validateWorkerName(name)).toThrow("Worker name");
  });
});
