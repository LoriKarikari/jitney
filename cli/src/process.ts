import { spawn } from "node:child_process";
import { Data, Effect } from "effect";

export type CommandResult = { stdout: string; stderr: string };

export class CommandError extends Data.TaggedError("CommandError")<{
  command: string;
  exitCode?: number;
  output: string;
  cause?: unknown;
}> {}

export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; echo?: boolean } = {},
): Effect.Effect<CommandResult, CommandError> {
  return Effect.async<CommandResult, CommandError>((resume) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (options.echo) process.stderr.write(chunk);
    });
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      resume(
        Effect.fail(
          new CommandError({
            command: [command, ...args].join(" "),
            output: stderr || stdout,
            cause,
          }),
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resume(Effect.succeed({ stdout, stderr }));
      } else {
        resume(
          Effect.fail(
            new CommandError({
              command: [command, ...args].join(" "),
              ...(code === null ? {} : { exitCode: code }),
              output: stderr || stdout,
            }),
          ),
        );
      }
    });
    return Effect.sync(() => child.kill("SIGTERM"));
  });
}
