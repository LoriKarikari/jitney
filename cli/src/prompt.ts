import { createInterface } from "node:readline/promises";
import { Effect } from "effect";
import { tryPromise, type InstallerError, type InstallerStep } from "./errors.js";

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
    Effect.andThen(
      tryPromise(options.step, "Could not read the confirmation", async () => {
        const readline = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await readline.question(options.question);
        } finally {
          readline.close();
        }
      }),
    ),
    Effect.map((answer) => options.accept(answer.trim())),
  );
}
