#!/usr/bin/env node

import { parseArgs } from "node:util";
import { deploy } from "./deploy.js";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string", default: "jitney" },
      organization: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`Usage: jitney deploy [options]

Options:
  --name <name>                Cloudflare Worker name (default: jitney)
  --organization <login>       Register the GitHub App under an organization
  -h, --help                   Show this help`);
    return;
  }

  if (positionals.length !== 1 || positionals[0] !== "deploy") {
    throw new Error(`Unknown command: ${positionals.join(" ")}`);
  }

  await deploy({
    workerName: values.name,
    ...(values.organization === undefined ? {} : { organization: values.organization }),
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
