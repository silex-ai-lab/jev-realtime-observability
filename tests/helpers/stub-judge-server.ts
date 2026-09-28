// Stub judge server for tests (docs/CONTRACTS.md §6): a real HTTP server speaking /v1/systemone
// and /v1/models, so the production client path is exercised. Its /v1/models reports backend "stub";
// it is only ever used by tests, never wired into the app.
import { createServer } from 'node:http';
import type { SystemOneRequest } from '../../contracts/judge.ts';

export interface StubJudgeResponse { status: number; body: unknown; delayMs?: number; headers?: Record<string, string> }
export interface StubJudgeOptions {
  models?: unknown;
  respond?: (req: SystemOneRequest) => StubJudgeResponse | Promise<StubJudgeResponse>;
}
export interface StubJudgeServer {
  url: string;
  calls: SystemOneRequest[];
  close(): Promise<void>;
}

const DEFAULT_MODELS = {
  models: [
    { name: 'stub-latest', run: 'stub', base: null, backend: 'stub', dtype: 'stub', device: 'stub', temperature: null, revision: null },
  ],
};

function defaultRespond(req: SystemOneRequest): StubJudgeResponse {
  const answers: Record<string, unknown> = {};
  for (const [qid, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') answers[qid] = { type: 'noul', noul: 0.1 };
    else if (q.type === 'choice') answers[qid] = { type: 'choice', choice: Object.keys(q.criteria)[0], probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 1 : 0])) };
    else answers[qid] = { type: 'score', score: 0, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 0 ? 1 : 0])) };
  }
  return { status: 200, body: { model: req.model, answers, usage: { input_tokens: 1, output_tokens: 1 } } };
}

export async function startStubJudge(opts: StubJudgeOptions = {}): Promise<StubJudgeServer> {
  const calls: SystemOneRequest[] = [];
  const models = opts.models ?? DEFAULT_MODELS;

  const server = createServer((req, res) => {
    res.on('error', () => {});
    if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/v1/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(models));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/systemone') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let parsed: SystemOneRequest;
        try { parsed = JSON.parse(body) as SystemOneRequest; } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
          return;
        }
        calls.push(parsed);
        void Promise.resolve(opts.respond ? opts.respond(parsed) : defaultRespond(parsed)).then(r => {
          const { status = 200, body: respBody, delayMs = 0, headers = {} } = r ?? {};
          const send = () => {
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(status, { 'content-type': 'application/json', ...headers });
            res.end(typeof respBody === 'string' ? respBody : JSON.stringify(respBody));
          };
          if (delayMs > 0) setTimeout(send, delayMs); else send();
        });
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}
