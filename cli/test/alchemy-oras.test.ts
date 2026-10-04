import { Effect, Layer, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeOrasRemoteImageMethods,
  RegistryImageCopier,
} from "../src/alchemy/oras-remote-images.js";

describe("Alchemy remote container images", () => {
  it("copies a tagged remote image with ORAS instead of Docker", async () => {
    const calls = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make<
          {
            source: string;
            destination: string;
            registryHost: string;
            username: string;
            password: string;
          }[]
        >([]);
        const copier = Layer.succeed(RegistryImageCopier, {
          copy: (input) => Ref.update(calls, (current) => [...current, input]),
        });
        const image = yield* makeOrasRemoteImageMethods.pipe(Effect.provide(copier));

        yield* image.pull("ghcr.io/lorikarikari/jitney:0.3.0", "linux/amd64");
        yield* image.tag(
          "ghcr.io/lorikarikari/jitney:0.3.0",
          "registry.cloudflare.com/account/jitney:hash",
        );
        yield* image.push("registry.cloudflare.com/account/jitney:hash", {
          server: "registry.cloudflare.com",
          username: "account",
          password: "secret",
        });

        return yield* Ref.get(calls);
      }),
    );

    expect(calls).toEqual([
      {
        source: "ghcr.io/lorikarikari/jitney:0.3.0",
        destination: "registry.cloudflare.com/account/jitney:hash",
        registryHost: "registry.cloudflare.com",
        username: "account",
        password: "secret",
      },
    ]);
  });
});
