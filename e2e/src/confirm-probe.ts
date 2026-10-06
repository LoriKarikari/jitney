import { Cause, Effect, Exit } from "effect";
import { confirmInTerminal } from "../../cli/src/prompt.js";

const exit = await Effect.runPromiseExit(
  confirmInTerminal({
    step: "repair",
    render: "plan",
    question: "Apply? (y/N) ",
    accept: (answer) => answer.toLowerCase() === "y",
  }),
);
const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
process.stdout.write(
  `\n${
    Exit.isSuccess(exit)
      ? `confirmed=${exit.value}`
      : `failed: ${failure instanceof Error ? failure.message : String(failure)}`
  }\n`,
);
