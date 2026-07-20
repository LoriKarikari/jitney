import { Duration, Effect, Option, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { InstallerError } from "../src/errors.js";
import {
  DeploymentReceipts,
  InstallPlatform,
  installDeployment,
  type InstallInput,
  type InstallStackOutput,
} from "../src/install.js";
import type { GitHubAppCredentials } from "../src/github-app.js";
import { makeReceiptStore, type ReceiptBackend } from "../src/receipts/store.js";

const credentials: GitHubAppCredentials = {
  appId: "12345",
  privateKey: "private-key",
  webhookSecret: "webhook-secret",
  slug: "jitney-test",
  ownerLogin: "LoriKarikari",
  ownerType: "User",
};

const stackOutput: InstallStackOutput = {
  workerUrl: "https://jitney-test.example.workers.dev",
  applicationId: "application-id",
  registryTag: "image-hash",
};

const input: InstallInput = {
  name: "jitney-test",
  accountId: "account-id",
  version: "0.3.0",
  actor: "lori@mbp",
};

const installations = [
  {
    id: 42,
    accountLogin: "LoriKarikari",
    accountType: "User" as const,
    repositories: [{ id: 100, name: "api", fullName: "LoriKarikari/api" }],
  },
];

describe("record-intent deployment", () => {
  it("records intent before creation and activates only after ownership is verified", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });
    const events = await Effect.runPromise(Ref.make<string[]>([]));
    const record = (event: string) => Ref.update(events, (current) => [...current, event]);
    const platform = InstallPlatform.of({
      deployBootstrap: () =>
        Effect.gen(function* () {
          const receipt = yield* store.get(input.name).pipe(Effect.orDie);
          expect(Option.getOrThrow(receipt)).toMatchObject({
            phase: "installing",
            lease: { operation: "install", actor: input.actor },
            cloudflare: {
              workerName: input.name,
              applicationName: `${input.name}-runner`,
              applicationId: null,
            },
          });
          yield* record("bootstrap");
          return stackOutput;
        }),
      createGitHubApp: () =>
        Effect.gen(function* () {
          const receipt = Option.getOrThrow(yield* store.get(input.name).pipe(Effect.orDie));
          expect(receipt).toMatchObject({
            cloudflare: {
              applicationId: "application-id",
              tags: { current: "image-hash", previous: null },
            },
            github: { appId: null, appSlug: null },
          });
          yield* record("create-app");
          return {
            appId: 12345,
            appSlug: "jitney-test",
            ownerLogin: "LoriKarikari",
            ownerType: "User" as const,
            credentials,
          };
        }),
      activate: () => record("activate"),
      installGitHubApp: () => record("install-app").pipe(Effect.as(installations)),
      claimRepositories: () =>
        Effect.gen(function* () {
          const receipt = Option.getOrThrow(yield* store.get(input.name).pipe(Effect.orDie));
          expect(receipt.github.installations).toEqual(installations);
          yield* record("claim-repositories");
        }),
      checkHealth: () => record("health"),
      rollback: () => Effect.die("rollback not expected"),
    });

    const result = await Effect.runPromise(
      installDeployment(input).pipe(
        Effect.provideService(DeploymentReceipts, store),
        Effect.provideService(InstallPlatform, platform),
      ),
    );

    expect(await Effect.runPromise(Ref.get(events))).toEqual([
      "bootstrap",
      "create-app",
      "activate",
      "install-app",
      "claim-repositories",
      "health",
    ]);
    expect(result.receipt).toMatchObject({
      id: result.deploymentId,
      phase: "active",
      lease: null,
      cloudflare: {
        applicationId: "application-id",
        tags: { current: "image-hash", previous: null },
      },
      github: {
        appId: 12345,
        appSlug: "jitney-test",
        installations,
      },
    });
    expect(result.receipt.history.at(-1)).toMatchObject({
      operation: "install",
      outcome: "succeeded",
    });
  });

  it("rolls back from the receipt and removes it when a later step fails", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });
    const events = await Effect.runPromise(Ref.make<string[]>([]));
    const record = (event: string) => Ref.update(events, (current) => [...current, event]);
    const healthFailure = new InstallerError({
      step: "health_check",
      message: "Health check failed",
    });
    const platform = successfulPlatform({
      checkHealth: () => record("health").pipe(Effect.andThen(Effect.fail(healthFailure))),
      rollback: ({ receipt }) =>
        Effect.gen(function* () {
          expect(receipt).toMatchObject({
            cloudflare: { applicationId: "application-id" },
            github: { appId: 12345, installations },
          });
          yield* record("rollback");
        }),
    });

    const error = await Effect.runPromise(
      installDeployment(input).pipe(
        Effect.provideService(DeploymentReceipts, store),
        Effect.provideService(InstallPlatform, platform),
        Effect.flip,
      ),
    );

    expect(error).toBe(healthFailure);
    expect(await backend.values()).toEqual([]);
    expect(await Effect.runPromise(Ref.get(events))).toEqual(["health", "rollback"]);
  });

  it("keeps the installing receipt and skips rollback with --keep-partial", async () => {
    const backend = await makeMemoryBackend();
    const store = makeReceiptStore(backend.service, { namespaceRemovalDelay: Duration.zero });
    const healthFailure = new InstallerError({
      step: "health_check",
      message: "Health check failed",
    });
    const platform = successfulPlatform({
      checkHealth: () => Effect.fail(healthFailure),
      rollback: () => Effect.die("rollback not expected"),
    });

    const error = await Effect.runPromise(
      installDeployment({ ...input, keepPartial: true }).pipe(
        Effect.provideService(DeploymentReceipts, store),
        Effect.provideService(InstallPlatform, platform),
        Effect.flip,
      ),
    );
    const receipt = Option.getOrThrow(await Effect.runPromise(store.get(input.name)));

    expect(error).toBe(healthFailure);
    expect(receipt).toMatchObject({
      phase: "installing",
      lease: { operation: "install" },
      cloudflare: { applicationId: "application-id" },
      github: { appId: 12345, installations },
    });
  });
});

function successfulPlatform(
  overrides: Partial<InstallPlatform["Service"]> = {},
): InstallPlatform["Service"] {
  return {
    deployBootstrap: () => Effect.succeed(stackOutput),
    createGitHubApp: () =>
      Effect.succeed({
        appId: 12345,
        appSlug: "jitney-test",
        ownerLogin: "LoriKarikari",
        ownerType: "User",
        credentials,
      }),
    activate: () => Effect.void,
    installGitHubApp: () => Effect.succeed(installations),
    claimRepositories: () => Effect.void,
    checkHealth: () => Effect.void,
    rollback: () => Effect.void,
    ...overrides,
  };
}

async function makeMemoryBackend() {
  const data = await Effect.runPromise(Ref.make(new Map<string, string>()));
  const service: ReceiptBackend = {
    get: (name) => Effect.map(Ref.get(data), (values) => values.get(name)),
    put: (name, value) => Ref.update(data, (values) => new Map(values).set(name, value)),
    remove: (name) =>
      Ref.update(data, (values) => {
        const next = new Map(values);
        next.delete(name);
        return next;
      }),
    listKeys: () => Effect.map(Ref.get(data), (values) => [...values.keys()]),
    removeNamespace: () => Effect.void,
  };
  return {
    service,
    values: () => Effect.runPromise(Effect.map(Ref.get(data), (values) => [...values])),
  };
}
