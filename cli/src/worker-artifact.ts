import { createHash, timingSafeEqual } from "node:crypto";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { Effect, Schema } from "effect";
import { InstallerError, tryPromise, trySync } from "./errors.js";

const PackageVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const PackageMetadata = Schema.Struct({
  dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.String }),
});

export const downloadWorkerBundle = (version: string): Effect.Effect<string, InstallerError> =>
  Effect.gen(function* () {
    if (!PackageVersion.test(version)) {
      return yield* new InstallerError({
        step: "upgrade",
        message: `Invalid Jitney version: ${version}`,
      });
    }
    const directory = join(homedir(), ".cache", "jitney", "versions", version);
    const bundle = join(directory, "package", "assets", "worker", "index.js");
    const cached = yield* tryPromise("filesystem", "Could not inspect the Worker bundle cache", () =>
      access(bundle).then(
        () => true,
        () => false,
      ),
    );
    if (cached) return bundle;

    const metadata = yield* tryPromise("upgrade", `Could not resolve get-jitney ${version}`, () =>
      fetch(`https://registry.npmjs.org/get-jitney/${version}`).then(async (response) => {
        if (!response.ok) throw new Error(`npm returned ${response.status}`);
        return response.json();
      }),
    ).pipe(
      Effect.flatMap((value) =>
        trySync("upgrade", `npm returned invalid metadata for get-jitney ${version}`, () =>
          Schema.decodeUnknownSync(PackageMetadata)(value),
        ),
      ),
    );
    const archive = yield* tryPromise("upgrade", `Could not download get-jitney ${version}`, () =>
      fetch(metadata.dist.tarball).then(async (response) => {
        if (!response.ok) throw new Error(`npm returned ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      }),
    );
    const [algorithm, encoded] = metadata.dist.integrity.split("-", 2);
    if (algorithm !== "sha512" || encoded === undefined) {
      return yield* new InstallerError({
        step: "upgrade",
        message: `get-jitney ${version} has an unsupported npm integrity digest`,
      });
    }
    const expected = Buffer.from(encoded, "base64");
    const actual = createHash("sha512").update(archive).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return yield* new InstallerError({
        step: "upgrade",
        message: `get-jitney ${version} failed npm integrity verification`,
      });
    }

    const archivePath = join(directory, "package.tgz");
    yield* tryPromise("filesystem", "Could not unpack the previous Worker bundle", async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(archivePath, archive, { mode: 0o600 });
      try {
        await extract({ file: archivePath, cwd: directory });
        await access(bundle);
      } finally {
        await unlink(archivePath).catch(() => undefined);
      }
    });
    return bundle;
  });
