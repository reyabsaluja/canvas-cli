export async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<TResult>,
  signal?: AbortSignal | null
): Promise<TResult[]> {
  if (limit <= 0) {
    throw new Error("Concurrency limit must be greater than 0.");
  }
  if (items.length === 0) {
    return [];
  }

  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const outcomes = await Promise.allSettled(
    Array.from({ length: workerCount }, () => runWorker())
  );

  const errors = outcomes
    .filter((o): o is PromiseRejectedResult => o.status === "rejected")
    .map((o) => o.reason);

  if (errors.length > 0) {
    const nonAbort = errors.find(
      (e) => !(e instanceof Error && e.name === "AbortError")
    );
    throw nonAbort ?? errors[0];
  }

  return results;
}
