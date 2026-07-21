import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
  UninstallPlatform,
  authorizeUninstall,
  executeUninstall,
  type UninstallReceipt,
} from "../src/uninstall";

const receipt: UninstallReceipt = {
  id: "01JVQ8B95TQZD1P6DE00DE0001",
  github: {
    installations: [
      {
        id: 42,
        repositories: [{ fullName: "LoriKarikari/api" }],
      },
    ],
  },
};

async function fakePlatform(activeAttempts = 0) {
  const calls = await Effect.runPromise(Ref.make<string[]>([]));
  const call = (name: string) => Ref.update(calls, (current) => [...current, name]);
  return {
    calls,
    service: UninstallPlatform.of({
      suspendIntake: () => call("suspend_intake"),
      suspendInstallations: (ids) => call(`suspend:${ids.join(",")}`),
      activeAttempts: () => call("active_attempts").pipe(Effect.as(activeAttempts)),
      deleteOwnership: (installations) =>
        call(
          `delete_ownership:${installations
            .flatMap((installation) =>
              installation.repositories.map(
                (repository) => `${installation.id}:${repository.fullName}`,
              ),
            )
            .join(",")}`,
        ),
      deleteInstallations: (ids) => call(`delete_installations:${ids.join(",")}`),
    }),
  };
}

describe("uninstall", () => {
  it("accepts only the matching unexpired operation secret", () => {
    const future = `${Date.now() + 60_000}.secret`;
    const expired = `${Date.now() - 1}.secret`;

    expect(
      authorizeUninstall(
        new Request("https://example.com", {
          headers: { Authorization: `Bearer ${future}` },
        }),
        future,
      ),
    ).toBe(true);
    expect(
      authorizeUninstall(
        new Request("https://example.com", {
          headers: { Authorization: `Bearer ${expired}` },
        }),
        expired,
      ),
    ).toBe(false);
  });

  it("suspends intake before suspending receipt-listed installations", async () => {
    const platform = await fakePlatform();

    const result = await Effect.runPromise(
      executeUninstall(receipt, receipt.id, "suspend").pipe(
        Effect.provideService(UninstallPlatform, platform.service),
      ),
    );

    expect(result).toEqual({ accepted: true });
    expect(await Effect.runPromise(Ref.get(platform.calls))).toEqual([
      "suspend_intake",
      "suspend:42",
    ]);
  });

  it("reports active attempts for bounded draining", async () => {
    const platform = await fakePlatform(3);

    const result = await Effect.runPromise(
      executeUninstall(receipt, receipt.id, "drain").pipe(
        Effect.provideService(UninstallPlatform, platform.service),
      ),
    );

    expect(result).toEqual({ accepted: true, activeAttempts: 3 });
  });

  it("deletes ownership only for receipt-listed repositories", async () => {
    const platform = await fakePlatform();

    await Effect.runPromise(
      executeUninstall(receipt, receipt.id, "delete_ownership").pipe(
        Effect.provideService(UninstallPlatform, platform.service),
      ),
    );

    expect(await Effect.runPromise(Ref.get(platform.calls))).toEqual([
      "delete_ownership:42:LoriKarikari/api",
    ]);
  });

  it("deletes only receipt-listed installations", async () => {
    const platform = await fakePlatform();

    await Effect.runPromise(
      executeUninstall(receipt, receipt.id, "delete_installations").pipe(
        Effect.provideService(UninstallPlatform, platform.service),
      ),
    );

    expect(await Effect.runPromise(Ref.get(platform.calls))).toEqual(["delete_installations:42"]);
  });

  it("refuses a receipt that belongs to another deployment", async () => {
    const platform = await fakePlatform();

    const result = await Effect.runPromise(
      executeUninstall(receipt, "different", "suspend").pipe(
        Effect.provideService(UninstallPlatform, platform.service),
      ),
    );

    expect(result).toEqual({ accepted: false });
    expect(await Effect.runPromise(Ref.get(platform.calls))).toEqual([]);
  });
});
