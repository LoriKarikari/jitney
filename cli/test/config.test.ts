import { describe, expect, it } from "vitest";
import { parseConcurrencyBudget, validateWorkerName } from "../src/config.js";

describe("validateWorkerName", () => {
  it.each(["jitney", "jitney-example", "j1"])("accepts %s", (name) => {
    expect(validateWorkerName(name)).toBe(name);
  });

  it.each(["Jitney", "1jitney", "jitney_example", `j${"x".repeat(50)}`])("rejects %s", (name) => {
    expect(() => validateWorkerName(name)).toThrow("Worker name");
  });
});

describe("parseConcurrencyBudget", () => {
  it.each([
    ["1", 1],
    ["20", 20],
  ])("accepts %s", (value, budget) => {
    expect(parseConcurrencyBudget(value)).toBe(budget);
  });

  it.each(["0", "-4", "2.5", "four", ""])("rejects %s", (value) => {
    expect(() => parseConcurrencyBudget(value)).toThrow("--budget");
  });
});
