import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { record } from "./src/fixture.js";

const tsx = fileURLToPath(new URL("../cli/node_modules/.bin/tsx", import.meta.url));
const probe = fileURLToPath(new URL("./src/confirm-probe.ts", import.meta.url));

const answer = (input: string | undefined) => {
  const result = spawnSync(tsx, [probe], {
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
    encoding: "utf8",
    timeout: 20_000,
  });
  return result.stdout.trim().split("\n").at(-1) ?? "nothing";
};

it("answers the repair and destroy confirmation with every kind of standard input", () => {
  const answers = {
    stdinClosed: answer(undefined),
    yes: answer("y\n"),
    yesWithoutNewline: answer("y"),
    no: answer("n\n"),
    emptyLine: answer("\n"),
  };

  const checks = record(
    "confirm-prompt",
    {
      stdinClosedAsksForYes: answers.stdinClosed.includes("Pass --yes"),
      yesConfirms: answers.yes === "confirmed=true",
      yesWithoutNewlineConfirms: answers.yesWithoutNewline === "confirmed=true",
      noDeclines: answers.no === "confirmed=false",
      emptyLineDeclines: answers.emptyLine === "confirmed=false",
    },
    answers,
  );
  expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map((key) => [key, true])));
});
