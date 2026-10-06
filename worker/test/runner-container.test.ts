import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controlRunner } from "../src/runner-container";

type ArmOutcome = "ok" | "reject-while-running" | "reject-and-stop";

function fakeContainer(outcomes: ArmOutcome[], running = false) {
  const state = { running, starts: 0, arms: 0 };
  const container = {
    get running() {
      return state.running;
    },
    start() {
      if (state.running) throw new Error("container is already running");
      state.starts++;
      state.running = true;
    },
    async setInactivityTimeout() {
      state.arms++;
      const outcome = outcomes.shift() ?? "ok";
      if (outcome === "ok") return;
      if (outcome === "reject-and-stop") state.running = false;
      throw new Error("There is no container instance that can be provided to this Durable Object");
    },
  };
  return { state, runner: controlRunner(container, 75 * 60_000) };
}

afterEach(() => vi.useRealTimers());

describe("Runner Container start", () => {
  it("keeps a runner whose inactivity timeout fails to arm while it runs, and arms it on the next check", async () => {
    const { state, runner } = fakeContainer(["reject-while-running", "ok"]);

    await Effect.runPromise(runner.start({ JIT_CONFIG: "jit" }));
    expect(state).toMatchObject({ running: true, starts: 1, arms: 1 });

    expect(await Effect.runPromise(runner.isRunning)).toBe(true);
    expect(state.arms).toBe(2);
  });

  it("starts again when the platform had no container instance for it", async () => {
    vi.useFakeTimers();
    const { state, runner } = fakeContainer(["reject-and-stop", "reject-and-stop", "ok"]);

    const started = Effect.runPromise(runner.start({ JIT_CONFIG: "jit" }));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(started).resolves.toBeUndefined();
    expect(state).toMatchObject({ running: true, starts: 3 });
  });

  it("gives up within a minute when the container never comes up", async () => {
    vi.useFakeTimers();
    const { state, runner } = fakeContainer(Array(100).fill("reject-and-stop"));

    const started = Effect.runPromise(runner.start({ JIT_CONFIG: "jit" }));
    const settled = expect(started).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(60_000);

    await settled;
    expect(state.running).toBe(false);
    expect(state.starts).toBeGreaterThan(1);
    expect(state.starts).toBeLessThan(40);
  });

  it("arms the inactivity timeout once per instance, not on every check", async () => {
    const { state, runner } = fakeContainer([]);

    await Effect.runPromise(runner.start({ JIT_CONFIG: "jit" }));
    await Effect.runPromise(runner.isRunning);
    await Effect.runPromise(runner.isRunning);

    expect(state.arms).toBe(1);
  });

  it("arms a container that was already running when the instance restarted", async () => {
    const { state, runner } = fakeContainer([], true);

    expect(await Effect.runPromise(runner.isRunning)).toBe(true);
    await Effect.runPromise(runner.isRunning);

    expect(state).toMatchObject({ starts: 0, arms: 1 });
  });

});
