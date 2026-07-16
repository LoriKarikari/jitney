import { verify } from "@octokit/webhooks-methods";
import { Either, Schema } from "effect";
import { isAdmissible, type WorkflowEvent } from "./domain";

const payloadLimit = 1_048_576;

export type DeliveryClassification =
  | {
      status: 202;
      outcome: "accepted";
      deliveryId: string;
      event: WorkflowEvent;
    }
  | {
      status: 204;
      outcome: "ignored";
      deliveryId: string | null;
    }
  | {
      status: 400;
      outcome: "malformed";
      deliveryId: string | null;
    }
  | {
      status: 401;
      outcome: "invalid_signature";
      deliveryId: string | null;
    }
  | {
      status: 413;
      outcome: "payload_too_large";
      deliveryId: string | null;
    };

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

export async function classifyDelivery(
  request: Request,
  webhookSecret: string,
): Promise<DeliveryClassification> {
  const deliveryId = request.headers.get("X-GitHub-Delivery");
  let body: Uint8Array | undefined;
  try {
    body = await readBoundedBody(request);
  } catch {
    return { status: 400, outcome: "malformed", deliveryId };
  }
  if (body === undefined) return { status: 413, outcome: "payload_too_large", deliveryId };

  const signature = request.headers.get("X-Hub-Signature-256");
  const bodyText = new TextDecoder().decode(body);
  if (signature === null || !(await verifySignature(webhookSecret, bodyText, signature))) {
    return { status: 401, outcome: "invalid_signature", deliveryId };
  }

  if (request.headers.get("X-GitHub-Event") !== "workflow_job") {
    return { status: 204, outcome: "ignored", deliveryId };
  }
  if (deliveryId === null) return { status: 400, outcome: "malformed", deliveryId };

  const event = decodeWorkflowEvent(deliveryId, bodyText);
  if (event === "ignored") return { status: 204, outcome: "ignored", deliveryId };
  if (event === "malformed") return { status: 400, outcome: "malformed", deliveryId };
  return { status: 202, outcome: "accepted", deliveryId, event };
}

async function readBoundedBody(request: Request): Promise<Uint8Array | undefined> {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > payloadLimit) return undefined;
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > payloadLimit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!/^sha256=[\da-f]{64}$/i.test(signature)) return false;
  try {
    return await verify(secret, body, signature);
  } catch {
    return false;
  }
}

function decodeWorkflowEvent(
  deliveryId: string,
  body: string,
): WorkflowEvent | "ignored" | "malformed" {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return "malformed";
  }

  const action = Schema.decodeUnknownEither(
    Schema.Struct({ action: Schema.Literal("queued", "in_progress", "completed") }),
  )(json);
  if (Either.isLeft(action)) return "ignored";

  const decoded = Schema.decodeUnknownEither(Payload)(json);
  if (Either.isLeft(decoded)) return "malformed";
  const payload = decoded.right;
  if (!isAdmissible(payload.repository.private, payload.workflow_job.labels)) return "ignored";

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
  return event;
}
