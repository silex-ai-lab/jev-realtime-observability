export const CANARY_JUDGE_API_KEY = 'silex-canary-judge-key-DO-NOT-LEAK';

export function assertNoCanary(value: unknown, context: string): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text?.includes(CANARY_JUDGE_API_KEY)) {
    throw new Error(`canary leaked in ${context}`);
  }
}
