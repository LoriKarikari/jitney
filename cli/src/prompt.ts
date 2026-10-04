import { createInterface } from "node:readline";
import { Effect } from "effect";
import { InstallerError, type InstallerStep } from "./errors.js";

/**
 * Print a rendered plan, ask one question on the terminal, and interpret the
 * answer. `accept` decides what counts as consent (a `y`, a typed name, ...).
 */
export function confirmInTerminal(options: {
  readonly step: InstallerStep;
  readonly render: string;
  readonly question: string;
  readonly accept: (answer: string) => boolean;
}): Effect.Effect<boolean, InstallerError> {
  return Effect.sync(() => console.log(options.render)).pipe(
    Effect.andThen(readAnswer(options.question)),
    Effect.flatMap((answer) =>
      answer === undefined
        ? Effect.fail(
            new InstallerError({
              step: options.step,
              message:
                "Standard input closed before an answer. Pass --yes to skip the confirmation",
            }),
          )
        : Effect.succeed(options.accept(answer.trim())),
    ),
  );
}

// readline/promises `question()` never settles when input ends, and misses a
// last line without a newline, so read the `line` and `close` events directly.
const readAnswer = (question: string) =>
  Effect.callback<string | undefined>((resume) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string | undefined;
    readline.once("line", (line) => {
      answer = line;
      readline.close();
    });
    readline.once("close", () => resume(Effect.succeed(answer)));
    readline.setPrompt(question);
    readline.prompt();
    return Effect.sync(() => readline.close());
  });
