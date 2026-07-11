export type WorkflowAction = "queued" | "in_progress" | "completed";

export interface WorkflowEvent {
  deliveryId: string;
  action: WorkflowAction;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  repositoryPrivate: boolean;
  workflowJobId: number;
  labels: string[];
  runnerName?: string;
  conclusion?: string;
}

export type ParseResult =
  | { kind: "accepted"; event: WorkflowEvent }
  | { kind: "ignored" }
  | { kind: "malformed" };

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null ? (value as RecordValue) : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseWorkflowEvent(
  eventName: string | null,
  deliveryId: string | null,
  body: ArrayBuffer,
): ParseResult {
  if (eventName !== "workflow_job") return { kind: "ignored" };
  if (deliveryId === null || deliveryId.length === 0) return { kind: "malformed" };

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { kind: "malformed" };
  }

  const payload = record(decoded);
  const repository = record(payload?.repository);
  const owner = record(repository?.owner);
  const installation = record(payload?.installation);
  const job = record(payload?.workflow_job);
  const action = string(payload?.action);

  if (action !== "queued" && action !== "in_progress" && action !== "completed") {
    return { kind: "ignored" };
  }

  const rawLabels = job?.labels;
  if (!Array.isArray(rawLabels) || !rawLabels.every((label) => typeof label === "string")) {
    return { kind: "malformed" };
  }

  const event: WorkflowEvent = {
    deliveryId,
    action,
    installationId: integer(installation?.id) ?? 0,
    repositoryId: integer(repository?.id) ?? 0,
    repositoryOwner: string(owner?.login) ?? "",
    repositoryName: string(repository?.name) ?? "",
    repositoryPrivate: repository?.private === true,
    workflowJobId: integer(job?.id) ?? 0,
    labels: rawLabels,
  };

  const runnerName = string(job?.runner_name);
  if (action === "in_progress" && runnerName !== undefined) event.runnerName = runnerName;
  const conclusion = string(job?.conclusion);
  if (action === "completed" && conclusion !== undefined) event.conclusion = conclusion;

  if (
    event.installationId === 0 ||
    event.repositoryId === 0 ||
    event.repositoryOwner.length === 0 ||
    event.repositoryName.length === 0 ||
    event.workflowJobId === 0
  ) {
    return { kind: "malformed" };
  }

  if (!event.repositoryPrivate || rawLabels.length !== 1 || rawLabels[0] !== "jitney") {
    return { kind: "ignored" };
  }

  return { kind: "accepted", event };
}
