import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";

export type ProvisioningInput = {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  runnerName: string;
};

export async function generateJitConfig(input: ProvisioningInput): Promise<string> {
  const auth = createAppAuth({ appId: input.appId, privateKey: input.privateKey });
  const app = new Octokit({ authStrategy: auth, auth: { type: "app" } });

  const { data: installation } = await app.request(
    "GET /repositories/{repository_id}/installation",
    { repository_id: input.repositoryId },
  );
  if (installation.id !== input.installationId) {
    throw new Error("repository is not owned by the payload installation");
  }

  const { token } = await auth({
    type: "installation",
    installationId: input.installationId,
    repositoryIds: [input.repositoryId],
    permissions: { administration: "write", actions: "read" },
  });

  const repo = new Octokit({ auth: token });
  const { data } = await repo.request(
    "POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig",
    {
      owner: input.repositoryOwner,
      repo: input.repositoryName,
      name: input.runnerName,
      runner_group_id: 1,
      labels: ["jitney"],
      work_folder: "_work",
    },
  );

  return data.encoded_jit_config;
}
