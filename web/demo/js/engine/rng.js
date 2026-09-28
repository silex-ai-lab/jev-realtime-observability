// Seeded PRNG. Every random draw in the engine comes from here, keyed by
// (seed, span_id, purpose), so a replay of one span with a different policy
// sees exactly the same simulated judge answers and latencies.

export function hashString(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator with helpers. `parts` are joined into the seed key. */
export function makeRng(...parts) {
  const next = mulberry32(hashString(parts.join('|')));
  return {
    next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()), // inclusive
    pick: arr => arr[Math.floor(next() * arr.length)],
    chance: p => next() < p,
  };
}

/** The per-span generator every engine stage must use. */
export const rngFor = (seed, spanId, purpose) => makeRng(String(seed), spanId, purpose);
