import { Either, Schema } from "effect";

type WorkflowAction = "queued" | "in_progress" | "completed";

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

const Payload = Schema.Struct({
  action: Schema.Literal("queued", "in_progress", "completed"),
  installation: Schema.Struct({ id: Schema.Number }),
  repository: Schema.Struct({
    id: Schema.Number,
    name: Schema.String,
    private: Schema.Boolean,
    owner: Schema.Struct({ login: Schema.String }),
  }),
  workflow_job: Schema.Struct({
    id: Schema.Number,
    labels: Schema.Array(Schema.String),
    runner_name: Schema.NullishOr(Schema.String),
    conclusion: Schema.NullishOr(Schema.String),
  }),
});

export function parseWorkflowEvent(
  eventName: string | null,
  deliveryId: string | null,
  body: ArrayBuffer,
): ParseResult {
  if (eventName !== "workflow_job") return { kind: "ignored" };
  if (!deliveryId) return { kind: "malformed" };

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { kind: "malformed" };
  }

  const action = Schema.decodeUnknownEither(
    Schema.Struct({ action: Schema.Literal("queued", "in_progress", "completed") }),
  )(json);
  if (Either.isLeft(action)) return { kind: "ignored" };

  const decoded = Schema.decodeUnknownEither(Payload)(json);
  if (Either.isLeft(decoded)) return { kind: "malformed" };
  const payload = decoded.right;

  if (
    !payload.repository.private ||
    payload.workflow_job.labels.length !== 1 ||
    payload.workflow_job.labels[0] !== "jitney"
  ) {
    return { kind: "ignored" };
  }

  const event: WorkflowEvent = {
    deliveryId,
    action: payload.action,
    installationId: payload.installation.id,
    repositoryId: payload.repository.id,
    repositoryOwner: payload.repository.owner.login,
    repositoryName: payload.repository.name,
    repositoryPrivate: payload.repository.private,
    workflowJobId: payload.workflow_job.id,
    labels: [...payload.workflow_job.labels],
  };

  if (payload.action === "in_progress" && payload.workflow_job.runner_name != null) {
    event.runnerName = payload.workflow_job.runner_name;
  }
  if (payload.action === "completed" && payload.workflow_job.conclusion != null) {
    event.conclusion = payload.workflow_job.conclusion;
  }

  return { kind: "accepted", event };
}
