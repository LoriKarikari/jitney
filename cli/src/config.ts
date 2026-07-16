import { fileURLToPath } from "node:url";

export type DeploymentConfig = {
  accountId: string;
  image: string;
  workerName: string;
  configured: boolean;
};

export function workerBundlePath(): string {
  return fileURLToPath(new URL("../assets/worker/index.js", import.meta.url));
}

export function renderWranglerConfig(options: DeploymentConfig): string {
  const config: Record<string, unknown> = {
    name: options.workerName,
    account_id: options.accountId,
    main: workerBundlePath(),
    compatibility_date: "2026-07-01",
    compatibility_flags: ["nodejs_compat"],
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      RUNTIME_TIMEOUT_MS: "3600000",
      SCHEDULER_TICK_MS: "1000",
    },
    durable_objects: {
      bindings: [
        { name: "SCHEDULER", class_name: "Scheduler" },
        { name: "RUNNER_CONTAINERS", class_name: "RunnerContainer" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Scheduler", "RunnerContainer"] }],
    containers: [
      {
        name: `${options.workerName}-runner`,
        class_name: "RunnerContainer",
        image: options.image,
        instance_type: "standard-2",
        max_instances: 5,
      },
    ],
    observability: { enabled: true, head_sampling_rate: 1 },
  };
  if (options.configured) {
    config.triggers = { crons: ["*/5 * * * *"] };
    config.secrets = {
      required: ["GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"],
    };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function validateWorkerName(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(name)) {
    throw new Error(
      "Worker name must start with a letter and contain at most 50 lowercase letters, numbers, or hyphens",
    );
  }
  return name;
}
