import * as Cloudflare from "alchemy/Cloudflare";
import { DockerLive } from "alchemy/Docker";
import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { GitHubAppOperations, GitHubAppProvider } from "./github-app.js";
import { OrasRemoteImages, RegistryImageCopierLive } from "./oras-remote-images.js";

const DockerlessRemoteImages = OrasRemoteImages.pipe(
  Layer.provide(Layer.merge(DockerLive, RegistryImageCopierLive)),
);

const selectedProviders = Layer.mergeAll(
  Cloudflare.KV.NamespaceProvider(),
  Cloudflare.Containers.LiveContainerProvider(),
  Cloudflare.Workers.WorkerProvider(),
).pipe(Layer.provide(DockerlessRemoteImages), Layer.provideMerge(Cloudflare.CloudflareApiLive()));

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
