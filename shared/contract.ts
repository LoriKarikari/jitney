const prefix = "jitney-";
const deploymentId = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const ownershipEnvironmentName = (id: string): string => `${prefix}${id}`;

export const deploymentIdFromOwnershipEnvironment = (name: string): string | undefined => {
  const id = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  return deploymentId.test(id) ? id : undefined;
};

/** Wire contract between the CLI and `/lifecycle/uninstall`. */
export const UNINSTALL_ACTIONS = [
  "suspend",
  "suspend_intake",
  "drain",
  "resume_intake",
  "delete_ownership",
  "delete_installations",
  "inventory",
] as const;
export type UninstallAction = (typeof UNINSTALL_ACTIONS)[number];

/** Authorization secret: `<expiry epoch ms>.<random>`; zero is permanently inert. */
export const mintOperationSecret = (expiresAtEpochMs: number, random: string): string =>
  `${expiresAtEpochMs}.${random}`;

export const isLiveSecret = (secret: string, nowEpochMs: number): boolean => {
  const separator = secret.indexOf(".");
  if (separator < 1) return false;
  const expiry = Number(secret.slice(0, separator));
  return Number.isSafeInteger(expiry) && expiry > nowEpochMs;
};
