import { classifyDelivery } from "./delivery-classification";
import { discoverQueuedJobs } from "./github";
import { reconcile } from "./reconciliation";
import { emit } from "./log";

export { RunnerContainer } from "./runner-container";
export { Scheduler } from "./scheduler";

async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
    return new Response(null, { status: 404 });
  }

  const eventName = request.headers.get("X-GitHub-Event");
  const deploymentId = env.CF_VERSION_METADATA.id;
  emit({
    event: "webhook_received",
    deliveryId: request.headers.get("X-GitHub-Delivery"),
    deploymentId,
    action: eventName ?? "unknown",
  });

  const classification = await classifyDelivery(request, env.GITHUB_WEBHOOK_SECRET);
  let telemetry;
  if (classification.outcome === "accepted") {
    const event = classification.event;
    const { runnerName, outcome } = await env.SCHEDULER.getByName("global-v3").accept(event);
    const { installationId, repositoryId, workflowJobId, action } = event;
    telemetry = {
      installationId,
      repositoryId,
      workflowJobId,
      runnerName,
      action,
      outcome,
    };
  } else {
    telemetry = { outcome: classification.outcome };
  }
  emit({
    event: "webhook_classified",
    deliveryId: classification.deliveryId,
    deploymentId,
    ...telemetry,
  });
  return new Response(null, { status: classification.status });
}

async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  await reconcile(
    discoverQueuedJobs({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }),
    (candidate) => env.SCHEDULER.getByName("global-v3").reconcile(candidate),
    env.CF_VERSION_METADATA.id,
  );
}

export default { fetch, scheduled };
