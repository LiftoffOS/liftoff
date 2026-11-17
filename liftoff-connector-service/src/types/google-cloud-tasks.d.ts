// Minimal ambient declaration for @google-cloud/tasks.
// Used locally when the package is not installed; CI uses the real package types.
declare module '@google-cloud/tasks' {
  export class CloudTasksClient {
    queuePath(project: string, location: string, queue: string): string;
    createTask(request: unknown): Promise<unknown>;
  }
}
