import { fileURLToPath } from "node:url";

export function workerBundlePath(): string {
  return fileURLToPath(new URL("../assets/worker/index.js", import.meta.url));
}

export function validateWorkerName(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(name)) {
    throw new Error(
      "Worker name must start with a letter and contain at most 50 lowercase letters, numbers, or hyphens",
    );
  }
  return name;
}
