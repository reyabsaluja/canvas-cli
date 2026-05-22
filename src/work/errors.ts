export class ToolRuntimeError extends Error {
  readonly toolName: string;
  constructor(toolName: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Tool "${toolName}" failed: ${msg}`);
    this.name = "ToolRuntimeError";
    this.toolName = toolName;
    this.cause = cause;
  }
}
