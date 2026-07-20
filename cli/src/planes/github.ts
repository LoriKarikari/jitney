import { Context, type Effect } from "effect";
import type { PlaneError } from "./errors.js";

export type GitHubApp = {
  id: number;
  slug: string;
};

export type GitHubInstallation = {
  appId: number;
  id: number;
  owner: string;
  suspended: boolean;
};

type PlaneEffect<Value> = Effect.Effect<Value, PlaneError>;

export type GitHubPlaneShape = {
  getApp(appId: number): PlaneEffect<GitHubApp>;
  listInstallations(appId: number): PlaneEffect<readonly GitHubInstallation[]>;
  suspendInstallation(appId: number, installationId: number): PlaneEffect<void>;
  deleteInstallation(appId: number, installationId: number): PlaneEffect<void>;

  getRepositoryVariable(repository: string, name: string): PlaneEffect<string>;
  putRepositoryVariable(repository: string, name: string, value: string): PlaneEffect<void>;
  deleteRepositoryVariable(repository: string, name: string): PlaneEffect<void>;
};

export class GitHubPlane extends Context.Tag("jitney/GitHubPlane")<
  GitHubPlane,
  GitHubPlaneShape
>() {}
