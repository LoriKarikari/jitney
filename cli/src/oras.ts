import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { x as extractTar } from "tar";
import { InstallerError, tryPromise } from "./errors.js";
import { run } from "./process.js";

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

interface RegistryAuth {
  readonly registryHost: string;
  readonly username: string;
  readonly password: string;
}

const withRegistryAuth = <A>(
  auth: RegistryAuth,
  use: (oras: string, authPath: string) => Effect.Effect<A, InstallerError>,
): Effect.Effect<A, InstallerError> =>
  Effect.gen(function* () {
    const oras = yield* tryPromise(
      "oras_download",
      "Could not prepare the ORAS client",
      ensureOras,
    );
    return yield* Effect.acquireUseRelease(
      tryPromise("filesystem", "Could not create a registry credential directory", () =>
        mkdtemp(join(tmpdir(), "jitney-registry-")),
      ),
      (directory) =>
        Effect.gen(function* () {
          const authPath = join(directory, "auth.json");
          const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
          yield* tryPromise("filesystem", "Could not write temporary registry credentials", () =>
            writeFile(
              authPath,
              JSON.stringify({ auths: { [auth.registryHost]: { auth: encoded } } }),
              { mode: 0o600 },
            ),
          );
          return yield* use(oras, authPath);
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });

export function copyImage(
  options: RegistryAuth & {
    source: string;
    destination: string;
  },
): Effect.Effect<void, InstallerError> {
  return withRegistryAuth(options, (oras, authPath) =>
    run(
      oras,
      [
        "cp",
        "--platform",
        "linux/amd64",
        "--to-registry-config",
        authPath,
        "--no-tty",
        options.source,
        options.destination,
      ],
      { echo: true },
    ).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new InstallerError({
            step: "registry_copy",
            message: "Could not copy the runner image into Cloudflare",
            cause,
          }),
      ),
    ),
  );
}

export function deleteImage(
  options: RegistryAuth & {
    image: string;
  },
): Effect.Effect<void, InstallerError> {
  return withRegistryAuth(options, (oras, authPath) =>
    run(oras, ["manifest", "delete", "--force", "--registry-config", authPath, options.image], {
      echo: true,
    }).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new InstallerError({
            step: "registry_cleanup",
            message: `Could not remove runner image ${options.image}`,
            cause,
          }),
      ),
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
