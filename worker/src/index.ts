import { parseWorkflowEvent } from "./domain";
export { RunnerContainer } from "./runner-container";
export { Scheduler } from "./scheduler";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
      return new Response(null, { status: 404 });
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > 1_048_576) return new Response(null, { status: 413 });

    const signatureHeader = request.headers.get("X-Hub-Signature-256");
    if (!signatureHeader?.startsWith("sha256=")) return new Response(null, { status: 401 });

    const hex = signatureHeader.slice(7);
    if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) return new Response(null, { status: 401 });

    const supplied = Uint8Array.from({ length: 32 }, (_, i) =>
      Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = await crypto.subtle.sign("HMAC", key, body);
    if (!crypto.subtle.timingSafeEqual(expected, supplied)) {
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
  },
} satisfies ExportedHandler<Env>;
