import { verify } from "@octokit/webhooks-methods";
import { parseWorkflowEvent } from "./domain";

export { RunnerContainer } from "./runner-container";
export { Scheduler } from "./scheduler";

async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
    return new Response(null, { status: 404 });
  }

  const deliveryId = request.headers.get("X-GitHub-Delivery");
  const eventName = request.headers.get("X-GitHub-Event");
  const body = await request.arrayBuffer();
  if (body.byteLength > 1_048_576) {
    console.warn(JSON.stringify({ event: "webhook_classified", deliveryId, outcome: "rejected" }));
    return new Response(null, { status: 413 });
  }

  const signature = request.headers.get("X-Hub-Signature-256");
  const bodyText = new TextDecoder().decode(body);
  if (!signature || !(await verify(env.GITHUB_WEBHOOK_SECRET, bodyText, signature))) {
    console.warn(JSON.stringify({ event: "webhook_classified", deliveryId, outcome: "rejected" }));
    return new Response(null, { status: 401 });
  }

  const parsed = parseWorkflowEvent(eventName, deliveryId, body);
  if (parsed.kind === "malformed") {
    console.warn(JSON.stringify({ event: "webhook_classified", deliveryId, outcome: "malformed" }));
    return new Response(null, { status: 400 });
  }
  if (parsed.kind === "ignored") {
    console.log(JSON.stringify({ event: "webhook_classified", deliveryId, outcome: "ignored" }));
    return new Response(null, { status: 204 });
  }

  const result = await env.SCHEDULER.getByName("global-v2").accept(parsed.event);
  console.log(
    JSON.stringify({
      event: "webhook_classified",
      deliveryId: parsed.event.deliveryId,
      workflowJobId: parsed.event.workflowJobId,
      runnerName: result.runnerName,
      outcome: result.outcome,
    }),
  );
  return new Response(null, { status: 202 });
}

export default { fetch } satisfies ExportedHandler<Env>;
