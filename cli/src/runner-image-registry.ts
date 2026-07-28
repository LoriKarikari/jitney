import * as Containers from "@distilled.cloud/cloudflare/containers";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { InstallerError, type InstallerStep } from "./errors.js";
import { deleteImage, listImageTags } from "./oras.js";

const REGISTRY_HOST = "registry.cloudflare.com";

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
  scratchCredentials(accountId, ["pull"], "registry_inspection").pipe(
    Effect.flatMap((auth) =>
      listImageTags({
        repository: `${REGISTRY_HOST}/${accountId}/${repository}`,
        registryHost: REGISTRY_HOST,
        ...auth,
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
  scratchCredentials(accountId, ["pull", "push"], "registry_cleanup").pipe(
    Effect.flatMap((auth) =>
      deleteImage({
        image: `${REGISTRY_HOST}/${accountId}/${repository}:${tag}`,
        registryHost: REGISTRY_HOST,
        ...auth,
      }),
    ),
  );
