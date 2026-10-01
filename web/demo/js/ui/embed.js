// Host options for the demo page (silex-mockup logs/2026-09-30_JEV_RUNTIME_VALIDATION_PLAN.md §3).
//   ?embed=1      the page sits in a host's iframe: the brand title and back link are hidden.
//   ?back=<url>   the back link's target. Only a relative path is accepted, after URL decoding:
//                 it must start with ./ or ../ and contain no // and no backslash or control character.

/** The validated back target, or null to keep the default. `raw` is the decoded query value. */
export function safeBack(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return null;
  if (!/^\.{1,2}\//.test(raw)) return null;              // relative only, so no scheme can follow
  if (raw.includes('//') || /[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

/** Applies ?embed and ?back to the page. */
export function applyHostOptions(params, doc = document) {
  if (params.get('embed') === '1') doc.body.classList.add('embed');
  const back = safeBack(params.get('back'));
  const a = doc.querySelector('.jv-back');
  if (back && a) { a.setAttribute('href', back); a.textContent = '← Back'; }
}
