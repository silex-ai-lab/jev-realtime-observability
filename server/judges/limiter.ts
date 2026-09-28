// Token-bucket rate limiting and request/response helpers for the judge client.
// Durations use performance.now() (monotonic); deadlines are absolute monotonic ms.
import type { SystemOneRequest } from '../../contracts/judge.ts';

export const monotonicMs = (): number => performance.now();

interface Waiter {
  weight: number;
  deadline: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** A single token bucket that refills at a fixed rate and queues waiters FIFO. */
export class TokenBucket {
  readonly ratePerSec: number;
  readonly capacity: number;
  private tokens: number;
  private last: number;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ratePerSec: number, capacity: number) {
    this.ratePerSec = ratePerSec;
    this.capacity = capacity;
    this.tokens = capacity;
    this.last = monotonicMs();
  }

  private refill(): void {
    const t = monotonicMs();
    const elapsed = (t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
      this.last = t;
    }
  }

  /** Resolves once `weight` tokens are available before `deadline`, else rejects. */
  acquire(weight: number, deadline: number): Promise<void> {
    this.refill();
    if (deadline <= monotonicMs()) return Promise.reject(new Error('limiter deadline exceeded'));
    if (this.queue.length === 0 && this.tokens >= weight) {
      this.tokens -= weight;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ weight, deadline, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer) return;
    const step = () => {
      this.timer = null;
      this.refill();
      const t = monotonicMs();
      const expired = this.queue.filter(w => w.deadline <= t);
      this.queue = this.queue.filter(w => w.deadline > t);
      for (const w of expired) w.reject(new Error('limiter deadline exceeded'));
      while (this.queue.length && this.queue[0].weight <= this.tokens) {
        const w = this.queue.shift()!;
        this.tokens -= w.weight;
        w.resolve();
      }
      if (this.queue.length) {
        const refillMs = ((this.queue[0].weight - this.tokens) / Math.max(1e-9, this.ratePerSec)) * 1000;
        const earliestDeadline = Math.min(...this.queue.map(w => w.deadline));
        const waitMs = Math.max(1, Math.min(refillMs, earliestDeadline - monotonicMs()));
        this.timer = setTimeout(step, waitMs);
      }
    };
    this.timer = setTimeout(step, 0);
  }
}

/** Combined request-rate and input-token-rate limiter for one judge client. */
export class CallLimiter {
  private requests: TokenBucket;
  private tokens: TokenBucket;

  constructor(maxRps: number, maxInputTokensPerSec: number) {
    this.requests = new TokenBucket(Math.max(0.01, maxRps), Math.max(1, maxRps));
    this.tokens = new TokenBucket(Math.max(0.01, maxInputTokensPerSec), Math.max(1, maxInputTokensPerSec));
  }

  /** Acquires one request slot and `inputTokens` tokens before `deadline`. */
  async acquire(inputTokens: number, deadline: number): Promise<void> {
    await this.requests.acquire(1, deadline);
    await this.tokens.acquire(inputTokens, deadline);
  }
}

/** Rough token estimate (4 chars/token) of the request's input size, for the limiter. */
export function estimateInputTokens(req: SystemOneRequest): number {
  let chars = req.state.length;
  for (const q of Object.values(req.questions)) {
    chars += q.instructions.length;
    if (q.type === 'choice') chars += Object.entries(q.criteria).reduce((n, [k, v]) => n + k.length + (v?.length ?? 0), 0);
    else if (q.type === 'score') chars += q.criteria.reduce((n, c) => n + c.length, 0);
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Reads a fetch response body up to `maxBytes`. Returns `truncated` when the body exceeds the
 * cap (the stream is cancelled), and `aborted` when the deadline aborted it mid-read.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean; aborted: boolean }> {
  if (!res.body) return { text: '', truncated: false, aborted: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) return { text: '', truncated: false, aborted: true };
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return { text: '', truncated: true, aborted: false };
      }
      chunks.push(value);
    }
  } catch (e) {
    if (signal.aborted) return { text: '', truncated: false, aborted: true };
    throw e;
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder().decode(buf), truncated: false, aborted: false };
}
