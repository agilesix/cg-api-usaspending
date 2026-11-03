/**
 * The slice of the `cloudflare:workers` module this API uses, declared here
 * rather than pulled from `@cloudflare/workers-types` (see
 * `src/storage/types.ts`). Tests alias the module to `test/stubs/`.
 */

declare module "cloudflare:workers" {
  type Duration = string | number;

  export interface WorkflowStepConfig {
    retries?: { limit: number; delay: Duration; backoff?: "constant" | "linear" | "exponential" };
    timeout?: Duration;
  }

  export interface WorkflowEvent<Params> {
    payload: Readonly<Params>;
    timestamp: Date;
    instanceId: string;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: Duration): Promise<void>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected readonly ctx: unknown;
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
