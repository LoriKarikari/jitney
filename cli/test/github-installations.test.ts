import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
  RepositoryVariables,
  claimRepositoryOwnership,
  releaseRepositoryOwnership,
} from "../src/github-installations.js";
import type { GitHubInstallation } from "../src/receipts/schema.js";

const deploymentId = "01J00000000000000000000000";
const installations: readonly GitHubInstallation[] = [
  {
    id: 42,
    accountLogin: "LoriKarikari",
    accountType: "User",
    repositories: [
      { id: 1, name: "api", fullName: "LoriKarikari/api" },
      { id: 2, name: "web", fullName: "LoriKarikari/web" },
    ],
  },
];

describe("repository ownership markers", () => {
  it("checks every repository before writing and rejects a foreign deployment", async () => {
    const fake = await makeVariables([["LoriKarikari/web", "01J00000000000000000000001"]]);

    const error = await Effect.runPromise(
      claimRepositoryOwnership(deploymentId, installations).pipe(
        Effect.provideService(RepositoryVariables, fake.service),
        Effect.flip,
      ),
    );

    expect(error.message).toContain("already belongs to Jitney deployment");
    expect(await fake.events()).toEqual(["read:LoriKarikari/api", "read:LoriKarikari/web"]);
    expect(await fake.values()).toEqual([["LoriKarikari/web", "01J00000000000000000000001"]]);
  });

  it("writes missing markers and reads them back", async () => {
    const fake = await makeVariables();

    await Effect.runPromise(
      claimRepositoryOwnership(deploymentId, installations).pipe(
        Effect.provideService(RepositoryVariables, fake.service),
      ),
    );

    expect(await fake.events()).toEqual([
      "read:LoriKarikari/api",
      "read:LoriKarikari/web",
      "create:LoriKarikari/api",
      "create:LoriKarikari/web",
      "read:LoriKarikari/api",
      "read:LoriKarikari/web",
    ]);
    expect(await fake.values()).toEqual([
      ["LoriKarikari/api", deploymentId],
      ["LoriKarikari/web", deploymentId],
    ]);
  });

  it("removes only markers owned by this deployment", async () => {
    const fake = await makeVariables([
      ["LoriKarikari/api", deploymentId],
      ["LoriKarikari/web", "01J00000000000000000000001"],
    ]);

    await Effect.runPromise(
      releaseRepositoryOwnership(deploymentId, installations).pipe(
        Effect.provideService(RepositoryVariables, fake.service),
      ),
    );

    expect(await fake.events()).toEqual([
      "read:LoriKarikari/api",
      "remove:LoriKarikari/api",
      "read:LoriKarikari/web",
    ]);
    expect(await fake.values()).toEqual([["LoriKarikari/web", "01J00000000000000000000001"]]);
  });
});

async function makeVariables(entries: ReadonlyArray<readonly [string, string]> = []) {
  const values = await Effect.runPromise(Ref.make(new Map(entries)));
  const events = await Effect.runPromise(Ref.make<string[]>([]));
  const record = (event: string) => Ref.update(events, (current) => [...current, event]);
  return {
    service: RepositoryVariables.of({
      read: (_installationId, fullName) =>
        record(`read:${fullName}`).pipe(
          Effect.andThen(Ref.get(values)),
          Effect.map((current) => current.get(fullName)),
        ),
      create: (_installationId, fullName, value) =>
        record(`create:${fullName}`).pipe(
          Effect.andThen(Ref.update(values, (current) => new Map(current).set(fullName, value))),
        ),
      remove: (_installationId, fullName) =>
        record(`remove:${fullName}`).pipe(
          Effect.andThen(
            Ref.update(values, (current) => {
              const next = new Map(current);
              next.delete(fullName);
              return next;
            }),
          ),
        ),
    }),
    values: () => Effect.runPromise(Ref.get(values)).then((current) => [...current]),
    events: () => Effect.runPromise(Ref.get(events)),
  };
}
