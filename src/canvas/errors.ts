/** Internal transport-level error; callers receive typed errors from src/errors.ts instead. */
export class CanvasApiError extends Error {
  constructor(public readonly status: number, statusText: string) {
    super(`Canvas API error: ${status} ${statusText}`);
    this.name = "CanvasApiError";
  }
}
