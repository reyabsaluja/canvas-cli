export function handleError(err: unknown): void {
  if (err instanceof Error) {
    if (err.message.includes("401")) {
      console.error("Authentication failed. Check your CANVAS_ACCESS_TOKEN.");
    } else if (
      err.message.includes("ENOTFOUND") ||
      err.message.includes("fetch failed")
    ) {
      console.error(
        "Network error. Check your CANVAS_BASE_URL and internet connection."
      );
    } else {
      console.error(`Error: ${err.message}`);
    }
  } else {
    console.error("An unexpected error occurred.");
  }
  process.exit(1);
}
