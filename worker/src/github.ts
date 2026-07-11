const githubApi = "https://api.github.com";
const apiVersion = "2022-11-28";

interface InstallationTokenResponse {
  token: string;
}

interface JitConfigResponse {
  encoded_jit_config: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodePem(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replaceAll(/\s/g, "");
  const decoded = atob(body);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0)).buffer;
}

async function appJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(
    new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId })),
  );
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodePem(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function githubFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  headers.set("user-agent", "jitney");
  headers.set("x-github-api-version", apiVersion);
  return fetch(`${githubApi}${path}`, { ...init, headers });
}

async function expectJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${operation} failed with GitHub status ${response.status}`);
  }
  return response.json<T>();
}

export interface ProvisioningInput {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  runnerName: string;
}

export async function generateJitConfig(input: ProvisioningInput): Promise<string> {
  const jwt = await appJwt(input.appId, input.privateKey);
  const installation = await githubFetch(`/repositories/${input.repositoryId}/installation`, jwt);
  const installed = await expectJson<{ id: number }>(installation, "installation verification");
  if (installed.id !== input.installationId) {
    throw new Error("verified repository is not owned by the payload installation");
  }

  const tokenResponse = await githubFetch(
    `/app/installations/${input.installationId}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: JSON.stringify({
        repositories: [input.repositoryName],
        permissions: { administration: "write", actions: "read" },
      }),
    },
  );
  const installationToken = await expectJson<InstallationTokenResponse>(
    tokenResponse,
    "installation token creation",
  );

  const jitResponse = await githubFetch(
    `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/actions/runners/generate-jitconfig`,
    installationToken.token,
    {
      method: "POST",
      body: JSON.stringify({ name: input.runnerName, runner_group_id: 1, labels: ["jitney"] }),
    },
  );
  const jit = await expectJson<JitConfigResponse>(jitResponse, "JIT configuration creation");
  return jit.encoded_jit_config;
}
