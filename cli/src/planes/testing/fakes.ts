import { Effect, Layer } from "effect";
import {
  CloudflarePlane,
  type CloudflarePlaneShape,
  type ContainerApplication,
  type RegistryImage,
  type WorkerService,
} from "../cloudflare.js";
import { type InjectedFailure, ResourceNotFound } from "../errors.js";
import { FaultInjector, type FaultPlan } from "../fault-injection.js";
import {
  GitHubPlane,
  type GitHubApp,
  type GitHubInstallation,
  type GitHubPlaneShape,
} from "../github.js";
import type { ResourceReference } from "./invariants.js";

export type CloudflarePlaneFake = {
  layer: Layer.Layer<CloudflarePlane>;
  resources(): readonly ResourceReference[];
  registryLayers(repository: string): readonly string[];
};

export type GitHubPlaneFake = {
  layer: Layer.Layer<GitHubPlane>;
  resources(): readonly ResourceReference[];
};

export type CloudflareFakeSeed = {
  workers?: readonly WorkerService[];
  applications?: readonly ContainerApplication[];
  images?: readonly RegistryImage[];
  kv?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  fault?: FaultPlan;
};

export type GitHubFakeSeed = {
  apps?: readonly GitHubApp[];
  installations?: readonly GitHubInstallation[];
  variables?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  fault?: FaultPlan;
};

export function makeCloudflarePlaneFake(seed: CloudflareFakeSeed = {}): CloudflarePlaneFake {
  const fault = new FaultInjector(seed.fault);
  const workers = new Map(seed.workers?.map((worker) => [worker.name, { ...worker }]));
  const applications = new Map(
    seed.applications?.map((application) => [application.id, { ...application }]),
  );
  const images = new Map<string, Map<string, RegistryImage>>();
  const layers = new Map<string, Set<string>>();
  const namespaces = new Map(
    Object.entries(seed.kv ?? {}).map(([namespace, values]) => [
      namespace,
      new Map(Object.entries(values)),
    ]),
  );
  let nextApplicationId = 1;

  for (const image of seed.images ?? []) putImage(image);

  const service: CloudflarePlaneShape = {
    listWorkers: () =>
      operation("listWorkers", () =>
        Effect.succeed(
          [...workers.values()].map(cloneWorker).sort((a, b) => a.name.localeCompare(b.name)),
        ),
      ),
    getWorker: (name) =>
      operation("getWorker", () => required(workers, name, "worker").pipe(Effect.map(cloneWorker))),
    putWorker: (worker) =>
      operation("putWorker", () =>
        Effect.sync(() => {
          workers.set(worker.name, cloneWorker(worker));
        }),
      ),
    deleteWorker: (name) => operation("deleteWorker", () => remove(workers, name, "worker")),

    createApplication: (application) =>
      operation("createApplication", () =>
        Effect.sync(() => {
          let id: string;
          do id = `application-${nextApplicationId++}`;
          while (applications.has(id));
          const created = { id, ...application };
          applications.set(id, { ...created });
          return created;
        }),
      ),
    listApplications: () =>
      operation("listApplications", () =>
        Effect.succeed(
          [...applications.values()]
            .map((application) => ({ ...application }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      ),
    getApplication: (id) =>
      operation("getApplication", () =>
        required(applications, id, "application").pipe(Effect.map((value) => ({ ...value }))),
      ),
    updateApplication: (id, update) =>
      operation("updateApplication", () =>
        required(applications, id, "application").pipe(
          Effect.map((application) => {
            const updated = { ...application, ...update };
            applications.set(id, updated);
            return { ...updated };
          }),
        ),
      ),
    deleteApplication: (id) =>
      operation("deleteApplication", () => remove(applications, id, "application")),

    listRegistryImages: (repository) =>
      operation("listRegistryImages", () =>
        Effect.succeed(
          [...(images.get(repository)?.values() ?? [])]
            .map(cloneImage)
            .sort((left, right) => left.tag.localeCompare(right.tag)),
        ),
      ),
    putRegistryImage: (image) =>
      operation("putRegistryImage", () => Effect.sync(() => putImage(image))),
    deleteRegistryTag: (repository, tag) =>
      operation("deleteRegistryTag", () => {
        const repositoryImages = images.get(repository);
        if (repositoryImages === undefined) return notFound("registry_tag", `${repository}:${tag}`);
        return remove(repositoryImages, tag, "registry_tag", `${repository}:${tag}`);
      }),
    collectRegistryGarbage: (repository) =>
      operation("collectRegistryGarbage", () =>
        Effect.sync(() => {
          const referenced = new Set(
            [...(images.get(repository)?.values() ?? [])].flatMap((image) => image.layers),
          );
          const repositoryLayers = layers.get(repository) ?? new Set<string>();
          const collected = [...repositoryLayers].filter((layer) => !referenced.has(layer)).sort();
          for (const layer of collected) repositoryLayers.delete(layer);
          return collected;
        }),
      ),

    ensureKVNamespace: (namespace) =>
      operation("ensureKVNamespace", () =>
        Effect.sync(() => {
          if (!namespaces.has(namespace)) namespaces.set(namespace, new Map());
        }),
      ),
    getKV: (namespace, key) =>
      operation("getKV", () =>
        requiredNamespace(namespace).pipe(
          Effect.flatMap((values) => required(values, key, "kv_key", `${namespace}:${key}`)),
        ),
      ),
    putKV: (namespace, key, value) =>
      operation("putKV", () =>
        requiredNamespace(namespace).pipe(
          Effect.tap((values) =>
            Effect.sync(() => {
              values.set(key, value);
            }),
          ),
          Effect.asVoid,
        ),
      ),
    deleteKV: (namespace, key) =>
      operation("deleteKV", () =>
        requiredNamespace(namespace).pipe(
          Effect.flatMap((values) => remove(values, key, "kv_key", `${namespace}:${key}`)),
        ),
      ),
    listKV: (namespace) =>
      operation("listKV", () =>
        requiredNamespace(namespace).pipe(
          Effect.map((values) =>
            Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b))),
          ),
        ),
      ),
    deleteKVNamespace: (namespace) =>
      operation("deleteKVNamespace", () => remove(namespaces, namespace, "kv_namespace")),
  };

  function operation<Value, Error>(
    name: string,
    effect: () => Effect.Effect<Value, Error>,
  ): Effect.Effect<Value, Error | InjectedFailure> {
    return fault.before(name).pipe(Effect.zipRight(Effect.suspend(effect)));
  }

  function putImage(image: RegistryImage): void {
    const repositoryImages = images.get(image.repository) ?? new Map<string, RegistryImage>();
    repositoryImages.set(image.tag, cloneImage(image));
    images.set(image.repository, repositoryImages);
    const repositoryLayers = layers.get(image.repository) ?? new Set<string>();
    for (const layer of image.layers) repositoryLayers.add(layer);
    layers.set(image.repository, repositoryLayers);
  }

  function requiredNamespace(namespace: string) {
    return required(namespaces, namespace, "kv_namespace");
  }

  return {
    layer: Layer.succeed(CloudflarePlane, service),
    resources: () =>
      [
        ...[...workers.keys()].map((name) => `cloudflare:worker:${name}`),
        ...[...applications.keys()].map((id) => `cloudflare:application:${id}`),
        ...[...images].flatMap(([repository, repositoryImages]) =>
          [...repositoryImages.keys()].map((tag) => `cloudflare:registry_tag:${repository}:${tag}`),
        ),
      ].sort(),
    registryLayers: (repository) => [...(layers.get(repository) ?? [])].sort(),
  };
}

export function makeGitHubPlaneFake(seed: GitHubFakeSeed = {}): GitHubPlaneFake {
  const fault = new FaultInjector(seed.fault);
  const apps = new Map(seed.apps?.map((app) => [app.id, { ...app }]));
  const installations = new Map(seed.installations?.map((item) => [item.id, { ...item }]));
  const variables = new Map(
    Object.entries(seed.variables ?? {}).map(([repository, values]) => [
      repository,
      new Map(Object.entries(values)),
    ]),
  );

  const operation = <Value, Error>(
    name: string,
    effect: () => Effect.Effect<Value, Error>,
  ): Effect.Effect<Value, Error | InjectedFailure> =>
    fault.before(name).pipe(Effect.zipRight(Effect.suspend(effect)));

  const service: GitHubPlaneShape = {
    getApp: (appId) =>
      operation("getApp", () =>
        required(apps, appId, "github_app").pipe(Effect.map((app) => ({ ...app }))),
      ),
    listInstallations: (appId) =>
      operation("listInstallations", () =>
        required(apps, appId, "github_app").pipe(
          Effect.map(() =>
            [...installations.values()]
              .filter((installation) => installation.appId === appId)
              .map((installation) => ({ ...installation }))
              .sort((left, right) => left.id - right.id),
          ),
        ),
      ),
    suspendInstallation: (appId, installationId) =>
      operation("suspendInstallation", () =>
        installationForApp(appId, installationId).pipe(
          Effect.tap((installation) =>
            Effect.sync(() => {
              installations.set(installationId, { ...installation, suspended: true });
            }),
          ),
          Effect.asVoid,
        ),
      ),
    deleteInstallation: (appId, installationId) =>
      operation("deleteInstallation", () =>
        installationForApp(appId, installationId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              installations.delete(installationId);
            }),
          ),
          Effect.asVoid,
        ),
      ),
    getRepositoryVariable: (repository, name) =>
      operation("getRepositoryVariable", () =>
        required(variables, repository, "repository").pipe(
          Effect.flatMap((repositoryVariables) =>
            required(repositoryVariables, name, "repository_variable", `${repository}:${name}`),
          ),
        ),
      ),
    putRepositoryVariable: (repository, name, value) =>
      operation("putRepositoryVariable", () =>
        Effect.sync(() => {
          const repositoryVariables = variables.get(repository) ?? new Map<string, string>();
          repositoryVariables.set(name, value);
          variables.set(repository, repositoryVariables);
        }),
      ),
    deleteRepositoryVariable: (repository, name) =>
      operation("deleteRepositoryVariable", () => {
        const repositoryVariables = variables.get(repository);
        if (repositoryVariables === undefined) {
          return notFound("repository_variable", `${repository}:${name}`);
        }
        return remove(repositoryVariables, name, "repository_variable", `${repository}:${name}`);
      }),
  };

  function installationForApp(appId: number, installationId: number) {
    return required(installations, installationId, "installation").pipe(
      Effect.flatMap((installation) =>
        installation.appId === appId
          ? Effect.succeed(installation)
          : notFound("installation", String(installationId)),
      ),
    );
  }

  return {
    layer: Layer.succeed(GitHubPlane, service),
    resources: () =>
      [
        ...[...apps.keys()].map((id) => `github:app:${id}`),
        ...[...installations.keys()].map((id) => `github:installation:${id}`),
        ...[...variables].flatMap(([repository, repositoryVariables]) =>
          [...repositoryVariables.keys()].map(
            (name) => `github:repository_variable:${repository}:${name}`,
          ),
        ),
      ].sort(),
  };
}

function required<Key, Value>(
  values: ReadonlyMap<Key, Value>,
  key: Key,
  resource: string,
  id = String(key),
): Effect.Effect<Value, ResourceNotFound> {
  const value = values.get(key);
  return value === undefined ? notFound(resource, id) : Effect.succeed(value);
}

function remove<Key, Value>(
  values: Map<Key, Value>,
  key: Key,
  resource: string,
  id = String(key),
): Effect.Effect<void, ResourceNotFound> {
  return values.delete(key) ? Effect.void : notFound(resource, id);
}

function notFound(resource: string, id: string): Effect.Effect<never, ResourceNotFound> {
  return Effect.fail(new ResourceNotFound({ resource, id }));
}

function cloneWorker(worker: WorkerService): WorkerService {
  return { ...worker };
}

function cloneImage(image: RegistryImage): RegistryImage {
  return { ...image, layers: [...image.layers] };
}
