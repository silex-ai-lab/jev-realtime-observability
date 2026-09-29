// fetch.ts fail-closed data-note licence check (docs/CONTRACTS.md §8.4, docs/EVAL.md Data section).
// Uses a temp fixture directory (no git clone, no fetched raw data). The "real manifest passes" case
// runs against eval/sources/raw/ when it has been fetched, and skips otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySource, type ManifestNote, type ManifestSource } from '../../../eval/sources/fetch.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = join(HERE, '..', '..', '..', 'eval', 'sources', 'raw');
const MANIFEST_PATH = join(HERE, '..', '..', '..', 'eval', 'sources', 'manifest.json');

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n';

function makeFixture(opts: { licenceText?: string; noteContent?: string; notes?: ManifestNote[] } = {}): { dir: string; source: ManifestSource; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gB-fetch-'));
  const licenceText = opts.licenceText ?? MIT;
  writeFileSync(join(dir, 'LICENSE'), licenceText);
  if (opts.noteContent !== undefined) {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data/readme.md'), opts.noteContent);
  }
  const source: ManifestSource = {
    source: 'fixture',
    repo: 'https://example.invalid/fixture',
    commit: '0000000',
    licence: 'MIT',
    licence_file: 'LICENSE',
    data_licence: 'MIT',
    notes: opts.notes ?? [],
    redistribute: true,
    files: [{ path: 'LICENSE', sha256: sha256(licenceText), licence: 'MIT' }],
  };
  return { dir, source, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('an unlisted data-directory note file aborts the fetch', () => {
  const f = makeFixture({ noteContent: 'some note text' }); // on disk, but notes: [] in the manifest
  try {
    assert.throws(() => verifySource(f.source, f.dir), /not listed in the manifest/);
  } finally {
    f.cleanup();
  }
});

test('a listed note whose sha256 differs from the manifest aborts the fetch', () => {
  const f = makeFixture({
    noteContent: 'the real note',
    notes: [{ path: 'data/readme.md', sha256: sha256('different content'), decision: 'not-a-licence' }],
  });
  try {
    assert.throws(() => verifySource(f.source, f.dir), /sha256 mismatch for note/);
  } finally {
    f.cleanup();
  }
});

test('a restrictive note flips redistribute to false', () => {
  const content = 'this data may not be redistributed';
  const f = makeFixture({
    noteContent: content,
    notes: [{ path: 'data/readme.md', sha256: sha256(content), decision: 'restrictive' }],
  });
  try {
    assert.equal(verifySource(f.source, f.dir).redistribute, false);
  } finally {
    f.cleanup();
  }
});

test('a detected repo licence that differs from the manifest flips redistribute to false', () => {
  const f = makeFixture({ licenceText: 'All rights reserved.\n' }); // detectLicence → other-or-undeclared ≠ MIT
  try {
    assert.equal(verifySource(f.source, f.dir).redistribute, false);
  } finally {
    f.cleanup();
  }
});

test('the real manifest verifies against the fetched raw data', async (t) => {
  if (!existsSync(RAW_ROOT)) {
    t.skip('eval/sources/raw/ not fetched (run node eval/sources/fetch.ts)');
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { sources: ManifestSource[] };
  for (const s of manifest.sources) {
    const dir = join(RAW_ROOT, s.source);
    assert.ok(existsSync(dir), `${s.source} is listed in the manifest but not fetched under eval/sources/raw/`);
    const summary = verifySource(s, dir);
    assert.equal(summary.redistribute, true, `${s.source} should be redistributable (permissive repo licence, no restrictive note)`);
    assert.equal(summary.repo_licence, s.licence, `${s.source} repo licence should match the manifest`);
  }
});
