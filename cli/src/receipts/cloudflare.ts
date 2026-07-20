import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as KV from "@distilled.cloud/cloudflare/kv";
import { Effect, Option, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ReceiptBackendError, type ReceiptBackend } from "./store.js";

export const RECEIPT_NAMESPACE_TITLE = "jitney-receipts";

export interface CloudflareReceiptScope {
  readonly accountId: string;
  readonly namespaceId: string;
}

const backendError = (operation: ReceiptBackendError["operation"], cause: unknown) =>
  new ReceiptBackendError({ operation, cause });

export const findCloudflareReceiptNamespace = Effect.fn(function* (accountId: string) {
  const namespace = yield* KV.listNamespaces.items({ accountId }).pipe(
    Stream.filter((candidate) => candidate.title === RECEIPT_NAMESPACE_TITLE),
    Stream.runHead,
    Effect.mapError((cause) => backendError("find_namespace", cause)),
  );
  return Option.map(namespace, ({ id }) => ({ accountId, namespaceId: id }));
});

export const makeCloudflareReceiptBackend = Effect.fn(function* (scope: CloudflareReceiptScope) {
  const credentials = yield* Credentials;
  const httpClient = yield* HttpClient.HttpClient;
  const provideApi = <A, E>(effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  return {
    get: (name) =>
      provideApi(
        KV.getNamespaceValue({
          ...scope,
          keyName: name,
        }),
      ).pipe(
        Effect.map((value) => String(value)),
        Effect.catchTag("KeyNotFound", () => Effect.succeed(undefined)),
        Effect.mapError((cause) => backendError("get", cause)),
      ),
    put: (name, value) =>
      provideApi(
        KV.putNamespaceValue({
          ...scope,
          keyName: name,
          value,
        }),
      ).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => backendError("put", cause)),
      ),
    remove: (name) =>
      provideApi(
        KV.deleteNamespaceValue({
          ...scope,
          keyName: name,
        }),
      ).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => backendError("remove", cause)),
      ),
    listKeys: () =>
      provideApi(KV.listNamespaceKeys.items(scope).pipe(Stream.runCollect)).pipe(
        Effect.map((keys) => [...keys].map((key) => key.name)),
        Effect.mapError((cause) => backendError("list_keys", cause)),
      ),
    removeNamespace: () =>
      provideApi(KV.deleteNamespace(scope)).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => backendError("remove_namespace", cause)),
      ),
  } satisfies ReceiptBackend;
});
