import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { Context, Effect, Schedule } from "effect";
import { InstallerError, tryPromise } from "./errors.js";
import type { GitHubAppCredentials } from "./github-app.js";
import type { GitHubInstallation } from "./receipts/schema.js";

const DEPLOYMENT_VARIABLE = "JITNEY_DEPLOYMENT";

const installationError = (message: string, cause?: unknown) =>
  new InstallerError({
    step: "github_app_installation",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const ownershipError = (message: string, cause?: unknown) =>
  new InstallerError({
    step: "repository_ownership",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "status" in cause && cause.status === 404;

const appToken = (credentials: GitHubAppCredentials) =>
  tryPromise("github_app_installation", "Could not authenticate as the GitHub App", async () => {
    const auth = createAppAuth({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
    });
    const authentication = await auth({ type: "app" });
    return authentication.token;
  });

const installationToken = (credentials: GitHubAppCredentials, installationId: number) =>
  tryPromise(
    "github_app_installation",
    `Could not authenticate GitHub App installation ${installationId}`,
    async () => {
      const auth = createAppAuth({
        appId: credentials.appId,
        privateKey: credentials.privateKey,
      });
      const authentication = await auth({ type: "installation", installationId });
      return authentication.token;
    },
  );

export const listGitHubInstallations = Effect.fn(function* (credentials: GitHubAppCredentials) {
  const token = yield* appToken(credentials);
  const installations: GitHubInstallation[] = [];
  for (let installationPage = 1; ; installationPage += 1) {
    const response = yield* tryPromise(
      "github_app_installation",
      "Could not inspect GitHub App installations",
      () =>
        request("GET /app/installations", {
          headers: { authorization: `bearer ${token}` },
          per_page: 100,
          page: installationPage,
        }),
    );
    for (const installation of response.data) {
      const account = installation.account;
      if (account === null || (account.type !== "User" && account.type !== "Organization")) {
        return yield* installationError(
          `GitHub App installation ${installation.id} has an unsupported owner`,
        );
      }
      const token = yield* installationToken(credentials, installation.id);
      const repositories: Array<GitHubInstallation["repositories"][number]> = [];
      for (let page = 1; ; page += 1) {
        const repositoriesPage = yield* tryPromise(
          "github_app_installation",
          `Could not list repositories for GitHub App installation ${installation.id}`,
          () =>
            request("GET /installation/repositories", {
              headers: { authorization: `bearer ${token}` },
              per_page: 100,
              page,
            }),
        );
        repositories.push(
          ...repositoriesPage.data.repositories.map((repository) => ({
            id: repository.id,
            name: repository.name,
            fullName: repository.full_name,
          })),
        );
        if (repositoriesPage.data.repositories.length < 100) break;
      }
      installations.push({
        id: installation.id,
        accountLogin: account.login,
        accountType: account.type,
        repositories,
      });
    }
    if (response.data.length < 100) break;
  }
  return installations;
});

export const waitForGitHubInstallations = (
  credentials: GitHubAppCredentials,
): Effect.Effect<readonly GitHubInstallation[], InstallerError> => {
  const pending = installationError("The GitHub App has not been installed yet");
  return listGitHubInstallations(credentials).pipe(
    Effect.flatMap((installations) =>
      installations.length > 0 ? Effect.succeed(installations) : Effect.fail(pending),
    ),
    Effect.retry({
      while: (error) => error === pending,
      schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(119)]),
    }),
  );
};

export class RepositoryVariables extends Context.Service<
  RepositoryVariables,
  {
    readonly read: (
      installationId: number,
      fullName: string,
    ) => Effect.Effect<string | undefined, InstallerError>;
    readonly create: (
      installationId: number,
      fullName: string,
      deploymentId: string,
    ) => Effect.Effect<void, InstallerError>;
    readonly remove: (
      installationId: number,
      fullName: string,
    ) => Effect.Effect<void, InstallerError>;
  }
>()("Jitney.RepositoryVariables") {}

export const claimRepositoryOwnership = Effect.fn(function* (
  deploymentId: string,
  installations: readonly GitHubInstallation[],
) {
  const variables = yield* RepositoryVariables;
  const missing: Array<{ installationId: number; fullName: string }> = [];

  // Inspect every repository before writing any marker. A foreign deployment
  // anywhere aborts without leaving a partial set of claims behind.
  for (const installation of installations) {
    for (const repository of installation.repositories) {
      const existing = yield* variables.read(installation.id, repository.fullName);
      if (existing !== undefined && existing !== deploymentId) {
        return yield* ownershipError(
          `${repository.fullName} already belongs to Jitney deployment ${existing}`,
        );
      }
      if (existing === undefined) {
        missing.push({ installationId: installation.id, fullName: repository.fullName });
      }
    }
  }

  for (const repository of missing) {
    yield* variables.create(repository.installationId, repository.fullName, deploymentId);
  }

  for (const installation of installations) {
    for (const repository of installation.repositories) {
      const observed = yield* variables.read(installation.id, repository.fullName);
      if (observed !== deploymentId) {
        return yield* ownershipError(
          `Could not verify this deployment's ownership of ${repository.fullName}`,
        );
      }
    }
  }
});

export const releaseRepositoryOwnership = Effect.fn(function* (
  deploymentId: string,
  installations: readonly GitHubInstallation[],
) {
  const variables = yield* RepositoryVariables;
  for (const installation of installations) {
    for (const repository of installation.repositories) {
      if ((yield* variables.read(installation.id, repository.fullName)) !== deploymentId) continue;
      yield* variables.remove(installation.id, repository.fullName);
    }
  }
});

const makeRepositoryVariables = (credentials: GitHubAppCredentials) => {
  const withRepository = <A>(
    installationId: number,
    fullName: string,
    operation: (token: string, owner: string, repo: string) => Effect.Effect<A, InstallerError>,
  ) => {
    const [owner, repo] = fullName.split("/", 2);
    if (owner === undefined || repo === undefined) {
      return Effect.fail(ownershipError(`GitHub returned an invalid repository name: ${fullName}`));
    }
    return installationToken(credentials, installationId).pipe(
      Effect.flatMap((token) => operation(token, owner, repo)),
    );
  };

  return RepositoryVariables.of({
    read: (installationId, fullName) =>
      withRepository(installationId, fullName, (token, owner, repo) =>
        Effect.tryPromise({
          try: () =>
            request("GET /repos/{owner}/{repo}/actions/variables/{name}", {
              owner,
              repo,
              name: DEPLOYMENT_VARIABLE,
              headers: { authorization: `bearer ${token}` },
            }),
          catch: (cause) =>
            ownershipError(`Could not read ${DEPLOYMENT_VARIABLE} on ${owner}/${repo}`, cause),
        }).pipe(
          Effect.map((response) => response.data.value),
          Effect.catch((error) =>
            isNotFound(error.cause) ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        ),
      ),
    create: (installationId, fullName, deploymentId) =>
      withRepository(installationId, fullName, (token, owner, repo) =>
        Effect.tryPromise({
          try: () =>
            request("POST /repos/{owner}/{repo}/actions/variables", {
              owner,
              repo,
              name: DEPLOYMENT_VARIABLE,
              value: deploymentId,
              headers: { authorization: `bearer ${token}` },
            }),
          catch: (cause) =>
            ownershipError(`Could not claim ${fullName} for this deployment`, cause),
        }).pipe(Effect.asVoid),
      ),
    remove: (installationId, fullName) =>
      withRepository(installationId, fullName, (token, owner, repo) =>
        Effect.tryPromise({
          try: () =>
            request("DELETE /repos/{owner}/{repo}/actions/variables/{name}", {
              owner,
              repo,
              name: DEPLOYMENT_VARIABLE,
              headers: { authorization: `bearer ${token}` },
            }),
          catch: (cause) =>
            ownershipError(`Could not release this deployment's ownership of ${fullName}`, cause),
        }).pipe(Effect.asVoid),
      ),
  });
};

export const claimGitHubRepositories = (
  credentials: GitHubAppCredentials,
  deploymentId: string,
  installations: readonly GitHubInstallation[],
) =>
  claimRepositoryOwnership(deploymentId, installations).pipe(
    Effect.provideService(RepositoryVariables, makeRepositoryVariables(credentials)),
  );

export const releaseGitHubRepositories = (
  credentials: GitHubAppCredentials,
  deploymentId: string,
  installations: readonly GitHubInstallation[],
) =>
  releaseRepositoryOwnership(deploymentId, installations).pipe(
    Effect.provideService(RepositoryVariables, makeRepositoryVariables(credentials)),
  );
