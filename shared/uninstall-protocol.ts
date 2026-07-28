/** Wire contract between the CLI and `/lifecycle/uninstall`. */
export const UNINSTALL_ACTIONS = [
  "suspend",
  "drain",
  "delete_ownership",
  "delete_installations",
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
