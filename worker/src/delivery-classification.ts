import { verify } from "@octokit/webhooks-methods";
import { Data, Effect, Result, Schema } from "effect";
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

class BodyReadError extends Data.TaggedError("BodyReadError")<{ cause: unknown }> {}
class SignatureVerificationError extends Data.TaggedError("SignatureVerificationError")<{
  cause: unknown;
}> {}

const Action = Schema.Struct({
  action: Schema.Literals(["queued", "in_progress", "completed"]),
});

const Payload = Schema.Struct({
  action: Schema.Literals(["queued", "in_progress", "completed"]),
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
    runner_name: Schema.optionalKey(Schema.NullishOr(Schema.String)),
    conclusion: Schema.optionalKey(Schema.NullishOr(Schema.String)),
  }),
});

const decodeJson = Schema.decodeUnknownResult(Schema.UnknownFromJsonString);
const decodeAction = Schema.decodeUnknownResult(Action);
const decodePayload = Schema.decodeUnknownResult(Payload);

export const classifyDelivery: (
  request: Request,
  webhookSecret: string,
) => Effect.Effect<DeliveryClassification> = Effect.fn("IngressWorker.classifyDelivery")(function* (
  request: Request,
  webhookSecret: string,
) {
  const deliveryId = request.headers.get("X-GitHub-Delivery");
  const read = yield* readBoundedBody(request).pipe(Effect.result);
  if (Result.isFailure(read)) return { status: 400, outcome: "malformed", deliveryId } as const;
  if (read.success === undefined) {
    return { status: 413, outcome: "payload_too_large", deliveryId } as const;
  }

  const signature = request.headers.get("X-Hub-Signature-256");
  const bodyText = new TextDecoder().decode(read.success);
  const valid =
    signature === null ? false : yield* verifySignature(webhookSecret, bodyText, signature);
  if (!valid) return { status: 401, outcome: "invalid_signature", deliveryId } as const;

  if (request.headers.get("X-GitHub-Event") !== "workflow_job") {
    return { status: 204, outcome: "ignored", deliveryId } as const;
  }
  if (deliveryId === null) return { status: 400, outcome: "malformed", deliveryId } as const;

  const event = decodeWorkflowEvent(deliveryId, bodyText);
  if (event === "ignored") return { status: 204, outcome: "ignored", deliveryId } as const;
  if (event === "malformed") return { status: 400, outcome: "malformed", deliveryId } as const;
  return { status: 202, outcome: "accepted", deliveryId, event } as const;
});

function readBoundedBody(request: Request): Effect.Effect<Uint8Array | undefined, BodyReadError> {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > payloadLimit) {
    return Effect.succeed(undefined);
  }
  if (request.body === null) return Effect.succeed(new Uint8Array());

  return Effect.acquireUseRelease(
    Effect.try({
      try: () => request.body!.getReader(),
      catch: (cause) => new BodyReadError({ cause }),
    }),
    (reader) =>
      Effect.tryPromise({
        try: async () => {
          const chunks: Uint8Array[] = [];
          let length = 0;
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

          const body = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return body;
        },
        catch: (cause) => new BodyReadError({ cause }),
      }),
    (reader) => Effect.sync(() => reader.releaseLock()),
  );
}

function verifySignature(secret: string, body: string, signature: string): Effect.Effect<boolean> {
  if (!/^sha256=[\da-f]{64}$/i.test(signature)) return Effect.succeed(false);
  return Effect.tryPromise({
    try: () => verify(secret, body, signature),
    catch: (cause) => new SignatureVerificationError({ cause }),
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

function decodeWorkflowEvent(
  deliveryId: string,
  body: string,
): WorkflowEvent | "ignored" | "malformed" {
  const json = decodeJson(body);
  if (Result.isFailure(json)) return "malformed";
  if (Result.isFailure(decodeAction(json.success))) return "ignored";

  const decoded = decodePayload(json.success);
  if (Result.isFailure(decoded)) return "malformed";
  const payload = decoded.success;
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
