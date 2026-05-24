export type SleepFn = (ms: number, signal?: AbortSignal | null) => Promise<void>;
export type LogFn = (message: string) => void;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  }

  async throttleIfNeeded(signal?: AbortSignal | null): Promise<void> {
    if (this.remaining !== null && this.remaining < this.threshold) {
      const ratio = Math.max(0, 1 - this.remaining / this.threshold);
      const delay = Math.ceil(this.delayMs * (1 + ratio * 3));
      this.log(`Rate limit low (${this.remaining} remaining), throttling ${delay}ms...`);
      await this.sleepFn(delay, signal);
    }
  }

  get currentRemaining(): number | null {
    return this.remaining;
  }
}
