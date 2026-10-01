import { Context, DateTime, Effect, Option } from "effect";
import { ExistingDeploymentError, InstallerError, orStepError } from "./errors.js";
import { runnerApplicationName } from "./cloudflare-inventory.js";
import { DeploymentReceipts } from "./install.js";
import { beginInstallOperation, beginLeasedOperation } from "./receipts/leased-operation.js";
import {
  createDeploymentReceipt,
  generateDeploymentId,
  type DeploymentReceipt,
  type GitHubInstallation,
} from "./receipts/schema.js";

export interface AdoptInput {
  readonly name: string;
  readonly accountId: string;
  readonly version: string;
  readonly actor: string;
}

/** What Cloudflare reports under a Deployment name before adoption. */
export interface AdoptionCandidate {
  readonly worker: {
    readonly durableObjectClasses: readonly string[];
    readonly secretNames: readonly string[];
    readonly deploymentId: string | null;
  } | null;
  readonly application: { readonly id: string } | null;
}

export interface AdoptedApp {
  readonly appId: number;
  readonly appSlug: string;
  readonly ownerLogin: string;
  readonly ownerType: "User" | "Organization";
}

export interface RepositoryOwnership {
  readonly fullName: string;
  readonly status: "ok" | "missing" | "drifted" | "unknown";
}

export class AdoptPlatform extends Context.Service<
  AdoptPlatform,
  {
    readonly inspect: (input: AdoptInput) => Effect.Effect<AdoptionCandidate, InstallerError>;
    /** Deploy the receipt's stack over the existing resources and health-gate it. */
    readonly deploy: (
      receipt: DeploymentReceipt,
    ) => Effect.Effect<
      { readonly applicationId: string; readonly registryTag: string },
      InstallerError
    >;
    /** The Worker reports its own GitHub App, whose credentials only it holds. */
    readonly inventory: (receipt: DeploymentReceipt) => Effect.Effect<
      {
        readonly app: AdoptedApp;
        readonly installations: readonly GitHubInstallation[];
      },
      InstallerError
    >;
    readonly ownership: (
      receipt: DeploymentReceipt,
    ) => Effect.Effect<readonly RepositoryOwnership[], InstallerError>;
    readonly writeOwnership: (
      receipt: DeploymentReceipt,
      fullNames: readonly string[],
    ) => Effect.Effect<void, InstallerError>;
  }
>()("Jitney.AdoptPlatform") {}

const REQUIRED_CLASSES = ["Scheduler", "RunnerContainer"];
const REQUIRED_SECRETS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"];

const refuse = (message: string) => new InstallerError({ step: "adopt", message });

const newReceipt = Effect.fn(function* (input: AdoptInput) {
  const receipts = yield* DeploymentReceipts;
  const platform = yield* AdoptPlatform;
  const applicationName = runnerApplicationName(input.name);

  const candidate = yield* platform.inspect(input);
  const worker = candidate.worker;
  if (worker === null) return yield* refuse(`No Worker named ${input.name} to adopt`);
  const missing = [
    ...REQUIRED_CLASSES.filter((name) => !worker.durableObjectClasses.includes(name)),
    ...REQUIRED_SECRETS.filter((name) => !worker.secretNames.includes(name)),
  ];
  if (missing.length > 0) {
    return yield* refuse(
      `Worker ${input.name} is not a Jitney Deployment: missing ${missing.join(", ")}`,
    );
  }
  if (candidate.application === null) {
    return yield* refuse(`Container application ${applicationName} does not exist`);
  }
  const applicationId = candidate.application.id;

  const others = yield* receipts
    .list()
    .pipe(Effect.mapError(orStepError("receipt_store", "Could not read deployment receipts")));
  const claimant = others.find(
    (receipt) =>
      receipt.cloudflare.applicationId === applicationId || receipt.id === worker.deploymentId,
  );
  if (claimant !== undefined) {
    return yield* refuse(`Deployment ${claimant.name} already owns these resources`);
  }

  const now = yield* DateTime.now;
  const receipt = createDeploymentReceipt({
    id: worker.deploymentId ?? (yield* generateDeploymentId),
    name: input.name,
    version: input.version,
    now,
    cloudflare: {
      accountId: input.accountId,
      workerName: input.name,
      applicationId,
      applicationName,
      durableObjectClasses: REQUIRED_CLASSES,
      registryRepo: applicationName,
      tags: { current: input.version, previous: null },
    },
    github: { appId: null, appSlug: null, ownerLogin: null, ownerType: "User", installations: [] },
    autoUpgrade: { enabled: false, channel: "patch" },
  });
  return yield* beginInstallOperation(receipts, receipt, input.actor, now);
});

const beginAdoption = Effect.fn(function* (input: AdoptInput) {
  const receipts = yield* DeploymentReceipts;
  const existing = yield* receipts
    .get(input.name)
    .pipe(Effect.mapError(orStepError("receipt_store", "Could not read the deployment receipt")));
  if (Option.isNone(existing)) return yield* newReceipt(input);
  const receipt = existing.value;
  if (receipt.phase !== "installing" || receipt.lease !== null) {
    return yield* new ExistingDeploymentError({
      name: input.name,
      deploymentId: receipt.id,
      phase: receipt.phase,
    });
  }
  return yield* beginLeasedOperation(receipts, input.name, "install", input.actor);
});

export const adoptDeployment = Effect.fn(function* (input: AdoptInput) {
  const platform = yield* AdoptPlatform;
  const held = yield* beginAdoption(input);

  const operation = Effect.gen(function* () {
    const deployed = yield* platform.deploy(yield* held.receipt());
    yield* held.record((current) => ({
      cloudflare: {
        ...current.cloudflare,
        applicationId: deployed.applicationId,
        tags: { current: deployed.registryTag, previous: null },
      },
    }));

    const { app, installations } = yield* platform.inventory(yield* held.receipt());
    const withInstallations = yield* held.record(() => ({
      github: { ...app, installations: [...installations] },
    }));

    const ownership = yield* platform.ownership(withInstallations);
    const reported = new Set(ownership.map(({ fullName }) => fullName));
    const unreported = installations
      .flatMap((installation) => installation.repositories)
      .filter(({ fullName }) => !reported.has(fullName));
    if (unreported.length > 0) {
      return yield* refuse(
        `Could not read the Ownership Marker of ${unreported.map(({ fullName }) => fullName).join(", ")}`,
      );
    }
    const blocked = ownership.filter(({ status }) => status === "drifted" || status === "unknown");
    if (blocked.length > 0) {
      return yield* refuse(
        `Cannot claim ${blocked.map(({ fullName }) => fullName).join(", ")}: another Deployment's Ownership Marker is present, or GitHub did not answer`,
      );
    }
    const missing = ownership.filter(({ status }) => status === "missing");
    if (missing.length > 0) {
      yield* platform.writeOwnership(
        withInstallations,
        missing.map(({ fullName }) => fullName),
      );
    }

    return yield* held.finish({ phase: "active", outcome: "succeeded" });
  });

  // A failed adoption never tears down a Deployment that serves jobs. It
  // leaves the receipt installing, so a rerun resumes with the same ULID.
  return yield* held.hold(
    operation.pipe(
      Effect.catchCause((cause) =>
        held
          .finish({ phase: "installing", outcome: "failed" })
          .pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    ),
  );
});
