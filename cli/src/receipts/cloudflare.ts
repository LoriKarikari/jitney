import * as KV from "@distilled.cloud/cloudflare/kv";
import { Effect, Option, Stream } from "effect";
import { captureCloudflareServices } from "../cloudflare-runtime.js";
import { ReceiptBackendError, type ReceiptBackend } from "./store.js";

export const RECEIPT_NAMESPACE_TITLE = "jitney-receipts";

export interface CloudflareReceiptScope {
  readonly accountId: string;
  readonly namespaceId: string;
}

/**
 * KV hands back parsed JSON when the stored value carries a JSON content type,
 * so a receipt written as text can come back as an object. The store decodes
 * receipts itself and only ever wants the raw text.
 */
export const receiptValueText = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));

export const collectNamespaceKeyNames = <E, R>(
  pages: Stream.Stream<KV.ListNamespaceKeysResponse, E, R>,
): Effect.Effect<readonly string[], E, R> =>
  pages.pipe(
    Stream.takeUntil((page) => !page.resultInfo?.cursor),
    Stream.flatMap((page) => Stream.fromIterable(page.result)),
    Stream.map((key) => key.name),
    Stream.runCollect,
    Effect.map((keys) => [...keys]),
  );

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

export const ensureCloudflareReceiptNamespace = Effect.fn(function* (accountId: string) {
  const existing = yield* findCloudflareReceiptNamespace(accountId);
  if (Option.isSome(existing)) return existing.value;

  const created = yield* KV.createNamespace({
    accountId,
    title: RECEIPT_NAMESPACE_TITLE,
  }).pipe(
    Effect.map(({ id }) => Option.some({ accountId, namespaceId: id })),
    Effect.catchTag("NamespaceTitleAlreadyExists", () => findCloudflareReceiptNamespace(accountId)),
    mapBackendError("find_namespace"),
  );
  return yield* Option.match(created, {
    onNone: () =>
      Effect.fail(
        backendError(
          "find_namespace",
          new Error("Receipt namespace exists but could not be found after a creation race"),
        ),
      ),
    onSome: Effect.succeed,
  });
});

export const makeCloudflareReceiptBackend = Effect.fn(function* (scope: CloudflareReceiptScope) {
  const { provide: provideApi } = yield* captureCloudflareServices;

  return {
    get: (name) =>
      provideApi(KV.getNamespaceValue({ ...scope, keyName: name })).pipe(
        Effect.map(receiptValueText),
        Effect.catchTag("KeyNotFound", () => Effect.succeed(undefined)),
        mapBackendError("get"),
      ),
    put: (name, value) =>
      voidResult("put", provideApi(KV.putNamespaceValue({ ...scope, keyName: name, value }))),
    remove: (name) =>
      voidResult("remove", provideApi(KV.deleteNamespaceValue({ ...scope, keyName: name }))),
    listKeys: () =>
      provideApi(collectNamespaceKeyNames(KV.listNamespaceKeys.pages(scope))).pipe(
        mapBackendError("list_keys"),
      ),
    removeNamespace: () => voidResult("remove_namespace", provideApi(KV.deleteNamespace(scope))),
  } satisfies ReceiptBackend;
});
