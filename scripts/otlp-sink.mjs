#!/usr/bin/env node
// A local OTLP/HTTP JSON sink for demos (docs/demo/SUMO_DEMO.md, beat 7): it accepts the decision spans a console
// exports (OTLP_EXPORT_URL=http://127.0.0.1:4318/v1/traces) and prints each span's exported attributes, one line per
// span. It stores nothing and forwards nothing. It is not Sumo Logic or any other backend.
//   node scripts/otlp-sink.mjs [port]   (default 4318, bound to 127.0.0.1)
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4318);
createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const spans = (JSON.parse(body).resourceSpans ?? []).flatMap(r => (r.scopeSpans ?? []).flatMap(s => s.spans ?? []));
      for (const sp of spans) console.log(new Date().toISOString(), JSON.stringify(Object.fromEntries((sp.attributes ?? []).map(a => [a.key, a.value?.stringValue]))));
    } catch { console.log(new Date().toISOString(), `unparsed body (${body.length} bytes)`); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log(`otlp sink listening on http://127.0.0.1:${port}/v1/traces`));
