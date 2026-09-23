export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export type Bezier = readonly [number, number, number, number];

export const EASE_OUT_CUBIC: Bezier = [0.33, 1, 0.68, 1];
export const EASE_IN_OUT_CUBIC: Bezier = [0.65, 0, 0.35, 1];

export type TransitionConfig = { duration: number; ease: Bezier };
export type ResolvedTransition = {
  duration: number;
  ease: (t: number) => number;
};

/** Solves a cubic bezier for y given x, the standard CSS easing curve. */
const cubicBezier = ([p1x, p1y, p2x, p2y]: Bezier) => {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDerivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // Newton-Raphson first, it converges in a handful of steps.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-5) return sampleY(t);
      const d = sampleDerivativeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }

    // Bisection fallback for the flat regions Newton struggles with.
    let low = 0;
    let high = 1;
    t = x;
    while (low < high) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-5) break;
      if (x > value) low = t;
      else high = t;
      t = (high - low) / 2 + low;
      if (high - low < 1e-7) break;
    }
    return sampleY(t);
  };
};

export const resolveTransition = (
  config: TransitionConfig
): ResolvedTransition => ({
  duration: config.duration,
  ease: cubicBezier(config.ease),
});
