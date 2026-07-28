import * as Workers from "@distilled.cloud/cloudflare/workers";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Effect, Option, Ref, Schedule, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { destroyDeploymentStack } from "./alchemy/destroy-deployment.js";
import { observeAccount } from "./cloudflare-inventory.js";
import { captureCloudflareServices } from "./cloudflare-runtime.js";
import { DestroyPlatform, renderDestroyPlan, type DestroyPlan } from "./destroy.js";
import { InstallerError, orStepError, stepError, tryPromise } from "./errors.js";
import {
  openGitHubAppDeletionFor,
  waitForGitHubAppDeletionFor,
  type GitHubAppIdentity,
} from "./github-app.js";
import { workerAddress } from "./lifecycle-status-client.js";
import { confirmInTerminal } from "./prompt.js";
import { mintOperationSecret, type UninstallAction } from "../../shared/uninstall-protocol.js";
import type { DeploymentReceipt, DestroyResidue } from "./receipts/schema.js";
import {
  DeploymentReceiptSchema,
  recordedImageTags,
  recordedRepositories,
} from "./receipts/schema.js";
import {
  deleteRunnerImageTag,
  garbageCollectRunnerLayers,
  listRunnerImageTags,
} from "./runner-image-registry.js";

const DrainResponse = Schema.Struct({ activeAttempts: Schema.Number });
const operationSecret = (): string =>
  mintOperationSecret(Date.now() + 15 * 60_000, randomBytes(32).toString("base64url"));

const fail = stepError("destroy");

const appIdentity = (receipt: DeploymentReceipt): GitHubAppIdentity | null =>
  receipt.github.appSlug === null || receipt.github.ownerLogin === null
    ? null
    : {
        slug: receipt.github.appSlug,
        ownerLogin: receipt.github.ownerLogin,
        ownerType: receipt.github.ownerType,
      };

export const makeDestroyPlatform = Effect.fn(function* (assumeYes: boolean) {
  const cloudflare = yield* captureCloudflareServices;
  const provideCloudflare = cloudflare.provide;
  const client = cloudflare.client;
  const accumulatedResidue = yield* Ref.make<DestroyResidue[]>([]);
  const exportedPath = yield* Ref.make<Option.Option<string>>(Option.none());

  const addResidue = (residue: readonly DestroyResidue[]) =>
    Ref.update(accumulatedResidue, (current) => [...current, ...residue]);

  const writeExport = (
    path: string,
    receipt: DeploymentReceipt,
    finalVerification: { completedAt: string; residue: readonly DestroyResidue[] } | null,
  ) =>
    tryPromise("destroy", `Could not write the receipt export to ${path}`, () =>
      writeFile(
        path,
        `${JSON.stringify(
          { receipt: Schema.encodeSync(DeploymentReceiptSchema)(receipt), finalVerification },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      ),
    );

  const callUninstall = (receipt: DeploymentReceipt, action: UninstallAction) =>
    Effect.gen(function* () {
      const worker = yield* provideCloudflare(
        workerAddress(receipt.cloudflare.accountId, receipt.cloudflare.workerName),
      );
      if (!worker.exists || worker.url === null) return Option.none<unknown>();
      const secret = operationSecret();
      const installed = yield* provideCloudflare(
        Workers.putScriptSecret({
          accountId: receipt.cloudflare.accountId,
          scriptName: receipt.cloudflare.workerName,
          name: "JITNEY_UNINSTALL_SECRET",
          text: secret,
          type: "secret_text",
        }),
      ).pipe(
        Effect.as(true),
        Effect.catchTag("WorkerNotFound", () => Effect.succeed(false)),
      );
      if (!installed) return Option.none<unknown>();
      const request = HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${worker.url}/lifecycle/uninstall`, {
          headers: {
            Authorization: `Bearer ${secret}`,
            "X-Jitney-Deployment": receipt.id,
          },
        }),
        { action },
      );
      const secretPending = new InstallerError({
        step: "destroy",
        message: "The Worker has not activated the uninstall secret yet",
      });
      const response = yield* client.execute(request).pipe(
        Effect.flatMap((response) =>
          response.status === 401 ? Effect.fail(secretPending) : Effect.succeed(response),
        ),
        Effect.retry({
          while: (error) => error === secretPending,
          schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(29)]),
        }),
      );
      if (response.status !== 204 && response.status !== 200) {
        // The Worker answers 404 when the deployment identity does not match.
        const message =
          response.status === 404
            ? `The Worker for ${receipt.cloudflare.workerName} does not recognize deployment ${receipt.id}. Run repair first.`
            : `Uninstall ${action} returned ${response.status}`;
        return yield* Effect.fail(new InstallerError({ step: "destroy", message }));
      }
      return response.status === 200
        ? Option.some(yield* response.json)
        : Option.some<unknown>(undefined);
    }).pipe(Effect.mapError(orStepError("destroy", `Could not run uninstall ${action}`)));

  const exportReceipt = (receipt: DeploymentReceipt, path: string) =>
    writeExport(path, receipt, null).pipe(Effect.andThen(Ref.set(exportedPath, Option.some(path))));

  const confirm = (plan: DestroyPlan) =>
    assumeYes
      ? Effect.succeed(true)
      : confirmInTerminal({
          step: "destroy",
          render: `${renderDestroyPlan(plan)}\n`,
          question: `Type ${plan.name} to confirm: `,
          accept: (answer) => answer === plan.name,
        });
  const suspend = (receipt: DeploymentReceipt) =>
    callUninstall(receipt, "suspend").pipe(Effect.asVoid);
  const drain = (receipt: DeploymentReceipt) => {
    const pending = fail(`Runner Attempts are still active for ${receipt.name}`);
    return callUninstall(receipt, "drain").pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (body) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(DrainResponse)(body),
              catch: orStepError("destroy", "The Worker returned an invalid drain response"),
            }).pipe(
              Effect.flatMap(({ activeAttempts }) =>
                activeAttempts === 0 ? Effect.void : Effect.fail(pending),
              ),
            ),
        }),
      ),
      Effect.retry({
        while: (error) => error === pending,
        schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(719)]),
      }),
    );
  };
  const deleteOwnership = (receipt: DeploymentReceipt) =>
    callUninstall(receipt, "delete_ownership").pipe(
      Effect.flatMap(
        Option.match({
          onSome: () => Effect.void,
          onNone: () =>
            addResidue(
              recordedRepositories(receipt.github).map((repository) => ({
                plane: "github" as const,
                resource: "repository_variable",
                id: `${repository.fullName}:JITNEY_DEPLOYMENT`,
                reason: "Worker credentials were already gone",
              })),
            ),
        }),
      ),
    );
  const deleteInstallations = (receipt: DeploymentReceipt) =>
    callUninstall(receipt, "delete_installations").pipe(Effect.asVoid);
  const destroyCloudflare = (receipt: DeploymentReceipt) =>
    provideCloudflare(destroyDeploymentStack(receipt));
  const pruneImages = (receipt: DeploymentReceipt, protectedTags: ReadonlySet<string>) =>
    provideCloudflare(
      listRunnerImageTags(receipt.cloudflare.accountId, receipt.cloudflare.registryRepo),
    ).pipe(
      Effect.flatMap((liveTags) =>
        Effect.forEach(
          recordedImageTags(receipt.cloudflare).filter(
            (tag) => liveTags.includes(tag) && !protectedTags.has(tag),
          ),
          (tag) =>
            provideCloudflare(
              deleteRunnerImageTag(
                receipt.cloudflare.accountId,
                receipt.cloudflare.registryRepo,
                tag,
              ),
            ),
        ),
      ),
      Effect.andThen(provideCloudflare(garbageCollectRunnerLayers(receipt.cloudflare.accountId))),
    );
  const deleteApp = (receipt: DeploymentReceipt) => {
    const app = appIdentity(receipt);
    if (app === null) return Effect.void;
    return Effect.sync(() =>
      console.log(`Delete the GitHub App ${app.slug} in the browser to finish teardown.`),
    ).pipe(
      Effect.andThen(openGitHubAppDeletionFor(app, "destroy")),
      Effect.andThen(
        waitForGitHubAppDeletionFor(app, "destroy").pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      ),
    );
  };
  const verify = (receipt: DeploymentReceipt) =>
    Effect.gen(function* () {
      const residue = [...(yield* Ref.get(accumulatedResidue))];
      const snapshot = yield* provideCloudflare(observeAccount(receipt.cloudflare.accountId));
      if (snapshot.workers.some((worker) => worker.name === receipt.cloudflare.workerName)) {
        residue.push({
          plane: "cloudflare",
          resource: "worker",
          id: receipt.cloudflare.workerName,
          reason: "Cloudflare still reports the Worker",
        });
      }
      if (
        receipt.cloudflare.applicationId !== null &&
        snapshot.applications.some(
          (application) => application.id === receipt.cloudflare.applicationId,
        )
      ) {
        residue.push({
          plane: "cloudflare",
          resource: "container_application",
          id: receipt.cloudflare.applicationId,
          reason: "Cloudflare still reports the container application",
        });
      }
      const tags = yield* provideCloudflare(
        listRunnerImageTags(receipt.cloudflare.accountId, receipt.cloudflare.registryRepo),
      );
      for (const tag of recordedImageTags(receipt.cloudflare)) {
        if (tags.includes(tag)) {
          residue.push({
            plane: "registry",
            resource: "image_tag",
            id: `${receipt.cloudflare.registryRepo}:${tag}`,
            reason: "The registry still reports the tag",
          });
        }
      }
      const exportPath = yield* Ref.get(exportedPath);
      if (Option.isSome(exportPath)) {
        yield* writeExport(exportPath.value, receipt, {
          completedAt: new Date().toISOString(),
          residue,
        });
      }
      return residue;
    }).pipe(Effect.mapError(orStepError("destroy", "Could not verify teardown")));

  return DestroyPlatform.of({
    exportReceipt,
    confirm,
    teardown: ({ receipt, now, protectedTags }) =>
      Effect.gen(function* () {
        yield* suspend(receipt);
        if (!now) yield* drain(receipt);
        yield* deleteOwnership(receipt);
        yield* deleteInstallations(receipt);
        yield* destroyCloudflare(receipt);
        yield* pruneImages(receipt, protectedTags);
        yield* deleteApp(receipt);
        return yield* verify(receipt);
      }),
  });
});
