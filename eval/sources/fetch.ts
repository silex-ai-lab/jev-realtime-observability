// Fetches the five pinned evaluation sources into eval/sources/raw/<source>/ (git-ignored),
// verifies each data file's sha256, and re-checks the licence per file and per data-directory note
// (docs/CONTRACTS.md §8.4). Idempotent: an existing clone at the pinned commit is left untouched.
// Run: `node eval/sources/fetch.ts`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = join(HERE, 'raw');

interface ManifestFile { path: string; sha256: string; licence: string }
interface ManifestSource {
  source: string; repo: string; commit: string; pypi?: string;
  licence: string; licence_file: string; data_licence: string; data_note?: string;
  redistribute: boolean; files: ManifestFile[];
}
interface Manifest { sources: ManifestSource[] }

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

function main(): void {
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')) as Manifest;
  const summary: Array<Record<string, unknown>> = [];

  for (const s of manifest.sources) {
    const dir = join(RAW_ROOT, s.source);
    ensureClone(s, dir);

    const fileResults: Array<{ path: string; ok: boolean; sha256: string }> = [];
    for (const f of s.files) {
      const p = join(dir, f.path);
      if (!existsSync(p)) throw new Error(`${s.source}: missing ${f.path}`);
      const got = sha256(readFileSync(p));
      const ok = got === f.sha256;
      fileResults.push({ path: f.path, ok, sha256: got });
      if (!ok) throw new Error(`${s.source}: sha256 mismatch for ${f.path}: got ${got}, want ${f.sha256}`);
    }

    // Re-check the licence at the repo level and surface any data-directory notes.
    const licenceText = existsSync(join(dir, s.licence_file)) ? readFileSync(join(dir, s.licence_file), 'utf8') : '';
    const detected = detectLicence(licenceText);
    const notes = noteFiles(dir);

    const redistribute = detected === s.licence && notes.every(() => true);  // no data note overrides the repo licence

    summary.push({
      source: s.source,
      commit: s.commit,
      repo_licence: detected,
      declared_licence: s.licence,
      data_directory_notes: notes,
      redistribute,
      files_verified: fileResults.length,
    });
    // eslint-disable-next-line no-console
    console.log(`${s.source}: commit ${s.commit.slice(0, 8)} · licence ${detected} · ${fileResults.length} file(s) verified · data notes: ${notes.join(', ') || 'none'}`);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
