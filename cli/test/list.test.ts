import { DateTime, Effect, Option, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
  ListPlatform,
  ListReceipts,
  ProbeUnreachableError,
  listDeployments,
  renderListReport,
  type GitHubProbe,
  type ListReport,
  type LiveApplication,
} from "../src/list.js";
import {
  createDeploymentReceipt,
  type DeploymentReceipt,
  type GitHubInstallation,
} from "../src/receipts/schema.js";
import { makeReceiptStore, type ReceiptBackend } from "../src/receipts/store.js";

const now = DateTime.makeUnsafe("2026-07-20T13:00:00.000Z");

const installations: GitHubInstallation[] = [
  {
    id: 42,
    accountLogin: "LoriKarikari",
    accountType: "User",
    repositories: [{ id: 100, name: "api", fullName: "LoriKarikari/api" }],
  },
];

function fixtureReceipt(overrides?: {
  name?: string;
  id?: string;
  version?: string;
}): DeploymentReceipt {
  const name = overrides?.name ?? "jitney";
  const version = overrides?.version ?? "0.3.0";
  const base = createDeploymentReceipt({
    id: overrides?.id ?? "01JVQ8B95TQZD1P6DE00DE0001",
    name,
    version,
    now,
    cloudflare: {
      accountId: "account-id",
      workerName: name,
      applicationId: `${name}-application-id`,
      applicationName: `${name}-runner`,
      durableObjectClasses: ["Scheduler", "RunnerContainer"],
      registryRepo: `${name}-runner`,
      tags: { current: version, previous: null },
    },
    github: {
      appId: 12345,
      appSlug: `${name}-x7k2`,
      ownerLogin: "LoriKarikari",
      ownerType: "User",
      installations,
    },
    autoUpgrade: { enabled: true, channel: "patch" },
  });
  return { ...base, phase: "active" };
}

const healthyApplications: LiveApplication[] = [
  { id: "jitney-application-id", name: "jitney-runner", imageTag: "0.3.0" },
];

const healthyGitHub: GitHubProbe = {
  appExists: true,
  installations,
  ownership: [{ fullName: "LoriKarikari/api", class: "ok" }],
};

function fakePlatform(overrides?: {
  worker?: (
    accountId: string,
    name: string,
  ) => Effect.Effect<
    { readonly exists: boolean; readonly version: string | null },
    ProbeUnreachableError
  >;
  workerNames?: () => Effect.Effect<readonly string[], ProbeUnreachableError>;
  containerApplications?: () => Effect.Effect<readonly LiveApplication[], ProbeUnreachableError>;
  registryTags?: () => Effect.Effect<readonly string[], ProbeUnreachableError>;
  githubApp?: (receipt: DeploymentReceipt) => Effect.Effect<GitHubProbe, ProbeUnreachableError>;
  latestVersion?: () => Effect.Effect<Option.Option<string>, ProbeUnreachableError>;
}) {
  return ListPlatform.of({
    worker: overrides?.worker ?? (() => Effect.succeed({ exists: true, version: "0.3.0" })),
    workerNames: overrides?.workerNames ?? (() => Effect.succeed(["jitney"])),
    containerApplications:
      overrides?.containerApplications ?? (() => Effect.succeed(healthyApplications)),
    registryTags: overrides?.registryTags ?? (() => Effect.succeed(["0.3.0"])),
    githubApp:
      overrides?.githubApp ??
      ((receipt) =>
        Effect.succeed({
          ...healthyGitHub,
          installations: receipt.github.installations,
          ownership: receipt.github.installations.flatMap((installation) =>
            installation.repositories.map((repository) => ({
              fullName: repository.fullName,
              class: "ok" as const,
            })),
          ),
        })),
    latestVersion: overrides?.latestVersion ?? (() => Effect.succeed(Option.some("0.3.0"))),
  });
}

async function runList(
  receipts: readonly DeploymentReceipt[],
  platform: ReturnType<typeof fakePlatform>,
): Promise<ListReport> {
  const backend = await makeMemoryBackend(receipts);
  const store = makeReceiptStore(backend);
  return Effect.runPromise(
    listDeployments().pipe(
      Effect.provideService(ListReceipts, store),
      Effect.provideService(ListPlatform, platform),
    ),
  );
}

describe("list drift classification", () => {
  it("reports a healthy deployment with every resource ok", async () => {
    const report = await runList([fixtureReceipt()], fakePlatform());

    expect(report.deployments).toHaveLength(1);
    expect(report.deployments[0]).toMatchObject({
      name: "jitney",
      deploymentId: "01JVQ8B95TQZD1P6DE00DE0001",
      phase: "active",
      version: "0.3.0",
      health: "ok",
      repositoryCount: 1,
      appSlug: "jitney-x7k2",
      autoUpgrade: { enabled: true, channel: "patch" },
      findings: [],
    });
    expect(report.orphans).toEqual([]);
    expect(report.latestVersion).toBe("0.3.0");
  });

  it("classifies an absent Worker as missing", async () => {
    const report = await runList(
      [fixtureReceipt()],
      fakePlatform({ worker: () => Effect.succeed({ exists: false, version: null }) }),
    );

    expect(report.deployments[0]!.health).toBe("missing");
    expect(report.deployments[0]!.findings).toContainEqual(
      expect.objectContaining({ class: "missing", resource: "worker" }),
    );
  });

  it("keeps an existing Worker distinct from an unreachable version endpoint", async () => {
    const report = await runList(
      [fixtureReceipt()],
      fakePlatform({ worker: () => Effect.succeed({ exists: true, version: null }) }),
    );

    expect(report.deployments[0]!.health).toBe("unknown");
    expect(report.deployments[0]!.findings).toContainEqual(
      expect.objectContaining({ class: "unknown", resource: "worker.version" }),
    );
    expect(report.deployments[0]!.findings).not.toContainEqual(
      expect.objectContaining({ resource: "worker" }),
    );
  });

  it("classifies a live image tag that differs from the receipt as drifted", async () => {
    const report = await runList(
      [fixtureReceipt()],
      fakePlatform({
        containerApplications: () =>
          Effect.succeed([
            { id: "jitney-application-id", name: "jitney-runner", imageTag: "0.1.0" },
          ]),
      }),
    );

    expect(report.deployments[0]!.health).toBe("drifted");
    expect(report.deployments[0]!.findings).toContainEqual(
      expect.objectContaining({
        class: "drifted",
        resource: "containerApplication.image",
        live: "0.1.0",
        receipt: "0.3.0",
      }),
    );
  });

  it("reports a Jitney-shaped application no receipt references as an orphan", async () => {
    const report = await runList(
      [fixtureReceipt()],
      fakePlatform({
        workerNames: () => Effect.succeed(["jitney", "staging"]),
        containerApplications: () =>
          Effect.succeed([
            ...healthyApplications,
            { id: "a034dae7", name: "staging-runner-old", imageTag: "0.1.0" },
          ]),
        registryTags: () => Effect.succeed(["0.3.0", "old"]),
      }),
    );

    expect(report.deployments[0]!.health).toBe("ok");
    expect(report.orphans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          class: "orphan",
          resource: "containerApplication",
          live: "staging-runner-old (a034dae7)",
        }),
        expect.objectContaining({ class: "orphan", resource: "worker", live: "staging" }),
        expect.objectContaining({
          class: "orphan",
          resource: "registry.tag",
          live: "jitney-runner:old",
        }),
      ]),
    );
  });

  it("classifies resources as unknown when a plane is unreachable, never guessing", async () => {
    const unreachable = () =>
      Effect.fail(new ProbeUnreachableError({ plane: "cloudflare", cause: new Error("timeout") }));
    const report = await runList(
      [fixtureReceipt()],
      fakePlatform({
        worker: unreachable,
        containerApplications: unreachable,
        registryTags: unreachable,
      }),
    );

    const classes = report.deployments[0]!.findings.map((finding) => finding.class);
    expect(new Set(classes)).toEqual(new Set(["unknown"]));
    expect(report.deployments[0]!.health).toBe("unknown");
  });

  it("classifies ownership variables against the deployment ULID", async () => {
    const report = await runList(
      [fixtureReceipt()],
      fakePlatform({
        githubApp: () =>
          Effect.succeed({
            ...healthyGitHub,
            ownership: [
              {
                fullName: "LoriKarikari/api",
                class: "drifted",
                value: "01JVQ8B95TQZD1P6AAAABBBBCC",
              },
              { fullName: "LoriKarikari/web", class: "missing" },
            ],
            installations: [
              {
                ...installations[0]!,
                repositories: [
                  ...installations[0]!.repositories,
                  { id: 101, name: "web", fullName: "LoriKarikari/web" },
                ],
              },
            ],
          }),
      }),
    );

    const findings = report.deployments[0]!.findings;
    expect(findings).toContainEqual(
      expect.objectContaining({
        class: "drifted",
        resource: "ownership.LoriKarikari/api",
        live: "01JVQ8B95TQZD1P6AAAABBBBCC",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ class: "missing", resource: "ownership.LoriKarikari/web" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ class: "drifted", resource: "installations" }),
    );
  });

  it("reports version staleness against the latest release", async () => {
    const report = await runList(
      [fixtureReceipt()],
      fakePlatform({ latestVersion: () => Effect.succeed(Option.some("0.4.0")) }),
    );

    expect(report.latestVersion).toBe("0.4.0");
    expect(report.deployments[0]!.updateAvailable).toBe(true);
    expect(report.deployments[0]!.health).toBe("ok");
  });

  it("does not report an update when a deployment is newer than the latest release", async () => {
    const report = await runList(
      [fixtureReceipt({ version: "0.5.0" })],
      fakePlatform({
        worker: () => Effect.succeed({ exists: true, version: "0.5.0" }),
        containerApplications: () =>
          Effect.succeed([
            { id: "jitney-application-id", name: "jitney-runner", imageTag: "0.5.0" },
          ]),
        registryTags: () => Effect.succeed(["0.5.0"]),
        latestVersion: () => Effect.succeed(Option.some("0.4.0")),
      }),
    );

    expect(report.deployments[0]!.updateAvailable).toBe(false);
  });

  it("renders the human summary with findings and fix commands", async () => {
    const report = await runList(
      [
        fixtureReceipt(),
        fixtureReceipt({ name: "staging", id: "01JVQ8B95TQZD1P6DE00DE0002", version: "0.2.0" }),
      ],
      fakePlatform({
        worker: (_accountId, name) =>
          Effect.succeed({
            exists: true,
            version: name === "staging" ? "0.1.0" : "0.3.0",
          }),
        containerApplications: () =>
          Effect.succeed([
            ...healthyApplications,
            { id: "staging-application-id", name: "staging-runner", imageTag: "0.2.0" },
            { id: "a034dae7", name: "staging-runner-old", imageTag: "0.1.0" },
          ]),
        registryTags: () => Effect.succeed(["0.3.0", "0.2.0"]),
        githubApp: (receipt) =>
          Effect.succeed({
            ...healthyGitHub,
            installations: receipt.github.installations,
            ownership: receipt.github.installations.flatMap((installation) =>
              installation.repositories.map((repository) => ({
                fullName: repository.fullName,
                class: "ok" as const,
              })),
            ),
          }),
      }),
    );

    const output = renderListReport(report);
    expect(output).toContain("NAME");
    expect(output).toContain("jitney   0.3.0    ok");
    expect(output).toContain("staging  0.2.0    drifted");
    expect(output).toContain("staging: 1 finding");
    expect(output).toContain("worker.version");
    expect(output).toContain("orphan");
    expect(output).toContain("npx get-jitney list --json");
  });

  it("mirrors the report 1:1 as JSON", async () => {
    const report = await runList([fixtureReceipt()], fakePlatform());

    const roundTripped: unknown = JSON.parse(JSON.stringify(report));
    expect(roundTripped).toEqual(report);
  });
});

async function makeMemoryBackend(receipts: readonly DeploymentReceipt[]): Promise<ReceiptBackend> {
  const entries = await Effect.runPromise(
    Effect.gen(function* () {
      const map = new Map<string, string>();
      for (const receipt of receipts) {
        map.set(
          receipt.name,
          JSON.stringify({
            ...JSON.parse(JSON.stringify(receipt)),
            createdAt: DateTime.formatIso(receipt.createdAt),
            updatedAt: DateTime.formatIso(receipt.updatedAt),
          }),
        );
      }
      return yield* Ref.make(map);
    }),
  );
  return {
    get: (name) => Ref.get(entries).pipe(Effect.map((map) => map.get(name))),
    put: (name, value) =>
      Ref.update(entries, (map) => new Map(map).set(name, value)).pipe(Effect.asVoid),
    remove: (name) =>
      Ref.update(entries, (map) => {
        const next = new Map(map);
        next.delete(name);
        return next;
      }).pipe(Effect.asVoid),
    listKeys: () => Ref.get(entries).pipe(Effect.map((map) => [...map.keys()])),
    removeNamespace: () => Effect.void,
  };
}
