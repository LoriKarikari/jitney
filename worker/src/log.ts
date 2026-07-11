export type LogLevel = "info" | "warn" | "error";

export type LifecycleEvent =
  | "webhook_received"
  | "webhook_classified"
  | "scheduler_transition"
  | "runner_provisioning_started"
  | "runner_provisioning_succeeded"
  | "runner_provisioning_failed"
  | "runner_container_started"
  | "runner_container_stopped"
  | "runner_container_failed";

type StringFieldName =
  | "runnerName"
  | "containerName"
  | "containerId"
  | "deploymentId"
  | "action"
  | "outcome"
  | "state"
  | "step"
  | "conclusion"
  | "stopReason";

type NumberFieldName = "installationId" | "repositoryId" | "workflowJobId" | "attempt" | "exitCode";

type OptionalRecord<Key extends PropertyKey, Value> = Partial<Record<Key, Value | undefined>>;

export type LifecycleFields = OptionalRecord<StringFieldName, string> &
  OptionalRecord<NumberFieldName, number> &
  OptionalRecord<"deliveryId", string | null>;

const allowedFields = [
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
] as const satisfies readonly (keyof LifecycleFields)[];

const sensitive = [
  /-----BEGIN [^-]+-----[\s\S]*-----END [^-]+-----/,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsha256=[a-fA-F0-9]{64}\b/,
  /\b[A-Za-z0-9+/]{160,}={0,2}\b/,
];

export function emit(level: LogLevel, event: LifecycleEvent, fields: LifecycleFields = {}): void {
  const record: Record<string, string | number> = { event, timestamp: Date.now() };
  for (const key of allowedFields) {
    const value = fields[key];
    if (value !== undefined && value !== null) record[key] = redact(value);
  }
  console[level === "info" ? "log" : level](JSON.stringify(record));
}

function redact(value: string | number): string | number {
  if (typeof value === "number") return value;
  return sensitive.some((pattern) => pattern.test(value)) ? "[REDACTED]" : value;
}
