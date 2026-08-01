const prefix = "jitney-";
const deploymentId = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const ownershipEnvironmentName = (id: string): string => `${prefix}${id}`;

export const deploymentIdFromOwnershipEnvironment = (name: string): string | undefined => {
  const id = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  return deploymentId.test(id) ? id : undefined;
};
