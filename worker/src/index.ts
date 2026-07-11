import { verify } from "@octokit/webhooks-methods";
import { parseWorkflowEvent } from "./domain";

export { RunnerContainer } from "./runner-container";
export { Scheduler } from "./scheduler";

async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
    return new Response(null, { status: 404 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > 1_048_576) return new Response(null, { status: 413 });

  const signature = request.headers.get("X-Hub-Signature-256");
  const bodyText = new TextDecoder().decode(body);
  if (!signature || !(await verify(env.GITHUB_WEBHOOK_SECRET, bodyText, signature))) {
    return new Response(null, { status: 401 });
  }

  const parsed = parseWorkflowEvent(
    request.headers.get("X-GitHub-Event"),
    request.headers.get("X-GitHub-Delivery"),
    body,
  );
  if (parsed.kind === "malformed") return new Response(null, { status: 400 });
  if (parsed.kind === "ignored") return new Response(null, { status: 204 });

  const result = await env.SCHEDULER.getByName("global").accept(parsed.event);
  console.log(
    JSON.stringify({
      event: "workflow_event_accepted",
      deliveryId: parsed.event.deliveryId,
      workflowJobId: parsed.event.workflowJobId,
      runnerName: result.runnerName,
      outcome: result.outcome,
    }),
  );
  return new Response(null, { status: 202 });
}

export default { fetch } satisfies ExportedHandler<Env>;
