import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { x as extractTar } from "tar";
import { InstallerError, tryPromise, trySync } from "./errors.js";
import { run } from "./process.js";
import { wrangler } from "./wrangler.js";

const ORAS_VERSION = "1.3.3";
const ORAS_RELEASE = `https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}`;
const ORAS_CHECKSUMS: Record<string, string> = {
  "oras_1.3.3_darwin_amd64.tar.gz":
    "aeb684d8c24c18dce28fd1f7326636e4782b573108e244a93d4b1c4a5ec50f48",
  "oras_1.3.3_darwin_arm64.tar.gz":
    "f33fc12753c54172b0d0d19eaa0318d3f90fe9b094d96e8b259c881713c92e1c",
  "oras_1.3.3_linux_amd64.tar.gz":
    "9ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59",
  "oras_1.3.3_linux_arm64.tar.gz":
    "ac7156f93a21e903f7ad606c792f3560f17e0cd0e36365634701b1e7cc4e4eca",
};

const RegistryCredentials = Schema.Struct({
  account_id: Schema.String,
  registry_host: Schema.String,
  username: Schema.String,
  password: Schema.String,
});
type RegistryCredentials = typeof RegistryCredentials.Type;

export function copyRunnerImage(options: {
  accountId: string;
  configPath: string;
  version: string;
}): Effect.Effect<string, InstallerError> {
  return Effect.gen(function* () {
    const oras = yield* tryPromise(
      "oras_download",
      "Could not prepare the ORAS client",
      ensureOras,
    );
    const credentials = yield* registryCredentials(options.configPath);
    if (credentials.account_id !== options.accountId) {
      return yield* Effect.fail(
        new InstallerError({
          step: "registry_copy",
          message: "Cloudflare issued registry credentials for the wrong account",
        }),
      );
    }
    if (credentials.registry_host !== "registry.cloudflare.com") {
      return yield* Effect.fail(
        new InstallerError({
          step: "registry_copy",
          message: "Cloudflare issued credentials for an unexpected registry",
        }),
      );
    }

    return yield* Effect.acquireUseRelease(
      tryPromise("filesystem", "Could not create a registry credential directory", () =>
        mkdtemp(join(tmpdir(), "jitney-registry-")),
      ),
      (directory) =>
        Effect.gen(function* () {
          const authPath = join(directory, "auth.json");
          const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString(
            "base64",
          );
          yield* tryPromise("filesystem", "Could not write temporary registry credentials", () =>
            writeFile(
              authPath,
              JSON.stringify({ auths: { [credentials.registry_host]: { auth } } }),
              { mode: 0o600 },
            ),
          );
          const destination = `${credentials.registry_host}/${options.accountId}/jitney:${options.version}`;
          yield* run(
            oras,
            [
              "cp",
              "--platform",
              "linux/amd64",
              "--to-registry-config",
              authPath,
              "--no-tty",
              `ghcr.io/lorikarikari/jitney:${options.version}`,
              destination,
            ],
            { echo: true },
          ).pipe(
            Effect.mapError(
              (cause) =>
                new InstallerError({
                  step: "registry_copy",
                  message: "Could not copy the runner image into Cloudflare",
                  cause,
                }),
            ),
          );
          return destination;
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });
}

function registryCredentials(
  configPath: string,
): Effect.Effect<RegistryCredentials, InstallerError> {
  return wrangler([
    "containers",
    "registries",
    "credentials",
    "registry.cloudflare.com",
    "--push",
    "--pull",
    "--expiration-minutes=60",
    "--json",
    "--config",
    configPath,
  ]).pipe(
    Effect.mapError(
      (cause) =>
        new InstallerError({
          step: "registry_copy",
          message: "Could not obtain Cloudflare registry credentials",
          cause,
        }),
    ),
    Effect.flatMap(({ stdout }) =>
      trySync("registry_copy", "Wrangler returned invalid registry credentials", () => {
        return Schema.decodeUnknownSync(RegistryCredentials)(JSON.parse(stdout));
      }),
    ),
  );
}

async function ensureOras(): Promise<string> {
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (platform === null || arch === null) {
    throw new Error(`Jitney does not yet support ${process.platform}/${process.arch}`);
  }

  const cache = join(homedir(), ".cache", "jitney", "oras", ORAS_VERSION);
  const binary = join(cache, "oras");
  try {
    await chmod(binary, 0o755);
    return binary;
  } catch {
    // Download below.
  }

  await mkdir(cache, { recursive: true });
  const asset = `oras_${ORAS_VERSION}_${platform}_${arch}.tar.gz`;
  const archiveResponse = await fetch(`${ORAS_RELEASE}/${asset}`);
  if (!archiveResponse.ok) throw new Error("Could not download ORAS");
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const expected = ORAS_CHECKSUMS[asset];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (expected === undefined || actual !== expected)
    throw new Error("ORAS checksum verification failed");

  const directory = await mkdtemp(join(tmpdir(), "jitney-oras-"));
  const archivePath = join(directory, asset);
  const temporaryBinary = join(cache, `oras-${process.pid}.tmp`);
  try {
    await writeFile(archivePath, archive, { mode: 0o600 });
    await extractTar({ file: archivePath, cwd: directory });
    await copyFile(join(directory, "oras"), temporaryBinary);
    await chmod(temporaryBinary, 0o755);
    await rename(temporaryBinary, binary);
    return binary;
  } finally {
    await rm(temporaryBinary, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}
