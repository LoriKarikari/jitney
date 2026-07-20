import { layerRuntime } from "@distilled.cloud/cloudflare-runtime";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { DockerLive } from "alchemy/Docker";
import * as Provider from "alchemy/Provider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Path from "effect/Path";
import { GitHubAppOperations, GitHubAppProvider } from "./github-app.js";
import { OrasRemoteImages, RegistryImageCopierLive } from "./oras-remote-images.js";

const DockerlessRemoteImages = OrasRemoteImages.pipe(
  Layer.provide(Layer.merge(DockerLive, RegistryImageCopierLive)),
);

// Alchemy's selected live Worker and Container providers require this local
// runtime state even during live deploys, but beta.63 does not export its tag.
// Recreate the documented zero state under the same Context key until Alchemy
// exposes the layer used by Cloudflare.providers().
class LocalRuntimeState extends Context.Service<
  LocalRuntimeState,
  {
    readonly queues: MutableHashMap.MutableHashMap<string, unknown>;
    readonly queueConsumers: MutableHashMap.MutableHashMap<string, unknown>;
    readonly workerRestarts: MutableHashMap.MutableHashMap<string, Effect.Effect<void>>;
  }
>()("alchemy/cloudflare/LocalRuntimeState") {}

const LocalRuntimeStateLive = Layer.succeed(LocalRuntimeState, {
  queues: MutableHashMap.empty<string, unknown>(),
  queueConsumers: MutableHashMap.empty<string, unknown>(),
  workerRestarts: MutableHashMap.empty<string, Effect.Effect<void>>(),
});

const CloudflareRuntimeServices = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* Cloudflare.CloudflareEnvironment;
    const { dotAlchemy } = yield* Alchemy.AlchemyContext;
    const path = yield* Path.Path;
    return layerRuntime({
      api: { accountId: environment.pipe(Effect.map(({ accountId }) => accountId)) },
      storage: { directory: path.join(dotAlchemy, "local") },
    });
  }),
);

const selectedProviders = Layer.mergeAll(
  Cloudflare.KV.NamespaceProvider(),
  Cloudflare.Containers.LiveContainerProvider(),
  Cloudflare.Workers.WorkerProvider(),
).pipe(
  Layer.provide(DockerlessRemoteImages),
  Layer.provide(LocalRuntimeStateLive),
  Layer.provideMerge(CloudflareRuntimeServices),
  Layer.provideMerge(Cloudflare.CloudflareApiLive()),
);

export const JitneyCloudflareProviders = Layer.effect(
  Cloudflare.Providers,
  Provider.collection([
    // Alchemy beta.63's ResourceClass has an exact-optional mismatch with collection().
    // @ts-expect-error upstream beta type mismatch
    Cloudflare.KV.Namespace,
    Cloudflare.Containers.ContainerPlatform,
    Cloudflare.Workers.Worker,
  ]),
).pipe(Layer.provide(selectedProviders), Layer.orDie);

export const jitneyProviders = (githubOperations: Layer.Layer<GitHubAppOperations>) =>
  Layer.merge(JitneyCloudflareProviders, GitHubAppProvider.pipe(Layer.provide(githubOperations)));
