import { DateTime, Effect, Schema } from "effect";
import { ulid } from "ulid";

export const DeploymentId = Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/));

export const DeploymentPhase = Schema.Literals([
  "installing",
  "active",
  "upgrading",
  "repairing",
  "destroying",
]);

export const DeploymentOperation = Schema.Literals([
  "install",
  "upgrade",
  "rollback",
  "repair",
  "destroy",
]);

export const OperationLease = Schema.Struct({
  operation: DeploymentOperation,
  actor: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
});

export const ReceiptHistoryEntry = Schema.Struct({
  operation: DeploymentOperation,
  actor: Schema.String,
  startedAt: Schema.DateTimeUtcFromString,
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  outcome: Schema.NullOr(Schema.Literals(["succeeded", "failed", "interrupted"])),
});

const Versions = Schema.Struct({
  current: Schema.NullOr(Schema.String),
  previous: Schema.NullOr(Schema.String),
});

const CloudflareResources = Schema.Struct({
  accountId: Schema.String,
  workerName: Schema.String,
  applicationId: Schema.NullOr(Schema.String),
  applicationName: Schema.String,
  durableObjectClasses: Schema.Array(Schema.String),
  registryRepo: Schema.String,
  tags: Schema.Struct({
    current: Schema.NullOr(Schema.String),
    previous: Schema.NullOr(Schema.String),
  }),
});

export const GitHubInstallation = Schema.Struct({
  id: Schema.Number,
  accountLogin: Schema.String,
  accountType: Schema.Literals(["User", "Organization"]),
  repositories: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      fullName: Schema.String,
    }),
  ),
});

const GitHubResources = Schema.Struct({
  appId: Schema.NullOr(Schema.Number),
  appSlug: Schema.NullOr(Schema.String),
  ownerLogin: Schema.NullOr(Schema.String),
  ownerType: Schema.Literals(["User", "Organization"]),
  installations: Schema.Array(GitHubInstallation),
});

const AutoUpgrade = Schema.Struct({
  enabled: Schema.Boolean,
  channel: Schema.Literals(["patch", "latest"]),
});

export const DeploymentReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: DeploymentId,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  phase: DeploymentPhase,
  lease: Schema.NullOr(OperationLease),
  versions: Versions,
  cloudflare: CloudflareResources,
  github: GitHubResources,
  autoUpgrade: AutoUpgrade,
  history: Schema.Array(ReceiptHistoryEntry).check(Schema.isMaxLength(20)),
});

export type DeploymentReceipt = typeof DeploymentReceiptSchema.Type;
export type DeploymentOperation = typeof DeploymentOperation.Type;
export type DeploymentPhase = typeof DeploymentPhase.Type;
export type OperationLease = typeof OperationLease.Type;
export type ReceiptHistoryEntry = typeof ReceiptHistoryEntry.Type;
export type GitHubInstallation = typeof GitHubInstallation.Type;

export type NewDeploymentReceipt = Pick<
  DeploymentReceipt,
  "id" | "name" | "cloudflare" | "github" | "autoUpgrade"
> & {
  readonly version: string;
  readonly now: DateTime.Utc;
};

export function createDeploymentReceipt(input: NewDeploymentReceipt): DeploymentReceipt {
  const { now, version, ...resources } = input;
  return {
    schemaVersion: 1,
    ...resources,
    createdAt: now,
    updatedAt: now,
    phase: "installing",
    lease: null,
    versions: { current: version, previous: null },
    history: [],
  };
}

export const generateDeploymentId: Effect.Effect<string> = Effect.sync(ulid);
