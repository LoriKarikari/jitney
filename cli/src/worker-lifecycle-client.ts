import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Effect, Option, Ref } from "effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { UninstallAction } from "@jitney/shared/uninstall-protocol";
import { InstallerError, orStepError, type InstallerStep } from "./errors.js";
import { workerAddress } from "./lifecycle-status-client.js";
import type { DeploymentReceipt } from "./receipts/schema.js";
import type { CloudflareServices } from "./cloudflare-runtime.js";

export const makeWorkerLifecycleClient = Effect.fn(function* (
  cloudflare: CloudflareServices,
  step: InstallerStep,
  secret: string,
) {
  const installed = yield* Ref.make(false);

  return {
    call: (receipt: DeploymentReceipt, action: UninstallAction) =>
      Effect.gen(function* () {
        const worker = yield* cloudflare.provide(
          workerAddress(receipt.cloudflare.accountId, receipt.cloudflare.workerName),
        );
        if (!worker.exists || worker.url === null) return Option.none<unknown>();
        if (!(yield* Ref.get(installed))) {
          const secretInstalled = yield* cloudflare
            .provide(
              Workers.putScriptSecret({
                accountId: receipt.cloudflare.accountId,
                scriptName: receipt.cloudflare.workerName,
                name: "JITNEY_UNINSTALL_SECRET",
                text: secret,
                type: "secret_text",
              }),
            )
            .pipe(
              Effect.as(true),
              Effect.catchTag("WorkerNotFound", () => Effect.succeed(false)),
            );
          if (!secretInstalled) return Option.none<unknown>();
          yield* Ref.set(installed, true);
        }
        const request = HttpClientRequest.bodyJsonUnsafe(
          HttpClientRequest.post(`${worker.url}/lifecycle/uninstall`, {
            headers: {
              Authorization: `Bearer ${secret}`,
              "X-Jitney-Deployment": receipt.id,
            },
          }),
          { action },
        );
        let response = yield* cloudflare.client.execute(request);
        for (let attempt = 0; response.status === 401 && attempt < 59; attempt++) {
          yield* Effect.sleep("1 second");
          response = yield* cloudflare.client.execute(request);
        }
        if (response.status === 401) {
          return yield* new InstallerError({
            step,
            message: "The Worker has not activated the lifecycle secret yet",
          });
        }
        if (response.status !== 204 && response.status !== 200) {
          const message =
            response.status === 404
              ? `The Worker for ${receipt.cloudflare.workerName} does not recognize deployment ${receipt.id}. Run repair first.`
              : `Lifecycle action ${action} returned ${response.status}`;
          return yield* new InstallerError({ step, message });
        }
        return response.status === 200
          ? Option.some(yield* response.json)
          : Option.some<unknown>(undefined);
      }).pipe(Effect.mapError(orStepError(step, `Could not run lifecycle action ${action}`))),
  };
});
