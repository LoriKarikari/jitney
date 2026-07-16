type WorkflowAction = "queued" | "in_progress" | "completed";

export type WorkflowEvent = {
  deliveryId: string;
  action: WorkflowAction;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  repositoryPrivate: boolean;
  workflowJobId: number;
  labels: string[];
  runnerName?: string;
  conclusion?: string;
};

export type QueuedJobCandidate = {
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  repositoryPrivate: boolean;
  workflowJobId: number;
  labels: string[];
};

export function isAdmissible(repositoryPrivate: boolean, labels: readonly string[]): boolean {
  return repositoryPrivate && labels.length === 1 && labels[0] === "jitney";
}
