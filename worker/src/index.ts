import { verify } from "@octokit/webhooks-methods";
import { parseWorkflowEvent } from "./domain";
import { emit } from "./log";

export { RunnerContainer } from "./runner-container";
export { Scheduler } from "./scheduler";

async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
    return new Response(null, { status: 404 });
  }

  const deliveryId = request.headers.get("X-GitHub-Delivery");
  const eventName = request.headers.get("X-GitHub-Event");
  const deploymentId = env.CF_VERSION_METADATA.id;
  emit({
    event: "webhook_received",
    deliveryId,
    deploymentId,
    action: eventName ?? "unknown",
  });

  const body = await request.arrayBuffer();
  if (body.byteLength > 1_048_576) {
    emit({
      event: "webhook_classified",
      deliveryId,
      deploymentId,
      outcome: "payload_too_large",
    });
    return new Response(null, { status: 413 });
  }

  const signature = request.headers.get("X-Hub-Signature-256");
  const bodyText = new TextDecoder().decode(body);
  if (!signature || !(await verify(env.GITHUB_WEBHOOK_SECRET, bodyText, signature))) {
    emit({
      event: "webhook_classified",
      deliveryId,
      deploymentId,
      outcome: "invalid_signature",
    });
    return new Response(null, { status: 401 });
  }

  if (eventName !== "workflow_job") {
    emit({ event: "webhook_classified", deliveryId, deploymentId, outcome: "ignored" });
    return new Response(null, { status: 204 });
  }
  if (deliveryId === null) {
    emit({ event: "webhook_classified", deliveryId, deploymentId, outcome: "malformed" });
    return new Response(null, { status: 400 });
  }

  const parsed = parseWorkflowEvent(deliveryId, body);
  if (parsed.kind === "malformed") {
    emit({ event: "webhook_classified", deliveryId, deploymentId, outcome: "malformed" });
    return new Response(null, { status: 400 });
  }
  if (parsed.kind === "ignored") {
    emit({ event: "webhook_classified", deliveryId, deploymentId, outcome: "ignored" });
    return new Response(null, { status: 204 });
  }

  const event = parsed.event;
  const result = await env.SCHEDULER.getByName("global-v2").accept(event);
  const { installationId, repositoryId, workflowJobId, action } = event;
  const { runnerName, outcome } = result;
  emit({
    event: "webhook_classified",
    deliveryId,
    deploymentId,
    installationId,
    repositoryId,
    workflowJobId,
    runnerName,
    action,
    outcome,
  });
  return new Response(null, { status: 202 });
}

export default { fetch };
