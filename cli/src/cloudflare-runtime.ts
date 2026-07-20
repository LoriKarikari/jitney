import * as Alchemy from "alchemy";
import { AuthProviders } from "alchemy/Auth";
import * as Cloudflare from "alchemy/Cloudflare";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

export const alchemyCli = Alchemy.Cli.of({
  approvePlan: () => Effect.succeed(true),
  displayPlan: () => Effect.void,
  startApplySession: () =>
    Effect.succeed({
      emit: () => Effect.void,
      done: () => Effect.void,
    }),
});

const platformRuntime = Layer.merge(PlatformServices, FetchHttpClient.layer);
const commandRuntime = Layer.merge(platformRuntime, Layer.succeed(AuthProviders, {}));

export const cloudflareRuntime = Cloudflare.CloudflareApiLive().pipe(
  Layer.provideMerge(commandRuntime),
);
