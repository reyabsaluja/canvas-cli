export async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<TResult>
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
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker())
  );
  return results;
}
