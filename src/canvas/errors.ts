export class CanvasApiError extends Error {
  constructor(public readonly status: number, statusText: string) {
    super(`Canvas API error: ${status} ${statusText}`);
    this.name = "CanvasApiError";
  }

  get userHint(): string | null {
    switch (this.status) {
      case 401:
        return "Check your CANVAS_ACCESS_TOKEN.";
      case 403:
        return "You do not have permission to access this resource.";
      case 404:
        return "The requested resource was not found on Canvas.";
      default:
        return null;
    }
  }
}
