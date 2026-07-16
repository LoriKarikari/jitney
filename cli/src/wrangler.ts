import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CommandResult } from "./process.js";
import { run } from "./process.js";

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

export async function wrangler(
  args: readonly string[],
  options: { echo?: boolean; cwd?: string } = {},
): Promise<CommandResult> {
  return await run(process.execPath, [wranglerBin, ...args], options);
}

export type CloudflareAccount = { id: string; name: string };

export async function cloudflareAccounts(): Promise<CloudflareAccount[]> {
  try {
    return parseAccounts((await wrangler(["whoami", "--json"])).stdout);
  } catch {
    await wrangler(["login"], { echo: true });
    return parseAccounts((await wrangler(["whoami", "--json"])).stdout);
  }
}

function parseAccounts(output: string): CloudflareAccount[] {
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null || !("accounts" in value)) {
    throw new Error("Wrangler returned an unexpected account response");
  }
  const accounts = value.accounts;
  if (!Array.isArray(accounts)) throw new Error("Wrangler returned no Cloudflare accounts");
  return accounts.map((account) => {
    if (
      typeof account !== "object" ||
      account === null ||
      !("id" in account) ||
      !("name" in account) ||
      typeof account.id !== "string" ||
      typeof account.name !== "string"
    ) {
      throw new Error("Wrangler returned an invalid Cloudflare account");
    }
    return { id: account.id, name: account.name };
  });
}
