/** Stands in for the `cloudflare:workers` module, which only exists in workerd. */
export class WorkflowEntrypoint<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env
  ) {}
}
