import { Context, type Effect } from "effect";
import type { PlaneError } from "./errors.js";

export type WorkerService = {
  name: string;
  version: string;
};

export type ContainerApplication = {
  id: string;
  name: string;
  workerName: string;
  image: string;
};

export type RegistryImage = {
  repository: string;
  tag: string;
  layers: readonly string[];
};

type PlaneEffect<Value> = Effect.Effect<Value, PlaneError>;

export type CloudflarePlaneShape = {
  listWorkers(): PlaneEffect<readonly WorkerService[]>;
  getWorker(name: string): PlaneEffect<WorkerService>;
  putWorker(worker: WorkerService): PlaneEffect<void>;
  deleteWorker(name: string): PlaneEffect<void>;

  createApplication(
    application: Omit<ContainerApplication, "id">,
  ): PlaneEffect<ContainerApplication>;
  listApplications(): PlaneEffect<readonly ContainerApplication[]>;
  getApplication(id: string): PlaneEffect<ContainerApplication>;
  updateApplication(id: string, update: { image: string }): PlaneEffect<ContainerApplication>;
  deleteApplication(id: string): PlaneEffect<void>;

  listRegistryImages(repository: string): PlaneEffect<readonly RegistryImage[]>;
  putRegistryImage(image: RegistryImage): PlaneEffect<void>;
  deleteRegistryTag(repository: string, tag: string): PlaneEffect<void>;
  collectRegistryGarbage(repository: string): PlaneEffect<readonly string[]>;

  ensureKVNamespace(namespace: string): PlaneEffect<void>;
  getKV(namespace: string, key: string): PlaneEffect<string>;
  putKV(namespace: string, key: string, value: string): PlaneEffect<void>;
  deleteKV(namespace: string, key: string): PlaneEffect<void>;
  listKV(namespace: string): PlaneEffect<Readonly<Record<string, string>>>;
  deleteKVNamespace(namespace: string): PlaneEffect<void>;
};

export class CloudflarePlane extends Context.Tag("jitney/CloudflarePlane")<
  CloudflarePlane,
  CloudflarePlaneShape
>() {}
