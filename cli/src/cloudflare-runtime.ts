import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Alchemy from "alchemy";
import { AuthProviders } from "alchemy/Auth";
import * as Cloudflare from "alchemy/Cloudflare";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";

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

export interface CloudflareServices {
  readonly client: HttpClient.HttpClient;
  readonly provide: <A, E>(
    effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E>;
}

/**
 * Capture the ambient Cloudflare credentials and HTTP client once so platform
 * factories can hand fully-provided effects to their service methods.
 */
export const captureCloudflareServices: Effect.Effect<
  CloudflareServices,
  never,
  Credentials | HttpClient.HttpClient
> = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const client = yield* HttpClient.HttpClient;
  return {
    client,
    provide: (effect) =>
      effect.pipe(
        Effect.provideService(Credentials, credentials),
        Effect.provideService(HttpClient.HttpClient, client),
      ),
  };
});
