import { Data, Effect, Schema } from "effect";
import { classifyDelivery } from "./delivery-classification";
import { discoverQueuedJobs } from "./github";
import { reconcile } from "./reconciliation";
import {
  LifecycleGitHub,
  OwnershipRewriteRequest,
  lifecycleStatus,
  makeLifecycleGitHub,
  rewriteLifecycleOwnership,
} from "./lifecycle-status";
import { emit } from "./log";

export { RunnerContainer } from "./runner-container";
export { Scheduler } from "./scheduler";

class SchedulerRpcError extends Data.TaggedError("SchedulerRpcError")<{ cause: unknown }> {}

const handleRequest = Effect.fn("IngressWorker.fetch")(function* (request: Request, env: Env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok", version: env.JITNEY_VERSION });
  }
  if (request.method === "GET" && url.pathname === "/lifecycle/status") {
    if (request.headers.get("X-Jitney-Deployment") !== env.JITNEY_DEPLOYMENT) {
      return new Response(null, { status: 404 });
    }
    return yield* lifecycleStatus(env).pipe(
      Effect.provideService(LifecycleGitHub, makeLifecycleGitHub(env)),
      Effect.map((status) => Response.json(status, { headers: { "Cache-Control": "no-store" } })),
      Effect.catch(() => Effect.succeed(Response.json({ status: "unknown" }, { status: 503 }))),
    );
  }
  if (request.method === "POST" && url.pathname === "/lifecycle/ownership") {
    if (request.headers.get("X-Jitney-Deployment") !== env.JITNEY_DEPLOYMENT) {
      return new Response(null, { status: 404 });
    }
    return yield* Effect.tryPromise({
      try: () => request.json(),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap((body) =>
        Effect.try({
          try: () => Schema.decodeUnknownSync(OwnershipRewriteRequest)(body),
          catch: (cause) => cause,
        }),
      ),
      Effect.flatMap((rewrite) =>
        rewriteLifecycleOwnership(env, rewrite.repositories).pipe(
          Effect.provideService(LifecycleGitHub, makeLifecycleGitHub(env)),
        ),
      ),
      Effect.map((done) => new Response(null, { status: done ? 204 : 409 })),
      Effect.catch(() => Effect.succeed(new Response(null, { status: 503 }))),
    );
  }
  if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
    return new Response(null, { status: 404 });
  }

  const eventName = request.headers.get("X-GitHub-Event");
  const deploymentId = env.CF_VERSION_METADATA.id;
  yield* Effect.sync(() =>
    emit({
      event: "webhook_received",
      deliveryId: request.headers.get("X-GitHub-Delivery"),
      deploymentId,
      action: eventName ?? "unknown",
    }),
  );

  const classification = yield* classifyDelivery(request, env.GITHUB_WEBHOOK_SECRET);
  if (classification.outcome !== "accepted") {
    yield* Effect.sync(() =>
      emit({
        event: "webhook_classified",
        deliveryId: classification.deliveryId,
        deploymentId,
        outcome: classification.outcome,
      }),
    );
    return new Response(null, { status: classification.status });
  }

  const event = classification.event;
  const accepted = yield* Effect.tryPromise({
    try: () => env.SCHEDULER.getByName("global-v3").accept(event),
    catch: (cause) => new SchedulerRpcError({ cause }),
  }).pipe(
    Effect.catchTag("SchedulerRpcError", () =>
      Effect.gen(function* () {
        yield* Effect.sync(() =>
          emit({
            event: "scheduler_accept_failed",
            deliveryId: event.deliveryId,
            deploymentId,
            installationId: event.installationId,
            repositoryId: event.repositoryId,
            workflowJobId: event.workflowJobId,
          }),
        );
        return new Response(null, { status: 500 });
      }),
    ),
  );
  if (accepted instanceof Response) return accepted;

  const { installationId, repositoryId, workflowJobId, action } = event;
  yield* Effect.sync(() =>
    emit({
      event: "webhook_classified",
      deliveryId: classification.deliveryId,
      deploymentId,
      installationId,
      repositoryId,
      workflowJobId,
      runnerName: accepted.runnerName,
      action,
      outcome: accepted.outcome,
    }),
  );
  return new Response(null, { status: classification.status });
});

const handleScheduled = Effect.fn("IngressWorker.scheduled")(function* (env: Env) {
  yield* reconcile(
    discoverQueuedJobs({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }),
    (candidate) =>
      Effect.tryPromise({
        try: () => env.SCHEDULER.getByName("global-v3").reconcile(candidate),
        catch: (cause) => new SchedulerRpcError({ cause }),
      }),
    env.CF_VERSION_METADATA.id,
  );
});

function fetch(request: Request, env: Env): Promise<Response> {
  return Effect.runPromise(handleRequest(request, env));
}

function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  return Effect.runPromise(handleScheduled(env));
}

export default { fetch, scheduled };
