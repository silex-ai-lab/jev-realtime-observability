// T10 (batch 2 D5): report.ts prints where latency was measured from each run's meta, not a hardcoded host.
// Runs recorded before run.ts stored the host keep the old wording, so the 2026-09-28 report regenerates unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const V2 = 'runs/eval-2026-09-28-v2';
const withoutTimestamp = (s: string) => s.split('\n').filter(l => !l.startsWith('Generated ')).join('\n');
const report = (out: string, labels: string, extra: string[] = []) =>
  execFileSync(process.execPath, ['eval/run/report.ts', '--out', out, '--labels', labels, ...extra], { stdio: 'pipe' });

// N2 (plan 2026-09-30) added the Kev-4B fine-tune to the same report, with this note.
const V2_NOTE = 'Kev-4B fine-tune (work plan 2026-09-30 N2): the 2026-09-28 recipe with Kev-4B as init, trained on an Apple M4 Pro (48 GB) and served alone for this eval. Thresholds are fitted on the calibration split and recorded, not enabled.';

test('the 2026-09-28 report regenerates identically except its timestamp line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-report-'));
  cpSync(V2, dir, { recursive: true });
  report(dir, 'kev-0.8b,kev-0.8b-ft,kev-4b,kev-4b-ft', ['--note', V2_NOTE]);
  assert.equal(withoutTimestamp(readFileSync(join(dir, 'REPORT.md'), 'utf8')), withoutTimestamp(readFileSync(join(V2, 'REPORT.md'), 'utf8')));
});

test('a run whose meta records its host is reported with that host, and --note adds a header line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-report-'));
  cpSync(join(V2, 'predictions-kev-0.8b.jsonl'), join(dir, 'predictions-kev-0.8b.jsonl'));
  const meta = JSON.parse(readFileSync(join(V2, 'meta-kev-0.8b.json'), 'utf8'));
  writeFileSync(join(dir, 'meta-kev-0.8b.json'), JSON.stringify({ ...meta, host: { cpu: 'Test CPU 9000', runtime: 'mlx/bfloat16/mps' } }));
  report(dir, 'kev-0.8b', ['--note', 'Reproduction check of the 2026-09-28 recipe on another machine.']);
  const md = readFileSync(join(dir, 'REPORT.md'), 'utf8');
  assert.match(md, /on this machine \(Test CPU 9000, mlx\/bfloat16\/mps\)/);
  assert.doesNotMatch(md, /Apple M4 Pro/);
  assert.match(md, /^> Reproduction check of the 2026-09-28 recipe on another machine\.$/m);
});
