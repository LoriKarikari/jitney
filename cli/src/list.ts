import { Array as Arr, Context, Data, Effect, HashMap, HashSet, Option, Result } from "effect";
import type { DeploymentReceipt, GitHubInstallation } from "./receipts/schema.js";
import type { ReceiptReadError } from "./receipts/store.js";

export type ResourceClass = "ok" | "missing" | "drifted" | "orphan" | "unknown";

export interface Finding {
  readonly class: Exclude<ResourceClass, "ok">;
  readonly resource: string;
  readonly live?: string | number | boolean | null;
  readonly receipt?: string | number | boolean | null;
  readonly message: string;
  readonly commands?: readonly {
    readonly label: "repair" | "adopt" | "inspect";
    readonly command: string;
  }[];
}

export interface WorkerProbe {
  readonly exists: boolean;
  readonly version: string | null;
}

export interface LiveApplication {
  readonly id: string;
  readonly name: string;
  readonly imageTag: string | null;
}

export interface GitHubProbe {
  readonly appExists: boolean;
  readonly installations: readonly GitHubInstallation[];
  readonly ownership: readonly {
    readonly fullName: string;
    readonly class: "ok" | "missing" | "drifted" | "unknown";
    readonly value?: string;
  }[];
}

export class ProbeUnreachableError extends Data.TaggedError("ProbeUnreachableError")<{
  plane: "cloudflare" | "github" | "release";
  cause: unknown;
}> {}

export class ListReceipts extends Context.Service<
  ListReceipts,
  {
    readonly list: () => Effect.Effect<readonly DeploymentReceipt[], ReceiptReadError>;
  }
>()("Jitney.ListReceipts") {}

export class ListPlatform extends Context.Service<
  ListPlatform,
  {
    readonly worker: (
      accountId: string,
      name: string,
    ) => Effect.Effect<WorkerProbe, ProbeUnreachableError>;
    readonly workerNames: (
      accountId: string,
    ) => Effect.Effect<readonly string[], ProbeUnreachableError>;
    readonly containerApplications: (
      accountId: string,
    ) => Effect.Effect<readonly LiveApplication[], ProbeUnreachableError>;
    readonly registryTags: (
      accountId: string,
      repository: string,
    ) => Effect.Effect<readonly string[], ProbeUnreachableError>;
    readonly githubApp: (
      receipt: DeploymentReceipt,
    ) => Effect.Effect<GitHubProbe, ProbeUnreachableError>;
    readonly latestVersion: () => Effect.Effect<Option.Option<string>, ProbeUnreachableError>;
  }
>()("Jitney.ListPlatform") {}

type ListPlatformService = ListPlatform["Service"];

export interface DeploymentStatus {
  readonly name: string;
  readonly deploymentId: string;
  readonly phase: DeploymentReceipt["phase"];
  readonly version: string | null;
  readonly health: Exclude<ResourceClass, "orphan">;
  readonly repositoryCount: number;
  readonly appSlug: string | null;
  readonly appOwnerType: "User" | "Organization";
  readonly autoUpgrade: DeploymentReceipt["autoUpgrade"];
  readonly updateAvailable: boolean | null;
  readonly findings: readonly Finding[];
}

export interface ListReport {
  readonly deployments: readonly DeploymentStatus[];
  readonly orphans: readonly Finding[];
  readonly accountFindings: readonly Finding[];
  readonly latestVersion: string | null;
}

const unknownFinding = (resource: string, plane: ProbeUnreachableError["plane"]): Finding => ({
  class: "unknown",
  resource,
  message: `${resource} could not be checked because the ${plane} probe was inconclusive`,
  commands: [{ label: "inspect", command: "npx get-jitney list --json" }],
});

const missingFinding = (resource: string, message: string, receipt?: string): Finding => ({
  class: "missing",
  resource,
  message,
  ...(receipt === undefined ? {} : { receipt }),
});

const driftFinding = (
  resource: string,
  message: string,
  live: string,
  receipt: string,
): Finding => ({ class: "drifted", resource, message, live, receipt });

const versionOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const statusFromFindings = (findings: readonly Finding[]): Exclude<ResourceClass, "orphan"> => {
  if (findings.some((finding) => finding.class === "missing")) return "missing";
  if (findings.some((finding) => finding.class === "drifted")) return "drifted";
  if (findings.some((finding) => finding.class === "unknown")) return "unknown";
  return "ok";
};

const installationInventory = (installations: readonly GitHubInstallation[]): string =>
  Arr.flatMap(installations, (installation) =>
    Arr.map(
      installation.repositories,
      (repository) => `${installation.id}:${repository.id}:${repository.fullName}`,
    ),
  )
    .sort()
    .join(",");

const checkWorker = Effect.fn(function* (
  receipt: DeploymentReceipt,
  platform: ListPlatformService,
) {
  const observed = yield* Effect.result(
    platform.worker(receipt.cloudflare.accountId, receipt.cloudflare.workerName),
  );
  if (Result.isFailure(observed)) return [unknownFinding("worker", observed.failure.plane)];
  if (!observed.success.exists) {
    return [missingFinding("worker", `Worker ${receipt.cloudflare.workerName} is missing`)];
  }
  if (observed.success.version === null) {
    return [unknownFinding("worker.version", "cloudflare")];
  }
  if (observed.success.version !== receipt.versions.current) {
    return [
      driftFinding(
        "worker.version",
        `Worker reports ${observed.success.version}; receipt records ${receipt.versions.current ?? "none"}`,
        observed.success.version,
        receipt.versions.current ?? "none",
      ),
    ];
  }
  return [];
});

const checkApplication = (
  receipt: DeploymentReceipt,
  applications: Result.Result<readonly LiveApplication[], ProbeUnreachableError>,
): readonly Finding[] => {
  if (Result.isFailure(applications)) {
    return [unknownFinding("containerApplication", applications.failure.plane)];
  }
  if (receipt.cloudflare.applicationId === null) {
    return [
      missingFinding("containerApplication.receipt", "Receipt has no container application ID"),
    ];
  }
  const application = applications.success.find(
    (candidate) => candidate.id === receipt.cloudflare.applicationId,
  );
  if (application === undefined) {
    return [
      missingFinding(
        "containerApplication",
        `Container application ${receipt.cloudflare.applicationName} is missing`,
        receipt.cloudflare.applicationId,
      ),
    ];
  }
  const findings: Finding[] = [];
  if (application.name !== receipt.cloudflare.applicationName) {
    findings.push(
      driftFinding(
        "containerApplication.name",
        `Container application name differs from the receipt`,
        application.name,
        receipt.cloudflare.applicationName,
      ),
    );
  }
  const expectedTag = receipt.cloudflare.tags.current;
  if (expectedTag !== null && application.imageTag !== expectedTag) {
    findings.push(
      driftFinding(
        "containerApplication.image",
        `Image tag differs from the receipt`,
        application.imageTag ?? "none",
        expectedTag,
      ),
    );
  }
  return findings;
};

const checkRegistry = (
  receipt: DeploymentReceipt,
  observed: Result.Result<readonly string[], ProbeUnreachableError>,
): readonly Finding[] => {
  if (Result.isFailure(observed)) {
    return [unknownFinding("registry.tags", observed.failure.plane)];
  }
  const expected = [receipt.cloudflare.tags.current, receipt.cloudflare.tags.previous].filter(
    (tag): tag is string => tag !== null,
  );
  return expected
    .filter((tag) => !observed.success.includes(tag))
    .map((tag) => missingFinding("registry.tag", `Registry tag ${tag} is missing`, tag));
};

const checkGitHub = Effect.fn(function* (
  receipt: DeploymentReceipt,
  platform: ListPlatformService,
) {
  const observed = yield* Effect.result(platform.githubApp(receipt));
  if (Result.isFailure(observed)) {
    return [unknownFinding("githubApp", observed.failure.plane)];
  }
  if (!observed.success.appExists) {
    return [
      missingFinding(
        "githubApp",
        `GitHub App ${receipt.github.appSlug ?? receipt.github.appId ?? "unknown"} is missing`,
      ),
    ];
  }
  const findings: Finding[] = [];
  const receiptInstallations = installationInventory(receipt.github.installations);
  const liveInstallations = installationInventory(observed.success.installations);
  if (liveInstallations !== receiptInstallations) {
    findings.push(
      driftFinding(
        "installations",
        "GitHub App installations differ from the receipt",
        liveInstallations,
        receiptInstallations,
      ),
    );
  }
  for (const installation of observed.success.installations) {
    for (const repository of installation.repositories) {
      const ownership = observed.success.ownership.find(
        (candidate) => candidate.fullName === repository.fullName,
      );
      if (ownership === undefined || ownership.class === "missing") {
        findings.push(
          missingFinding(
            `ownership.${repository.fullName}`,
            `${repository.fullName} has no JITNEY_DEPLOYMENT variable`,
            receipt.id,
          ),
        );
      } else if (ownership.class === "unknown") {
        findings.push(unknownFinding(`ownership.${repository.fullName}`, "github"));
      } else if (ownership.class === "drifted") {
        findings.push(
          driftFinding(
            `ownership.${repository.fullName}`,
            `${repository.fullName} belongs to another deployment`,
            ownership.value ?? "another deployment",
            receipt.id,
          ),
        );
      }
    }
  }
  return findings;
});

export const listDeployments = Effect.fn(function* (accountIds: readonly string[] = []) {
  const receipts = yield* ListReceipts;
  const platform = yield* ListPlatform;
  const deployments = yield* receipts.list();
  const latestResult = yield* Effect.result(platform.latestVersion());
  const latestVersion = Result.isSuccess(latestResult)
    ? Option.getOrNull(latestResult.success)
    : null;
  const scannedAccounts = Arr.dedupe([
    ...accountIds,
    ...deployments.map((receipt) => receipt.cloudflare.accountId),
  ]);
  let applicationsByAccount = HashMap.empty<
    string,
    Result.Result<readonly LiveApplication[], ProbeUnreachableError>
  >();
  let workersByAccount = HashMap.empty<
    string,
    Result.Result<readonly string[], ProbeUnreachableError>
  >();
  for (const accountId of scannedAccounts) {
    applicationsByAccount = HashMap.set(
      applicationsByAccount,
      accountId,
      yield* Effect.result(platform.containerApplications(accountId)),
    );
    workersByAccount = HashMap.set(
      workersByAccount,
      accountId,
      yield* Effect.result(platform.workerNames(accountId)),
    );
  }

  const referencedApplications = HashSet.fromIterable(
    Arr.flatMap(deployments, (receipt) =>
      receipt.cloudflare.applicationId === null ? [] : [receipt.cloudflare.applicationId],
    ),
  );
  const referencedWorkers = HashSet.fromIterable(
    deployments.map(
      (receipt) => `${receipt.cloudflare.accountId}:${receipt.cloudflare.workerName}`,
    ),
  );
  const orphans: Finding[] = [];
  const accountFindings: Finding[] = [];
  for (const accountId of scannedAccounts) {
    const applications = HashMap.get(applicationsByAccount, accountId);
    if (Option.isSome(applications) && Result.isSuccess(applications.value)) {
      for (const application of applications.value.success) {
        if (
          !HashSet.has(referencedApplications, application.id) &&
          application.name.includes("-runner")
        ) {
          const owner = deployments.find((receipt) =>
            application.name.startsWith(`${receipt.name}-runner`),
          );
          orphans.push({
            class: "orphan",
            resource: "containerApplication",
            live: `${application.name} (${application.id})`,
            message: `Container application ${application.name} has no deployment receipt`,
            commands: [
              ...(owner === undefined
                ? []
                : [
                    {
                      label: "adopt" as const,
                      command: `npx get-jitney repair ${owner.name} --adopt application:${application.id}`,
                    },
                  ]),
              { label: "inspect", command: "npx get-jitney list --json" },
            ],
          });
        }
      }
    } else if (!deployments.some((receipt) => receipt.cloudflare.accountId === accountId)) {
      accountFindings.push(unknownFinding("containerApplications", "cloudflare"));
    }
    const workers = HashMap.get(workersByAccount, accountId);
    if (Option.isSome(workers) && Result.isSuccess(workers.value)) {
      for (const name of workers.value.success) {
        if (!HashSet.has(referencedWorkers, `${accountId}:${name}`)) {
          orphans.push({
            class: "orphan",
            resource: "worker",
            live: name,
            message: `Worker ${name} has no deployment receipt`,
            commands: [{ label: "inspect", command: "npx get-jitney list --json" }],
          });
        }
      }
    } else if (!deployments.some((receipt) => receipt.cloudflare.accountId === accountId)) {
      accountFindings.push(unknownFinding("workers", "cloudflare"));
    }
  }

  const statuses: DeploymentStatus[] = [];
  for (const receipt of deployments) {
    const applicationResult = HashMap.get(applicationsByAccount, receipt.cloudflare.accountId);
    const registryResult = yield* Effect.result(
      platform.registryTags(receipt.cloudflare.accountId, receipt.cloudflare.registryRepo),
    );
    const findings = [
      ...(yield* checkWorker(receipt, platform)),
      ...(Option.isNone(applicationResult)
        ? [unknownFinding("containerApplication", "cloudflare")]
        : checkApplication(receipt, applicationResult.value)),
      ...checkRegistry(receipt, registryResult),
      ...(yield* checkGitHub(receipt, platform)),
      ...(Result.isFailure(latestResult) ? [unknownFinding("release.latest", "release")] : []),
    ];
    const actionableFindings = findings.map((finding) =>
      finding.class === "unknown" || finding.commands !== undefined
        ? finding
        : {
            ...finding,
            commands: [
              { label: "repair" as const, command: `npx get-jitney repair ${receipt.name}` },
              { label: "inspect" as const, command: "npx get-jitney list --json" },
            ],
          },
    );
    if (Result.isSuccess(registryResult)) {
      const expected = [receipt.cloudflare.tags.current, receipt.cloudflare.tags.previous].filter(
        (tag): tag is string => tag !== null,
      );
      for (const tag of registryResult.success.filter(
        (candidate) => !expected.includes(candidate),
      )) {
        orphans.push({
          class: "orphan",
          resource: "registry.tag",
          live: `${receipt.cloudflare.registryRepo}:${tag}`,
          message: `Registry tag ${tag} has no receipt reference`,
          commands: [{ label: "inspect", command: "npx get-jitney list --json" }],
        });
      }
    }
    statuses.push({
      name: receipt.name,
      deploymentId: receipt.id,
      phase: receipt.phase,
      version: receipt.versions.current,
      health: statusFromFindings(actionableFindings),
      repositoryCount: receipt.github.installations.reduce(
        (count, installation) => count + installation.repositories.length,
        0,
      ),
      appSlug: receipt.github.appSlug,
      appOwnerType: receipt.github.ownerType,
      autoUpgrade: receipt.autoUpgrade,
      updateAvailable:
        latestVersion === null || receipt.versions.current === null
          ? null
          : versionOrder.compare(latestVersion, receipt.versions.current) > 0,
      findings: actionableFindings,
    });
  }

  return { deployments: statuses, orphans, accountFindings, latestVersion } satisfies ListReport;
});

const cell = (value: string, width: number): string => value.padEnd(width);

export function renderListReport(report: ListReport): string {
  if (
    report.deployments.length === 0 &&
    report.orphans.length === 0 &&
    report.accountFindings.length === 0
  ) {
    return "No Jitney deployments found.";
  }
  const rows = report.deployments.map((deployment) => [
    deployment.name,
    deployment.version ?? "-",
    deployment.health,
    String(deployment.repositoryCount),
    deployment.appSlug === null
      ? "-"
      : `${deployment.appSlug} (${deployment.appOwnerType.toLowerCase()})`,
    deployment.autoUpgrade.enabled ? deployment.autoUpgrade.channel : "off",
  ]);
  const headers = ["NAME", "VERSION", "HEALTH", "REPOS", "APP", "AUTO-UPGRADE"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const lines = [
    headers.map((header, index) => cell(header, widths[index]!)).join("  "),
    ...rows.map((row) => row.map((value, index) => cell(value, widths[index]!)).join("  ")),
  ];
  for (const deployment of report.deployments) {
    if (
      deployment.updateAvailable === true &&
      deployment.version !== null &&
      report.latestVersion !== null
    ) {
      lines.push(
        "",
        `${deployment.name}: update available ${deployment.version} → ${report.latestVersion} (${deployment.autoUpgrade.enabled ? deployment.autoUpgrade.channel : "auto-upgrade off"})`,
      );
    }
    if (deployment.findings.length === 0) continue;
    lines.push(
      "",
      `${deployment.name}: ${deployment.findings.length} finding${deployment.findings.length === 1 ? "" : "s"}`,
    );
    for (const finding of deployment.findings) {
      lines.push(`  - ${finding.class} ${finding.resource}: ${finding.message}`);
      for (const command of finding.commands ?? []) {
        lines.push(`    ${command.label}: ${command.command}`);
      }
    }
  }
  if (report.accountFindings.length > 0) {
    lines.push("", `Account findings: ${report.accountFindings.length}`);
    for (const finding of report.accountFindings) {
      lines.push(`  - ${finding.class} ${finding.resource}: ${finding.message}`);
    }
  }
  if (report.orphans.length > 0) {
    lines.push("", `Orphans: ${report.orphans.length}`);
    for (const orphan of report.orphans) {
      lines.push(`  - orphan ${orphan.live}: ${orphan.message}`);
      for (const command of orphan.commands ?? []) {
        lines.push(`    ${command.label}: ${command.command}`);
      }
    }
  }
  return lines.join("\n");
}

export type ListError = ReceiptReadError;
