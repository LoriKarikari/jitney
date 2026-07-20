import { Docker } from "alchemy/Docker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import { PlatformError, SystemError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import type { InstallerError } from "../errors.js";
import { copyImage } from "../oras.js";

interface ImageCopyInput {
  source: string;
  destination: string;
  registryHost: string;
  username: string;
  password: string;
}

export class RegistryImageCopier extends Context.Service<
  RegistryImageCopier,
  {
    copy(input: ImageCopyInput): Effect.Effect<void, InstallerError>;
  }
>()("Jitney.RegistryImageCopier") {}

export const RegistryImageCopierLive = Layer.succeed(RegistryImageCopier, {
  copy: copyImage,
});

type ImageService = Docker["Service"]["image"];
type RemoteImageMethods = Pick<ImageService, "pull" | "push" | "tag">;

const succeeded = {
  exitCode: ExitCode(0),
  stdout: "",
  stderr: "",
};

export const makeOrasRemoteImageMethods: Effect.Effect<
  RemoteImageMethods,
  never,
  RegistryImageCopier
> = Effect.gen(function* () {
  const copier = yield* RegistryImageCopier;
  const tags = yield* Ref.make(HashMap.empty<string, string>());

  return {
    pull: () => Effect.succeed(succeeded),
    tag: (source, target) =>
      Ref.update(tags, HashMap.set(target, source)).pipe(Effect.as(succeeded)),
    push: (destination, credentials) =>
      Ref.get(tags).pipe(
        Effect.flatMap((tagged) => {
          const source = HashMap.get(tagged, destination);
          if (source._tag === "None") {
            return Effect.fail(
              platformError("push", destination, "Image must be tagged before it is pushed"),
            );
          }
          return copier
            .copy({
              source: source.value,
              destination,
              registryHost: credentials.server,
              username: credentials.username,
              password:
                typeof credentials.password === "string"
                  ? credentials.password
                  : Redacted.value(credentials.password),
            })
            .pipe(
              Effect.as(succeeded),
              Effect.mapError((cause) =>
                platformError("push", destination, "ORAS image copy failed", cause),
              ),
            );
        }),
      ),
  };
});

export const OrasRemoteImages = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const docker = yield* Docker;
    const remote = yield* makeOrasRemoteImageMethods;
    return {
      ...docker,
      image: {
        ...docker.image,
        ...remote,
      },
    };
  }),
);

function platformError(
  method: string,
  pathOrDescriptor: string,
  description: string,
  cause?: unknown,
): PlatformError {
  return new PlatformError(
    new SystemError({
      _tag: "Unknown",
      module: "ORAS",
      method,
      pathOrDescriptor,
      description,
      cause,
    }),
  );
}
