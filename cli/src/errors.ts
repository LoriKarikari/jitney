import { Data, Effect } from "effect";

export type InstallerStep =
  | "argument_parsing"
  | "cloudflare_authentication"
  | "cloudflare_account_selection"
  | "existing_worker_check"
  | "filesystem"
  | "github_app_conversion"
  | "github_app_installation"
  | "github_app_setup"
  | "oras_download"
  | "registry_copy"
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

export type InstallFailure = InstallerError | ExistingWorkerError;

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
  return `${error.message} (${error.step})`;
}
