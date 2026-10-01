// silex-mockup Runtime Validation plan §3: ?back accepts only a decoded relative path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser module without a declaration file
import { safeBack } from '../../../web/demo/js/ui/embed.js';

const decoded = (q: string) => new URLSearchParams(q).get('back');

test('safeBack rejects schemes, protocol-relative, absolute, encoded tricks, empty and malformed values', () => {
  for (const q of ['back=javascript:alert(1)', 'back=jav%61script:alert(1)', 'back=//evil.example', 'back=%2F%2Fevil.example',
    'back=https://x.example', 'back=/index.html', 'back=', 'back=..', 'back=.%2F%2Fevil', 'back=../a%5Cb', 'back=../a%0Ab', 'x=1'])
    assert.equal(safeBack(decoded(q)), null, q);
  assert.equal(safeBack(null), null);
  assert.equal(safeBack(42 as any), null);
});

test('safeBack keeps a relative path with its fragment', () => {
  const q = 'back=' + encodeURIComponent('../../index.html#view=long-term&tab=runtime');
  assert.equal(safeBack(decoded(q)), '../../index.html#view=long-term&tab=runtime');
  assert.equal(safeBack('./x.html'), './x.html');
});
