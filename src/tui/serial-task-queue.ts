export interface SerialTaskQueue {
  enqueue(task: () => void | Promise<void>): void;
  close(): void;
  onIdle(): Promise<void>;
}

export function createSerialTaskQueue(): SerialTaskQueue {
  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  return {
    enqueue(task) {
      chain = chain
        .catch(() => {})
        .then(async () => {
          if (closed) return;
          await task();
        });
    },
    close() {
      closed = true;
    },
    async onIdle() {
      await chain.catch(() => {});
    },
  };
}
