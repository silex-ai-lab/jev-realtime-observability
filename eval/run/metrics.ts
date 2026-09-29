// Metrics for binary (Noul) and categorical (Choice / Score) predictions, with seeded bootstrap CIs.
export interface BinaryPoint { p: number | null; y: boolean }      // p = model probability of "true" (null = no answer)

const mulberry = (seed: number) => () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export function binaryMetrics(points: BinaryPoint[], threshold = 0.5) {
  const answered = points.filter((x): x is { p: number; y: boolean } => x.p != null);
  const n = points.length, na = answered.length;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const x of answered) { const pred = x.p >= threshold; if (pred && x.y) tp++; else if (pred) fp++; else if (x.y) fn++; else tn++; }
  const brier = na ? answered.reduce((s, x) => s + (x.p - (x.y ? 1 : 0)) ** 2, 0) / na : null;
  return {
    n, answered: na, positives: answered.filter(x => x.y).length, threshold,
    accuracy: na ? (tp + tn) / na : null,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    false_positive_rate: fp + tn ? fp / (fp + tn) : null,
    brier, ece: ece(answered), auroc: auroc(answered), tp, fp, tn, fn,
  };
}

/** Expected calibration error, 10 equal-width bins. */
export function ece(points: Array<{ p: number; y: boolean }>, bins = 10): number | null {
  if (!points.length) return null;
  let e = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const inBin = points.filter(x => x.p >= lo && (b === bins - 1 ? x.p <= hi : x.p < hi));
    if (!inBin.length) continue;
    const conf = inBin.reduce((s, x) => s + x.p, 0) / inBin.length;
    const acc = inBin.filter(x => x.y).length / inBin.length;
    e += (inBin.length / points.length) * Math.abs(conf - acc);
  }
  return e;
}

/** AUROC by the rank statistic; null if only one class present. */
export function auroc(points: Array<{ p: number; y: boolean }>): number | null {
  const pos = points.filter(x => x.y).map(x => x.p), neg = points.filter(x => !x.y).map(x => x.p);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Percentile bootstrap CI of a statistic over resampled items; seeded, so reruns are identical. */
export function bootstrapCI<T>(items: T[], stat: (xs: T[]) => number | null, reps = 1000, seed = 20260928): [number, number] | null {
  if (items.length < 2) return null;
  const rnd = mulberry(seed);
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const sample = Array.from({ length: items.length }, () => items[Math.floor(rnd() * items.length)]);
    const v = stat(sample);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < reps * 0.5) return null;
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * (vals.length - 1))], vals[Math.ceil(0.975 * (vals.length - 1))]];
}

/** One-sided 95% upper bound on an error rate when 0 errors were seen in n trials (rule of three, RFC §12.2). */
export const ruleOfThree = (n: number) => (n ? 3 / n : null);

/** Threshold on the calibration split: the smallest threshold whose precision ≥ target, else the max-F1 threshold. */
export function chooseThreshold(points: Array<{ p: number; y: boolean }>, targetPrecision = 0.9): { threshold: number; rule: string } {
  const grid = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
  let bestF1 = -1, bestT = 0.5;
  for (const t of grid) {
    const m = binaryMetrics(points, t);
    if (m.precision != null && m.precision >= targetPrecision && (m.recall ?? 0) > 0) return { threshold: t, rule: `lowest threshold with precision ≥ ${targetPrecision} on the calibration split` };
    const f1 = m.precision && m.recall ? (2 * m.precision * m.recall) / (m.precision + m.recall) : 0;
    if (f1 > bestF1) { bestF1 = f1; bestT = t; }
  }
  return { threshold: bestT, rule: `no threshold reached precision ${targetPrecision}; max-F1 threshold on the calibration split` };
}
