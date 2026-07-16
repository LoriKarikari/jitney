#!/usr/bin/env node

import { parseArgs } from "node:util";
import { Cause, Effect, Exit, Option } from "effect";
import { deploy } from "./deploy.js";
import { InstallerError, renderFailure, trySync, type InstallFailure } from "./errors.js";

const program = Effect.gen(function* () {
  const { positionals, values } = yield* trySync(
    "argument_parsing",
    "Could not parse command-line arguments",
    () =>
      parseArgs({
        allowPositionals: true,
        options: {
          name: { type: "string", default: "jitney" },
          organization: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
  );

  if (values.help || positionals.length === 0) {
    yield* Effect.sync(() =>
      console.log(`Usage: jitney deploy [options]

Options:
  --name <name>                Cloudflare Worker name (default: jitney)
  --organization <login>       Register the GitHub App under an organization
  -h, --help                   Show this help`),
    );
    return;
  }

  if (positionals.length !== 1 || positionals[0] !== "deploy") {
    return yield* Effect.fail(
      new InstallerError({
        step: "argument_parsing",
        message: `Unknown command: ${positionals.join(" ")}`,
      }),
    );
  }

  yield* deploy({
    workerName: values.name,
    ...(values.organization === undefined ? {} : { organization: values.organization }),
  });
});

const exit = await Effect.runPromiseExit(program);
Exit.match(exit, {
  onSuccess: () => undefined,
  onFailure: (cause) => {
    const failure = Cause.failureOption(cause);
    console.error(
      Option.isSome(failure) && isInstallFailure(failure.value)
        ? renderFailure(failure.value)
        : Cause.pretty(cause),
    );
    process.exitCode = 1;
  },
});

function isInstallFailure(error: unknown): error is InstallFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "InstallerError" || error._tag === "ExistingWorkerError")
  );
}
