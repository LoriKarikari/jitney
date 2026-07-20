import { Data, Effect } from "effect";

export type InstallerStep =
  | "argument_parsing"
  | "cloudflare_authentication"
  | "cloudflare_account_selection"
  | "deployment_inspection"
  | "existing_worker_check"
  | "filesystem"
  | "health_check"
  | "github_app_conversion"
  | "github_app_installation"
  | "github_app_setup"
  | "oras_download"
  | "registry_cleanup"
  | "registry_copy"
  | "registry_inspection"
  | "repair"
  | "repository_ownership"
  | "receipt_store"
  | "rollback"
  | "secret_storage"
  | "worker_deployment";

export class InstallerError extends Data.TaggedError("InstallerError")<{
  step: InstallerStep;
  message: string;
  cause?: unknown;
}> {}

export class ExistingWorkerError extends Data.TaggedError("ExistingWorkerError")<{
  workerName: string;
}> {}

export class ExistingDeploymentError extends Data.TaggedError("ExistingDeploymentError")<{
  name: string;
  deploymentId: string;
  phase: string;
}> {}

export class InstallRollbackError extends Data.TaggedError("InstallRollbackError")<{
  cause: unknown;
  rollbackCause: unknown;
}> {}

export type InstallFailure =
  | InstallerError
  | ExistingWorkerError
  | ExistingDeploymentError
  | InstallRollbackError;

export function isInstallFailure(cause: unknown): cause is InstallFailure {
  return (
    cause instanceof InstallerError ||
    cause instanceof ExistingWorkerError ||
    cause instanceof ExistingDeploymentError ||
    cause instanceof InstallRollbackError
  );
}

export function tryPromise<A>(
  step: InstallerStep,
  message: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, InstallerError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new InstallerError({ step, message, cause }),
  });
}

export function trySync<A>(
  step: InstallerStep,
  message: string,
  evaluate: () => A,
): Effect.Effect<A, InstallerError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) => new InstallerError({ step, message, cause }),
  });
}

export function renderFailure(error: InstallFailure): string {
  if (error._tag === "ExistingWorkerError") {
    return `Worker ${error.workerName} already exists. Choose another --name; upgrades are not supported yet.`;
  }
  if (error._tag === "ExistingDeploymentError") {
    return `Deployment ${error.name} already exists (${error.deploymentId}, phase: ${error.phase}). Refusing to overwrite it.`;
  }
  if (error._tag === "InstallRollbackError") {
    return "Installation failed and cleanup was incomplete. The deployment receipt was kept for repair.";
  }
  return `${error.message} (${error.step})`;
}
