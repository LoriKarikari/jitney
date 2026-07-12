export type RunnerCorrelation = {
  installationId: number;
  repositoryId: number;
  workflowJobId: number;
  runnerName: string;
  containerName: string;
};

type DeliveryCorrelation = {
  deliveryId: string;
  deploymentId?: string | undefined;
};

type ProvisioningCorrelation = DeliveryCorrelation & RunnerCorrelation;

type ContainerCorrelation = RunnerCorrelation & {
  containerId: string;
  deploymentId: string;
};

export type LifecycleRecord =
  | { event: "webhook_received"; deliveryId: string | null; deploymentId: string; action: string }
  | {
      event: "webhook_classified";
      deliveryId: string | null;
      deploymentId: string;
      outcome: string;
      installationId?: number | undefined;
      repositoryId?: number | undefined;
      workflowJobId?: number | undefined;
      runnerName?: string | undefined;
      action?: string | undefined;
    }
  | (DeliveryCorrelation & {
      event: "scheduler_transition";
      installationId: number;
      repositoryId: number;
      workflowJobId: number;
      action: string;
      outcome: string;
      attempt?: number | undefined;
      runnerName?: string | undefined;
      containerName?: string | undefined;
      state?: string | undefined;
      conclusion?: string | undefined;
    })
  | (ProvisioningCorrelation & {
      event: "runner_provisioning_started" | "runner_provisioning_succeeded";
    })
  | (ProvisioningCorrelation & { event: "runner_provisioning_failed"; step: string })
  | (RunnerCorrelation & {
      event: "runner_attempt_expired";
      attempt: number;
      stopReason: string;
      deploymentId?: string | undefined;
    })
  | (RunnerCorrelation & {
      event: "runner_reclaim_failed";
      step: string;
      deploymentId?: string | undefined;
    })
  | (ContainerCorrelation & { event: "runner_container_started" })
  | (ContainerCorrelation & {
      event: "runner_container_stopped";
      exitCode: number;
      stopReason: string;
    })
  | (ContainerCorrelation & { event: "runner_container_failed"; outcome: string });

type KeysOfUnion<Record> = Record extends unknown ? keyof Record : never;
type LifecycleFieldName = KeysOfUnion<LifecycleRecord>;

const allowedFields = [
  "event",
  "deliveryId",
  "installationId",
  "repositoryId",
  "workflowJobId",
  "attempt",
  "runnerName",
  "containerName",
  "containerId",
  "deploymentId",
  "action",
  "outcome",
  "state",
  "step",
  "conclusion",
  "stopReason",
  "exitCode",
] as const satisfies readonly LifecycleFieldName[];

const sensitive = [
  /-----BEGIN [^-]+-----[\s\S]*-----END [^-]+-----/,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsha256=[a-fA-F0-9]{64}\b/,
  /\b[A-Za-z0-9+/]{160,}={0,2}\b/,
];

const warningOutcomes = new Set(["payload_too_large", "invalid_signature", "malformed"]);

export function emit(record: LifecycleRecord): void {
  const fields: Partial<Record<LifecycleFieldName, string | number | null | undefined>> = record;
  const safe: Record<string, string | number> = { timestamp: Date.now() };
  for (const key of allowedFields) {
    const value = fields[key];
    if (value !== undefined && value !== null) safe[key] = redact(value);
  }
  console[level(record)](JSON.stringify(safe));
}

function level(record: LifecycleRecord): "log" | "warn" | "error" {
  if (record.event.endsWith("_failed")) return "error";
  if (record.event === "webhook_classified" && warningOutcomes.has(record.outcome)) return "warn";
  return "log";
}

function redact(value: string | number): string | number {
  if (typeof value === "number") return value;
  return sensitive.some((pattern) => pattern.test(value)) ? "[REDACTED]" : value;
}
