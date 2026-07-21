import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { InstallerError, tryPromise } from "../errors.js";

/** Run Alchemy from Jitney's private cache, never the caller's project. */
export const withAlchemyWorkspace = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InstallerError, R> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = process.cwd();
      const workspace = join(homedir(), ".cache", "jitney", "alchemy");
      yield* tryPromise("filesystem", "Could not prepare the Alchemy workspace", () =>
        mkdir(workspace, { recursive: true }),
      );
      yield* Effect.sync(() => process.chdir(workspace));
      return previous;
    }),
    () => effect,
    (previous) => Effect.sync(() => process.chdir(previous)),
  );
