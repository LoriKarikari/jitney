import { runInDurableObject } from "cloudflare:test";
import { SchedulerLifecycle } from "../src/lifecycle";
import type { Scheduler } from "../src/scheduler";

const read = <A>(
  scheduler: DurableObjectStub<Scheduler>,
  use: (lifecycle: SchedulerLifecycle) => A,
) =>
  runInDurableObject(scheduler, (_instance, state) => use(new SchedulerLifecycle(state.storage)));

export const jobOf = (scheduler: DurableObjectStub<Scheduler>, workflowJobId: number) =>
  read(scheduler, (lifecycle) => lifecycle.getJob(workflowJobId));

export const attemptsOf = (scheduler: DurableObjectStub<Scheduler>, workflowJobId: number) =>
  read(scheduler, (lifecycle) => lifecycle.getAttempts(workflowJobId));

export const assignmentOf = (scheduler: DurableObjectStub<Scheduler>, workflowJobId: number) =>
  read(scheduler, (lifecycle) => lifecycle.getAssignment(workflowJobId));
