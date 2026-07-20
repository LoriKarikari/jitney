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

const mapBackendError = (operation: ReceiptBackendError["operation"]) =>
  Effect.mapError((cause: unknown) => backendError(operation, cause));

const voidResult = <A, E, R>(
  operation: ReceiptBackendError["operation"],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, ReceiptBackendError, R> =>
  effect.pipe(Effect.asVoid, mapBackendError(operation));

export const findCloudflareReceiptNamespace = Effect.fn(function* (accountId: string) {
  const namespace = yield* KV.listNamespaces.items({ accountId }).pipe(
    Stream.filter((candidate) => candidate.title === RECEIPT_NAMESPACE_TITLE),
    Stream.runHead,
    mapBackendError("find_namespace"),
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
      provideApi(KV.getNamespaceValue({ ...scope, keyName: name })).pipe(
        Effect.map((value) => String(value)),
        Effect.catchTag("KeyNotFound", () => Effect.succeed(undefined)),
        mapBackendError("get"),
      ),
    put: (name, value) =>
      voidResult("put", provideApi(KV.putNamespaceValue({ ...scope, keyName: name, value }))),
    remove: (name) =>
      voidResult("remove", provideApi(KV.deleteNamespaceValue({ ...scope, keyName: name }))),
    listKeys: () =>
      provideApi(KV.listNamespaceKeys.items(scope).pipe(Stream.runCollect)).pipe(
        Effect.map((keys) => [...keys].map((key) => key.name)),
        mapBackendError("list_keys"),
      ),
    removeNamespace: () => voidResult("remove_namespace", provideApi(KV.deleteNamespace(scope))),
  } satisfies ReceiptBackend;
});
