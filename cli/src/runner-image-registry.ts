import * as Containers from "@distilled.cloud/cloudflare/containers";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { InstallerError, type InstallerStep } from "./errors.js";

const REGISTRY_HOST = "registry.cloudflare.com";
const RegistryTags = Schema.Struct({
  tags: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Null])),
});

type CloudflareApi = Credentials | HttpClient.HttpClient;

const scratchCredentials = (
  accountId: string,
  permissions: readonly ("pull" | "push")[],
  step: InstallerStep,
): Effect.Effect<
  { readonly username: string; readonly password: string },
  InstallerError,
  CloudflareApi
> =>
  Containers.createContainerRegistryCredentials({
    accountId,
    registryId: REGISTRY_HOST,
    permissions: [...permissions],
    expirationMinutes: 15,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new InstallerError({
          step,
          message: "Could not obtain Cloudflare registry credentials",
          cause,
        }),
    ),
    Effect.flatMap((registry) => {
      // The Cloudflare API reports the username under two different fields.
      const username = registry.username ?? registry.user;
      return username === null || username === undefined
        ? Effect.fail(
            new InstallerError({
              step,
              message: "Cloudflare registry credentials did not include a username",
            }),
          )
        : Effect.succeed({ username, password: registry.password });
    }),
  );

export const listRunnerImageTags = (
  accountId: string,
  repository: string,
): Effect.Effect<readonly string[], InstallerError, CloudflareApi> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const auth = yield* scratchCredentials(accountId, ["pull"], "registry_inspection");
    const authorization = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    // Jitney retains at most two tags per deployment. A large page avoids
    // Cloudflare's malformed empty-cursor Link header without owning pagination.
    const response = yield* client.get(
      `https://${REGISTRY_HOST}/v2/${accountId}/${repository}/tags/list?n=1000`,
      { headers: { Authorization: `Basic ${authorization}` } },
    );
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      return yield* new InstallerError({
        step: "registry_inspection",
        message: `Could not list tags for ${REGISTRY_HOST}/${accountId}/${repository}: registry returned ${response.status}`,
      });
    }
    const body = yield* response.json;
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(RegistryTags)(body),
      catch: (cause) =>
        new InstallerError({
          step: "registry_inspection",
          message: `Could not parse tags for ${REGISTRY_HOST}/${accountId}/${repository}`,
          cause,
        }),
    });
    return (decoded.tags ?? []).filter((tag) => !tag.startsWith("sha256:"));
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof InstallerError
        ? cause
        : new InstallerError({
            step: "registry_inspection",
            message: `Could not list tags for ${REGISTRY_HOST}/${accountId}/${repository}`,
            cause,
          }),
    ),
  );

export const garbageCollectRunnerLayers = (
  accountId: string,
): Effect.Effect<void, InstallerError, CloudflareApi> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const auth = yield* scratchCredentials(accountId, ["pull", "push"], "registry_cleanup");
    const authorization = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    const response = yield* client.put(`https://${REGISTRY_HOST}/v2/gc/layers`, {
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/json",
      },
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* new InstallerError({
        step: "registry_cleanup",
        message: `Cloudflare layer garbage collection returned ${response.status}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof InstallerError
        ? cause
        : new InstallerError({
            step: "registry_cleanup",
            message: "Could not garbage-collect unreferenced runner layers",
            cause,
          }),
    ),
  );

export const deleteRunnerImageTag = (
  accountId: string,
  repository: string,
  tag: string,
): Effect.Effect<void, InstallerError, CloudflareApi> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const auth = yield* scratchCredentials(accountId, ["pull", "push"], "registry_cleanup");
    const headers = {
      Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
      Accept:
        "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    };
    const base = `https://${REGISTRY_HOST}/v2/${accountId}/${repository}/manifests`;
    const manifest = yield* client.head(`${base}/${tag}`, { headers });
    if (manifest.status === 404) return;
    const digest = manifest.headers["docker-content-digest"];
    if (manifest.status < 200 || manifest.status >= 300 || digest === undefined) {
      return yield* new InstallerError({
        step: "registry_cleanup",
        message: `Could not resolve runner image ${REGISTRY_HOST}/${accountId}/${repository}:${tag}`,
      });
    }
    const response = yield* client.del(`${base}/${tag}`, { headers });
    if (response.status !== 202 && response.status !== 204 && response.status !== 404) {
      return yield* new InstallerError({
        step: "registry_cleanup",
        message: `Could not remove runner image ${REGISTRY_HOST}/${accountId}/${repository}:${tag}: registry returned ${response.status}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof InstallerError
        ? cause
        : new InstallerError({
            step: "registry_cleanup",
            message: `Could not remove runner image ${REGISTRY_HOST}/${accountId}/${repository}:${tag}`,
            cause,
          }),
    ),
  );
