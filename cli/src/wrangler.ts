import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import type { CommandResult } from "./process.js";
import { run, type CommandError } from "./process.js";

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

export function wrangler(
  args: readonly string[],
  options: { echo?: boolean; cwd?: string } = {},
): Effect.Effect<CommandResult, CommandError> {
  return run(process.execPath, [wranglerBin, ...args], options);
}

export type CloudflareAccount = { id: string; name: string };

const AccountsResponse = Schema.Struct({
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

export function cloudflareAccounts(): Effect.Effect<
  CloudflareAccount[],
  CommandError | SyntaxError
> {
  const whoami = wrangler(["whoami", "--json"]).pipe(
    Effect.flatMap(({ stdout }) =>
      Effect.try({
        try: () => parseAccounts(stdout),
        catch: () => new SyntaxError("Wrangler returned invalid account JSON"),
      }),
    ),
  );
  return whoami.pipe(
    Effect.catchTag("CommandError", () =>
      wrangler(["login"], { echo: true }).pipe(Effect.zipRight(whoami)),
    ),
  );
}

export function parseAccounts(output: string): CloudflareAccount[] {
  const decoded = Schema.decodeUnknownSync(AccountsResponse)(JSON.parse(output));
  return decoded.accounts.map(({ id, name }) => ({ id, name }));
}
