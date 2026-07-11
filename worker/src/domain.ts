export type WorkflowAction = "queued" | "in_progress" | "completed";

export type WorkflowEvent = {
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
};

export type ParseResult =
  | { kind: "accepted"; event: WorkflowEvent }
  | { kind: "ignored" }
  | { kind: "malformed" };

export function parseWorkflowEvent(
  eventName: string | null,
  deliveryId: string | null,
  body: ArrayBuffer,
): ParseResult {
  if (eventName !== "workflow_job") return { kind: "ignored" };
  if (!deliveryId) return { kind: "malformed" };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { kind: "malformed" };
  }

  const action = payload.action;
  if (action !== "queued" && action !== "in_progress" && action !== "completed") {
    return { kind: "ignored" };
  }

  const repository = payload.repository as Record<string, unknown> | undefined;
  const owner = repository?.owner as Record<string, unknown> | undefined;
  const installation = payload.installation as Record<string, unknown> | undefined;
  const job = payload.workflow_job as Record<string, unknown> | undefined;

  const rawLabels = job?.labels;
  if (!Array.isArray(rawLabels) || !rawLabels.every((l) => typeof l === "string")) {
    return { kind: "malformed" };
  }

  const installationId = installation?.id;
  const repositoryId = repository?.id;
  const repositoryOwner = owner?.login;
  const repositoryName = repository?.name;
  const workflowJobId = job?.id;

  if (
    typeof installationId !== "number" ||
    typeof repositoryId !== "number" ||
    typeof repositoryOwner !== "string" ||
    typeof repositoryName !== "string" ||
    typeof workflowJobId !== "number"
  ) {
    return { kind: "malformed" };
  }

  if (repository?.private !== true || rawLabels.length !== 1 || rawLabels[0] !== "jitney") {
    return { kind: "ignored" };
  }

  const event: WorkflowEvent = {
    deliveryId,
    action,
    installationId,
    repositoryId,
    repositoryOwner,
    repositoryName,
    repositoryPrivate: true,
    workflowJobId,
    labels: rawLabels,
  };

  if (action === "in_progress") {
    const runnerName = job?.runner_name;
    if (typeof runnerName === "string") event.runnerName = runnerName;
  }
  if (action === "completed") {
    const conclusion = job?.conclusion;
    if (typeof conclusion === "string") event.conclusion = conclusion;
  }

  return { kind: "accepted", event };
}
