// Fetches the five pinned evaluation sources into eval/sources/raw/<source>/ (git-ignored),
// verifies each data file's sha256, and re-checks the licence at the repo level and against every
// data-directory note file listed in the manifest (docs/CONTRACTS.md §8.4). Fail-closed: a note file
// found on disk but not listed in the manifest, or a listed note whose sha256 differs, aborts.
// `redistribute` is false when the detected repo licence differs from the manifest, or any listed
// note is `restrictive`. Idempotent: an existing clone at the pinned commit is left untouched.
// Run: `node eval/sources/fetch.ts`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = join(HERE, 'raw');

/** A data-directory note file a human reviewed: its path, pinned sha256 and the reviewer's call. */
export type NoteDecision = 'permissive-same-as-repo' | 'restrictive' | 'not-a-licence';
export interface ManifestNote { path: string; sha256: string; decision: NoteDecision }

export interface ManifestFile { path: string; sha256: string; licence: string }
export interface ManifestSource {
  source: string; repo: string; commit: string; pypi?: string;
  licence: string; licence_file: string; data_licence: string;
  notes: ManifestNote[];
  redistribute: boolean; files: ManifestFile[];
}
interface Manifest { sources: ManifestSource[] }

export interface SourceSummary {
  source: string;
  commit: string;
  repo_licence: string;
  declared_licence: string;
  data_directory_notes: Array<{ path: string; decision: NoteDecision }>;
  redistribute: boolean;
  files_verified: number;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const git = (args: string[], cwd?: string): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function detectLicence(text: string): string {
  if (/apache license/i.test(text)) return 'Apache-2.0';
  if (/MIT license|Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/BSD [23]-Clause/i.test(text)) return 'BSD';
  return 'other-or-undeclared';
}

/** Files that could carry a data-specific licence or terms note: LICENCE/NOTICE/COPYING anywhere
 * (other than the root licence file), and README/readme files under data-ish directories. */
function noteFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      const rel = p.slice(dir.length + 1);
      const isLicence = /^(LICEN[CS]E|NOTICE|COPYING)/i.test(name);
      const isDataReadme = /^readme/i.test(name) && /(^|\/)(data|assets|datasets)(\/|$)/.test(rel);
      if (isLicence && rel.includes('/')) out.push(rel);
      else if (isDataReadme) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

function ensureClone(s: ManifestSource, dir: string): void {
  if (existsSync(join(dir, '.git'))) {
    const head = git(['rev-parse', 'HEAD'], dir);
    if (head === s.commit) return;             // already at the pinned commit
    git(['checkout', '--quiet', s.commit], dir);
    return;
  }
  git(['clone', '--quiet', s.repo, dir]);
  git(['checkout', '--quiet', s.commit], dir);
}

/**
 * Verifies one source's pinned files, repo licence and data-directory note files against the
 * manifest. Reads from `dir` only (no git); `ensureClone` must already have put the pinned commit
 * there. Throws on: a missing file, a file sha256 mismatch, a note file found on disk that is not
 * listed in the manifest, or a listed note that is missing or whose sha256 differs. `redistribute`
 * is false when the detected repo licence differs from the manifest or any listed note is
 * `restrictive`.
 */
export function verifySource(s: ManifestSource, dir: string): SourceSummary {
  for (const f of s.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) throw new Error(`${s.source}: missing ${f.path}`);
    const got = sha256(readFileSync(p));
    if (got !== f.sha256) throw new Error(`${s.source}: sha256 mismatch for ${f.path}: got ${got}, want ${f.sha256}`);
  }

  const licenceText = existsSync(join(dir, s.licence_file)) ? readFileSync(join(dir, s.licence_file), 'utf8') : '';
  const detected = detectLicence(licenceText);

  // Data-directory notes (fail-closed): every note file on disk must be listed with a decision, and
  // every listed note must be present and byte-identical to the sha256 the reviewer recorded. A note
  // that is unreviewed, or changed after review, could carry terms we have not assessed — abort.
  const discovered = noteFiles(dir);
  const listed = new Map(s.notes.map(n => [n.path, n]));
  for (const rel of discovered) {
    if (!listed.has(rel)) {
      throw new Error(`${s.source}: data-directory note file "${rel}" found but not listed in the manifest (add its path, sha256 and decision)`);
    }
  }
  for (const n of s.notes) {
    const p = join(dir, n.path);
    if (!existsSync(p)) throw new Error(`${s.source}: data-directory note file "${n.path}" listed in the manifest but missing at commit ${s.commit}`);
    const got = sha256(readFileSync(p));
    if (got !== n.sha256) throw new Error(`${s.source}: sha256 mismatch for note "${n.path}": got ${got}, want ${n.sha256}`);
  }

  const repoLicenceMatches = detected === s.licence;
  const anyRestrictive = s.notes.some(n => n.decision === 'restrictive');
  const redistribute = repoLicenceMatches && !anyRestrictive;

  return {
    source: s.source,
    commit: s.commit,
    repo_licence: detected,
    declared_licence: s.licence,
    data_directory_notes: s.notes.map(n => ({ path: n.path, decision: n.decision })),
    redistribute,
    files_verified: s.files.length,
  };
}

function main(): void {
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')) as Manifest;
  const summary: SourceSummary[] = [];
  for (const s of manifest.sources) {
    const dir = join(RAW_ROOT, s.source);
    ensureClone(s, dir);
    const result = verifySource(s, dir);
    summary.push(result);
    // eslint-disable-next-line no-console
    console.log(`${result.source}: commit ${result.commit.slice(0, 8)} · licence ${result.repo_licence} · ${result.files_verified} file(s) verified · notes: ${result.data_directory_notes.map(n => `${n.path} (${n.decision})`).join(', ') || 'none'}`);
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
