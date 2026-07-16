import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { renderWranglerConfig, validateWorkerName } from "./config.js";
import {
  createGitHubApp,
  installationCount,
  openInstallation,
  type GitHubAppCredentials,
} from "./github-app.js";
import { copyRunnerImage } from "./oras.js";
import { cloudflareAccounts, type CloudflareAccount, wrangler } from "./wrangler.js";

export async function deploy(options: {
  workerName: string;
  organization?: string;
}): Promise<void> {
  const workerName = validateWorkerName(options.workerName);
  const version = await packageVersion();
  const account = await selectAccount(await cloudflareAccounts());
  const directory = await mkdtemp(join(tmpdir(), "jitney-deploy-"));
  const configPath = join(directory, "wrangler.json");
  const secretsPath = join(directory, "secrets.json");
  let bootstrapDeployed = false;
  let createdAppSlug: string | undefined;

  try {
    const destination = `registry.cloudflare.com/${account.id}/jitney:${version}`;
    await writeFile(
      configPath,
      renderWranglerConfig({
        accountId: account.id,
        image: destination,
        workerName,
        configured: false,
      }),
    );

    await assertWorkerAbsent(configPath, workerName);

    console.log(`Copying Jitney ${version} into your Cloudflare registry...`);
    await copyRunnerImage({ accountId: account.id, configPath, version });

    console.log(`Deploying bootstrap Worker ${workerName}...`);
    const bootstrap = await wrangler(["deploy", "--config", configPath], { echo: true });
    bootstrapDeployed = true;
    const workerUrl = deploymentUrl(`${bootstrap.stdout}\n${bootstrap.stderr}`);

    const credentials = await createGitHubApp({
      workerName,
      workerUrl,
      ...(options.organization === undefined ? {} : { organization: options.organization }),
    });
    createdAppSlug = credentials.slug;
    await storeSecrets(secretsPath, configPath, workerName, credentials);

    await writeFile(
      configPath,
      renderWranglerConfig({
        accountId: account.id,
        image: destination,
        workerName,
        configured: true,
      }),
    );
    console.log("Enabling webhooks and reconciliation...");
    await wrangler(["deploy", "--config", configPath], { echo: true });

    console.log(
      "Opening GitHub to install the App. Choose the private repositories that may use Jitney.",
    );
    await openInstallation(credentials);
    await waitForInstallation(credentials);

    console.log(`\nJitney is ready at ${workerUrl}`);
    console.log("Use `runs-on: jitney` in an installed private repository.");
  } catch (error) {
    console.error(`\nSetup stopped. The Worker name is ${workerName}.`);
    if (bootstrapDeployed) {
      console.error(`To remove the partial deployment: npx wrangler delete ${workerName} --force`);
    }
    if (createdAppSlug !== undefined) {
      const settingsUrl = options.organization
        ? `https://github.com/organizations/${options.organization}/settings/apps/${createdAppSlug}`
        : `https://github.com/settings/apps/${createdAppSlug}`;
      console.error(`Delete the partial GitHub App at ${settingsUrl}`);
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertWorkerAbsent(configPath: string, workerName: string): Promise<void> {
  try {
    await wrangler(["deployments", "list", "--name", workerName, "--config", configPath]);
  } catch (error) {
    if (error instanceof Error && /does not exist|code: 10007/.test(error.message)) return;
    throw error;
  }
  throw new Error(
    `Worker ${workerName} already exists. Choose another --name; upgrades are not supported yet.`,
  );
}

async function storeSecrets(
  secretsPath: string,
  configPath: string,
  workerName: string,
  credentials: GitHubAppCredentials,
): Promise<void> {
  await writeFile(
    secretsPath,
    JSON.stringify({
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
      GITHUB_WEBHOOK_SECRET: credentials.webhookSecret,
    }),
    { mode: 0o600 },
  );
  await chmod(secretsPath, 0o600);
  await wrangler(["secret", "bulk", secretsPath, "--name", workerName, "--config", configPath], {
    echo: true,
  });
}

async function packageVersion(): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("Jitney package version is missing");
  }
  return value.version;
}

async function selectAccount(accounts: CloudflareAccount[]): Promise<CloudflareAccount> {
  if (accounts.length === 0) throw new Error("Your Cloudflare login has no accounts");
  if (accounts.length === 1) return accounts[0]!;
  console.log("Cloudflare accounts:");
  accounts.forEach((account, index) => console.log(`  ${index + 1}. ${account.name}`));
  const answer = await waitForEnter("Choose an account number: ");
  const selected = accounts[Number(answer) - 1];
  if (selected === undefined) throw new Error("Invalid Cloudflare account selection");
  return selected;
}

async function waitForEnter(prompt: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

async function waitForInstallation(credentials: GitHubAppCredentials): Promise<void> {
  process.stdout.write("Waiting for the GitHub App installation");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await installationCount(credentials)) > 0) {
      process.stdout.write(" done\n");
      return;
    }
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Timed out waiting for the GitHub App installation");
}

function deploymentUrl(output: string): string {
  const match = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  if (match === null) throw new Error("Wrangler did not report a workers.dev URL");
  return match[0];
}
