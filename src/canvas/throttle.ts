export type SleepFn = (ms: number, signal?: AbortSignal | null) => Promise<void>;
export type LogFn = (message: string) => void;

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const THROTTLE_THRESHOLD = 100;
export const THROTTLE_DELAY_MS = 500;

export interface ThrottleOptions {
  threshold?: number;
  delayMs?: number;
  sleepFn?: SleepFn;
  log?: LogFn;
}

export class RateLimitThrottle {
  private remaining: number | null = null;
  private lastCost: number = 1;
  private readonly threshold: number;
  private readonly delayMs: number;
  private readonly sleepFn: SleepFn;
  private readonly log: LogFn;

  constructor(options?: ThrottleOptions) {
    this.threshold = options?.threshold ?? THROTTLE_THRESHOLD;
    this.delayMs = options?.delayMs ?? THROTTLE_DELAY_MS;
    this.sleepFn = options?.sleepFn ?? defaultSleep;
    this.log = options?.log ?? (() => {});
  }

  update(response: Response): void {
    const header = response.headers.get("x-rate-limit-remaining");
    if (header !== null) {
      const value = parseFloat(header);
      if (Number.isFinite(value)) {
        this.remaining = value;
      }
    }
    const costHeader = response.headers.get("x-request-cost");
    if (costHeader !== null) {
      const cost = parseFloat(costHeader);
      if (Number.isFinite(cost) && cost > 0) {
        this.lastCost = cost;
      }
    }
  }

  async throttleIfNeeded(signal?: AbortSignal | null): Promise<void> {
    if (this.remaining === null) return;
    const effectiveRemaining = this.remaining / this.lastCost;
    if (effectiveRemaining < this.threshold) {
      const ratio = Math.max(0, 1 - effectiveRemaining / this.threshold);
      const delay = Math.ceil(this.delayMs * (1 + ratio * 3));
      this.log(`Rate limit low (${this.remaining} remaining, cost ${this.lastCost}), throttling ${delay}ms...`);
      await this.sleepFn(delay, signal);
    }
  }

  get currentRemaining(): number | null {
    return this.remaining;
  }

  get currentCost(): number {
    return this.lastCost;
  }
}
