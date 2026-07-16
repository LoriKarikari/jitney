import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Effect, Ref, Schedule } from "effect";
import { renderWranglerConfig, validateWorkerName } from "./config.js";
import {
  ExistingWorkerError,
  InstallerError,
  tryPromise,
  trySync,
  type InstallFailure,
  type InstallerStep,
} from "./errors.js";
import {
  createGitHubApp,
  installationCount,
  openInstallation,
  type GitHubAppCredentials,
} from "./github-app.js";
import { copyRunnerImage } from "./oras.js";
import type { CommandError, CommandResult } from "./process.js";
import { cloudflareAccounts, type CloudflareAccount, wrangler } from "./wrangler.js";

type SetupState = { bootstrapDeployed: boolean; appSlug?: string };

export function deploy(options: {
  workerName: string;
  organization?: string;
}): Effect.Effect<void, InstallFailure> {
  return Effect.gen(function* () {
    const workerName = yield* trySync("argument_parsing", "The Worker name is invalid", () =>
      validateWorkerName(options.workerName),
    );
    const version = yield* packageVersion();
    const accounts = yield* cloudflareAccounts().pipe(
      Effect.mapError(
        (cause) =>
          new InstallerError({
            step: "cloudflare_authentication",
            message: "Could not authenticate with Cloudflare",
            cause,
          }),
      ),
    );
    const account = yield* selectAccount(accounts);
    const state = yield* Ref.make<SetupState>({ bootstrapDeployed: false });

    return yield* Effect.acquireUseRelease(
      tryPromise("filesystem", "Could not create a deployment workspace", () =>
        mkdtemp(join(tmpdir(), "jitney-deploy-")),
      ),
      (directory) =>
        installInDirectory({
          account,
          directory,
          options,
          state,
          version,
          workerName,
        }).pipe(
          Effect.catchAll((error) =>
            reportPartialSetup(state, workerName, options.organization).pipe(
              Effect.zipRight(Effect.fail(error)),
            ),
          ),
        ),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });
}

function installInDirectory(input: {
  account: CloudflareAccount;
  directory: string;
  options: { workerName: string; organization?: string };
  state: Ref.Ref<SetupState>;
  version: string;
  workerName: string;
}): Effect.Effect<void, InstallFailure> {
  const { account, directory, options, state, version, workerName } = input;
  const configPath = join(directory, "wrangler.json");
  const secretsPath = join(directory, "secrets.json");
  const destination = `registry.cloudflare.com/${account.id}/jitney:${version}`;

  return Effect.gen(function* () {
    yield* writeConfig(configPath, {
      accountId: account.id,
      image: destination,
      workerName,
      configured: false,
    });
    yield* assertWorkerAbsent(configPath, workerName);

    yield* Effect.sync(() =>
      console.log(`Copying Jitney ${version} into your Cloudflare registry...`),
    );
    yield* copyRunnerImage({ accountId: account.id, configPath, version });

    yield* Effect.sync(() => console.log(`Deploying bootstrap Worker ${workerName}...`));
    const bootstrap = yield* command(
      "worker_deployment",
      "Could not deploy the bootstrap Worker",
      wrangler(["deploy", "--config", configPath], { echo: true }),
    );
    yield* Ref.update(state, (current) => ({ ...current, bootstrapDeployed: true }));
    const workerUrl = yield* trySync(
      "worker_deployment",
      "Wrangler did not report a workers.dev URL",
      () => deploymentUrl(`${bootstrap.stdout}\n${bootstrap.stderr}`),
    );

    const credentials = yield* createGitHubApp({
      workerName,
      workerUrl,
      ...(options.organization === undefined ? {} : { organization: options.organization }),
    });
    yield* Ref.update(state, (current) => ({ ...current, appSlug: credentials.slug }));
    yield* storeSecrets(secretsPath, configPath, workerName, credentials);

    yield* writeConfig(configPath, {
      accountId: account.id,
      image: destination,
      workerName,
      configured: true,
    });
    yield* Effect.sync(() => console.log("Enabling webhooks and reconciliation..."));
    yield* command(
      "worker_deployment",
      "Could not enable the configured Worker",
      wrangler(["deploy", "--config", configPath], { echo: true }),
    );

    yield* Effect.sync(() =>
      console.log(
        "Opening GitHub to install the App. Choose the private repositories that may use Jitney.",
      ),
    );
    yield* openInstallation(credentials);
    yield* waitForInstallation(credentials);

    yield* Effect.sync(() => {
      console.log(`\nJitney is ready at ${workerUrl}`);
      console.log("Use `runs-on: jitney` in an installed private repository.");
    });
  });
}

function assertWorkerAbsent(
  configPath: string,
  workerName: string,
): Effect.Effect<void, InstallerError | ExistingWorkerError> {
  return wrangler(["deployments", "list", "--name", workerName, "--config", configPath]).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        /does not exist|code: 10007/.test(error.output)
          ? Effect.void
          : Effect.fail(
              new InstallerError({
                step: "existing_worker_check",
                message: "Could not check whether the Worker already exists",
                cause: error,
              }),
            ),
      onSuccess: () => Effect.fail(new ExistingWorkerError({ workerName })),
    }),
  );
}

function storeSecrets(
  secretsPath: string,
  configPath: string,
  workerName: string,
  credentials: GitHubAppCredentials,
): Effect.Effect<void, InstallerError> {
  return Effect.gen(function* () {
    yield* tryPromise("secret_storage", "Could not write temporary Worker secrets", () =>
      writeFile(
        secretsPath,
        JSON.stringify({
          GITHUB_APP_ID: credentials.appId,
          GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
          GITHUB_WEBHOOK_SECRET: credentials.webhookSecret,
        }),
        { mode: 0o600 },
      ),
    );
    yield* tryPromise("secret_storage", "Could not protect temporary Worker secrets", () =>
      chmod(secretsPath, 0o600),
    );
    yield* command(
      "secret_storage",
      "Could not store the GitHub App credentials in Cloudflare",
      wrangler(["secret", "bulk", secretsPath, "--name", workerName, "--config", configPath], {
        echo: true,
      }),
    );
  });
}

function packageVersion(): Effect.Effect<string, InstallerError> {
  return tryPromise("filesystem", "Could not read the Jitney package version", () =>
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).pipe(
    Effect.flatMap((contents) =>
      trySync("filesystem", "Jitney package version is missing", () => {
        const value: unknown = JSON.parse(contents);
        if (
          typeof value !== "object" ||
          value === null ||
          !("version" in value) ||
          typeof value.version !== "string"
        ) {
          throw new TypeError("missing package version");
        }
        return value.version;
      }),
    ),
  );
}

function selectAccount(
  accounts: CloudflareAccount[],
): Effect.Effect<CloudflareAccount, InstallerError> {
  if (accounts.length === 0) {
    return Effect.fail(
      new InstallerError({
        step: "cloudflare_account_selection",
        message: "Your Cloudflare login has no accounts",
      }),
    );
  }
  if (accounts.length === 1) return Effect.succeed(accounts[0]!);
  return Effect.gen(function* () {
    yield* Effect.sync(() => {
      console.log("Cloudflare accounts:");
      accounts.forEach((account, index) => console.log(`  ${index + 1}. ${account.name}`));
    });
    const answer = yield* tryPromise(
      "cloudflare_account_selection",
      "Could not read the Cloudflare account selection",
      () => waitForEnter("Choose an account number: "),
    );
    const selected = accounts[Number(answer) - 1];
    if (selected === undefined) {
      return yield* Effect.fail(
        new InstallerError({
          step: "cloudflare_account_selection",
          message: "Invalid Cloudflare account selection",
        }),
      );
    }
    return selected;
  });
}

function waitForInstallation(
  credentials: GitHubAppCredentials,
): Effect.Effect<void, InstallerError> {
  const pending = new InstallerError({
    step: "github_app_installation",
    message: "The GitHub App has not been installed yet",
  });
  const check = installationCount(credentials).pipe(
    Effect.flatMap((count) => (count > 0 ? Effect.void : Effect.fail(pending))),
  );
  return Effect.sync(() => process.stdout.write("Waiting for the GitHub App installation")).pipe(
    Effect.zipRight(
      check.pipe(
        Effect.retry(Schedule.spaced("5 seconds").pipe(Schedule.intersect(Schedule.recurs(119)))),
      ),
    ),
    Effect.tap(() => Effect.sync(() => process.stdout.write(" done\n"))),
  );
}

function reportPartialSetup(
  state: Ref.Ref<SetupState>,
  workerName: string,
  organization?: string,
): Effect.Effect<void> {
  return Ref.get(state).pipe(
    Effect.flatMap((current) =>
      Effect.sync(() => {
        console.error(`\nSetup stopped. The Worker name is ${workerName}.`);
        if (current.bootstrapDeployed) {
          console.error(
            `To remove the partial deployment: npx wrangler delete ${workerName} --force`,
          );
        }
        if (current.appSlug !== undefined) {
          const settingsUrl = organization
            ? `https://github.com/organizations/${organization}/settings/apps/${current.appSlug}`
            : `https://github.com/settings/apps/${current.appSlug}`;
          console.error(`Delete the partial GitHub App at ${settingsUrl}`);
        }
      }),
    ),
  );
}

function writeConfig(
  configPath: string,
  config: Parameters<typeof renderWranglerConfig>[0],
): Effect.Effect<void, InstallerError> {
  return tryPromise("filesystem", "Could not write the Wrangler configuration", () =>
    writeFile(configPath, renderWranglerConfig(config)),
  );
}

function command<A extends CommandResult>(
  step: InstallerStep,
  message: string,
  effect: Effect.Effect<A, CommandError>,
): Effect.Effect<A, InstallerError> {
  return effect.pipe(Effect.mapError((cause) => new InstallerError({ step, message, cause })));
}

async function waitForEnter(prompt: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

export function deploymentUrl(output: string): string {
  const match = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  if (match === null) throw new Error("missing workers.dev URL");
  return match[0];
}
