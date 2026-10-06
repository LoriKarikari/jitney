import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Data, Duration, Effect } from "effect";
import { Octokit } from "octokit";
import type { LifecycleRecord } from "../../worker/src/log.js";

const repo = { owner: "LoriKarikari", repo: "jitney-test" };
const workerName = "jitney";
const workerUrl = "https://jitney.lori-karikari.workers.dev";

type SchedulerEvent = LifecycleRecord & { timestamp: number };

class E2eError extends Data.TaggedError("E2eError")<{ step: string; cause: unknown }> {}

const attempt = <A>(step: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new E2eError({ step, cause }) });

export const poll = <A, E>(
  step: string,
  check: Effect.Effect<A | undefined, E>,
  every: Duration.Input,
  limit: number,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < limit; i++) {
      const value = yield* check;
      if (value !== undefined) return value;
      yield* Effect.sleep(every);
    }
    return yield* new E2eError({ step, cause: `not reached after ${limit} checks` });
  });

const env = (name: string) => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set. Run through \`pnpm e2e\`.`);
  return value;
};
const accountBase = () =>
  `https://api.cloudflare.com/client/v4/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const cloudflareBase = () => `${accountBase()}/workers/scripts/${workerName}`;
const authorization = () => ({ Authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}` });

const cloudflare = <A>(method: string, path: string, body?: unknown) =>
  account<A>(method, `workers/scripts/${workerName}/${path}`, body);

const account = <A>(method: string, path: string, body?: unknown) =>
  attempt(`cloudflare ${method} ${path}`, async () => {
    const response = await fetch(`${accountBase()}/${path}`, {
      method,
      headers: { ...authorization(), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as { success: boolean; result: A; errors: unknown };
    if (!json.success) throw new Error(JSON.stringify(json.errors));
    return json.result;
  });

const github = new Octokit({
  auth: process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"]).toString().trim(),
});

export const health = attempt("health", async () => {
  const response = await fetch(`${workerUrl}/health`);
  return (await response.json()) as { status: string; version: string };
});

export const dispatch = (workflow: string, correlation: string, inputs: Record<string, string>) =>
  Effect.gen(function* () {
    yield* attempt(`dispatch ${workflow}`, () =>
      github.rest.actions.createWorkflowDispatch({
        ...repo,
        workflow_id: workflow,
        ref: "main",
        inputs: { correlation, ...inputs },
      }),
    );
    return yield* poll(
      `find the ${correlation} run`,
      attempt("list runs", () =>
        github.rest.actions.listWorkflowRuns({
          ...repo,
          workflow_id: workflow,
          event: "workflow_dispatch",
          per_page: 20,
        }),
      ).pipe(
        Effect.map(
          ({ data }) =>
            data.workflow_runs.find((run) => run.display_title.endsWith(correlation))?.id,
        ),
      ),
      "5 seconds",
      60,
    );
  });

export const jobs = (runId: number) =>
  attempt("list jobs", () =>
    github.rest.actions.listJobsForWorkflowRun({ ...repo, run_id: runId }),
  ).pipe(Effect.map(({ data }) => data.jobs));

export const job = (runId: number) =>
  jobs(runId).pipe(
    Effect.flatMap((all) => {
      const first = all[0];
      return first === undefined
        ? Effect.fail(new E2eError({ step: "list jobs", cause: `run ${runId} has no job` }))
        : Effect.succeed(first);
    }),
  );

export const finished = (runId: number) =>
  poll(
    `wait for run ${runId}`,
    attempt("get run", () => github.rest.actions.getWorkflowRun({ ...repo, run_id: runId })).pipe(
      Effect.map(({ data }) => (data.status === "completed" ? data : undefined)),
    ),
    "15 seconds",
    240,
  );

export const cancel = (runId: number) =>
  attempt("cancel run", () => github.rest.actions.cancelWorkflowRun({ ...repo, run_id: runId }));

export const selfHostedRunners = attempt("list runners", () =>
  github.rest.actions.listSelfHostedRunnersForRepo(repo),
).pipe(Effect.map(({ data }) => data.runners.map((runner) => runner.name)));

export const jobLog = (jobId: number) =>
  attempt("job log", () =>
    github.rest.actions.downloadJobLogsForWorkflowRun({ ...repo, job_id: jobId }),
  ).pipe(Effect.map(({ data }) => String(data)));

export const tailWorker = Effect.acquireRelease(
  Effect.gen(function* () {
    const tail = yield* cloudflare<{ id: string; url: string }>("POST", "tails", { filters: [] });
    const events: SchedulerEvent[] = [];
    const exceptions: { at: number; entrypoint?: string; name: string; message: string }[] = [];
    const stream = {
      traces: 0,
      lastTraceAt: 0,
      closed: null as { code: number; reason: string } | null,
    };
    const socket = new WebSocket(tail.url, "trace-v1");
    socket.onclose = ({ code, reason }) => (stream.closed = { code, reason });
    socket.onmessage = async (message) => {
      stream.traces++;
      const text =
        typeof message.data === "string" ? message.data : await new Response(message.data).text();
      const trace = JSON.parse(text) as {
        eventTimestamp: number;
        entrypoint?: string;
        logs?: { message: unknown[] }[];
        exceptions?: { name: string; message: string }[];
      };
      stream.lastTraceAt = Math.max(stream.lastTraceAt, trace.eventTimestamp);
      for (const { name, message } of trace.exceptions ?? []) {
        exceptions.push({
          at: trace.eventTimestamp,
          ...(trace.entrypoint ? { entrypoint: trace.entrypoint } : {}),
          name,
          message,
        });
      }
      for (const log of trace.logs ?? []) {
        try {
          const event: unknown = JSON.parse(String(log.message[0]));
          if (typeof event === "object" && event !== null && "event" in event)
            events.push(event as SchedulerEvent);
        } catch {
          // Not a structured lifecycle record.
        }
      }
    };
    yield* attempt("open tail", () => new Promise((resolve) => (socket.onopen = resolve)));
    socket.send(JSON.stringify({ debug: false }));
    // A new tail drops events for its first few seconds.
    yield* Effect.sleep("5 seconds");
    return { tail, socket, events, exceptions, stream };
  }),
  ({ tail, socket }) =>
    Effect.sync(() => socket.close()).pipe(
      Effect.andThen(cloudflare("DELETE", `tails/${tail.id}`)),
      Effect.ignore,
    ),
).pipe(
  Effect.map(({ events, exceptions, stream }) => ({
    events: () => [...events],
    exceptions: () => [...exceptions],
    stream: () => ({ ...stream, lastTraceAt: new Date(stream.lastTraceAt).toISOString() }),
  })),
);

type Route = { enabled: boolean; previews_enabled: boolean };

const setRoute = (route: Route) => cloudflare<Route>("POST", "subdomain", route);

export const webhookRouteOff = Effect.acquireRelease(
  Effect.gen(function* () {
    const original = yield* cloudflare<Route>("GET", "subdomain");
    // A killed run never closes its scope, so restore the route on a timer that outlives it.
    const watchdog = spawn(
      "sh",
      [
        "-c",
        'sleep 2400; curl -sS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" -d "$ROUTE" "$ROUTE_URL"',
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ROUTE: JSON.stringify(original),
          ROUTE_URL: `${cloudflareBase()}/subdomain`,
        },
      },
    );
    watchdog.unref();
    yield* setRoute({ enabled: false, previews_enabled: false });
    yield* Effect.sleep("30 seconds");
    return { original, watchdog };
  }),
  ({ original, watchdog }) =>
    setRoute(original).pipe(
      Effect.andThen(Effect.sync(() => watchdog.pid !== undefined && process.kill(-watchdog.pid))),
      Effect.orDie,
    ),
);

// Setting a secret deploys a new Worker version. The secret is deleted when the scope closes.
export const deployWorkerVersion = (value: string) =>
  Effect.acquireRelease(
    cloudflare("PUT", "secrets", { name: "JITNEY_E2E_DEPLOY", text: value, type: "secret_text" }),
    () => cloudflare("DELETE", "secrets/JITNEY_E2E_DEPLOY").pipe(Effect.orDie),
  );

const resultsDir = new URL("../results/", import.meta.url);

export const record = <Checks extends Record<string, boolean>>(
  name: string,
  checks: Checks,
  evidence: unknown,
): Checks => {
  mkdirSync(resultsDir, { recursive: true });
  const result = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
  writeFileSync(
    new URL(`${name}.json`, resultsDir),
    `${JSON.stringify({ result, at: new Date().toISOString(), checks, evidence }, null, 2)}\n`,
  );
  return checks;
};

type Receipt = { concurrencyBudget?: number; cloudflare: { applicationName: string } };

export const receipt = Effect.gen(function* () {
  const namespaces = yield* account<{ id: string; title: string }[]>(
    "GET",
    "storage/kv/namespaces?per_page=100",
  );
  const namespace = namespaces.find((candidate) => candidate.title === "jitney-receipts");
  if (namespace === undefined) {
    return yield* new E2eError({ step: "receipt", cause: "no jitney-receipts namespace" });
  }
  return yield* attempt("receipt", async () => {
    const response = await fetch(
      `${accountBase()}/storage/kv/namespaces/${namespace.id}/values/${workerName}`,
      { headers: authorization() },
    );
    return (await response.json()) as Receipt;
  });
});

export const runnerApplication = (name: string) =>
  account<{ name: string; max_instances: number }[]>("GET", "containers/applications").pipe(
    Effect.map((applications) => applications.find((application) => application.name === name)),
  );

// Runs the published CLI at a version, the way a user would.
export const getJitney = (version: string, args: readonly string[]) =>
  attempt(`get-jitney ${args.join(" ")}`, async () => {
    const child = spawn("npx", ["--yes", `get-jitney@${version}`, ...args], {
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    if (code !== 0) throw new Error(`exit ${code}: ${output.slice(-2_000)}`);
    return output;
  });
