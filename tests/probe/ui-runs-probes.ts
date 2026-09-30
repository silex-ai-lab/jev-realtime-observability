#!/usr/bin/env node
// Runs-view acceptance through the real console, with independent wording expectations.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { harnessFromApp, startGateAHarness, TENANTS, waitFor, type GateAHarness } from '../helpers/harness.ts';
import { startStubJudge, type StubJudgeServer } from '../helpers/stub-judge-server.ts';
import { createApp } from '../../server/app.ts';
import type { StoredEvent } from '../../contracts/events.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
class SkipProbe extends Error {}
const results: Array<{id: string; status: string; detail: string}> = [];
let chrome: ChildProcessWithoutNullStreams | null = null;
let page: Cdp | null = null;
let browser: Cdp | null = null;
let browserUnavailable: string | null = null;
let stub: StubJudgeServer | null = null;
let fixtureServer: Server | null = null;
interface Cdp {
  ws: WebSocket;
  errors: string[];
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  eval<T>(body: string): Promise<T>;
}

async function connect(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const client: Cdp = {
    ws, errors: [],
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async eval<T>(body: string) {
      const result = await client.send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
      const exception = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      if (exception) throw new Error(exception.exception?.description ?? exception.text ?? 'Runtime exception');
      return (result.result as { value: T }).value;
    },
  };
  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown; method?: string; params?: unknown };
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result ?? {}); }
    }
    if (msg.method === 'Runtime.exceptionThrown') client.errors.push(JSON.stringify(msg.params));
    if (msg.method === 'Runtime.consoleAPICalled') {
      const p = msg.params as { type: string; args: Array<{ value?: unknown; description?: string }> };
      if (p.type === 'error') client.errors.push(p.args.map(a => String(a.value ?? a.description)).join(' '));
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP connection closed')); }
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
  });
  return client;
}

async function ensureBrowser(): Promise<Cdp> {
  if (browserUnavailable) throw new SkipProbe(browserUnavailable);
  if (page) return page;
  const candidates = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter((s): s is string => !!s);
  let executable: string | null = null;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch { /* next */ } }
  if (!executable) { browserUnavailable = 'Chrome not found; set CHROME to run console probes'; throw new SkipProbe(browserUnavailable); }
  const profile = await mkdtemp(join(tmpdir(), 'jev-ui-runs-probes-'));
  chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'pipe' });
  let launchError = '';
  chrome.on('error', e => { launchError = e.message; });
  const port = await waitFor(async () => {
    if (launchError || chrome?.exitCode != null) throw new Error(`Chrome launch failed: ${launchError || chrome?.exitCode}`);
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || null; } catch { return null; }
  }, 'Chrome DevTools port', 10_000);
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string };
  browser = await connect(version.webSocketDebuggerUrl);
  const targets = await (await fetch(`${endpoint}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find(t => t.type === 'page');
  assert.ok(target, 'Chrome page target missing');
  page = await connect(target.webSocketDebuggerUrl);
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await page.send(method);
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  return page;
}

type Entry = { event: StoredEvent; evaluations?:EvaluationRecord[]; decisions: Array<PolicyDecision & { replay_of?: string | null }> };
type Timeline = { timeline: Entry[] };
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const selectCard = (runId: string) => `#runs .run-card[data-run-id="${runId}"]`;
const selectStep = (runId: string, eventId: string) => `${selectCard(runId)} .step[data-event-id="${eventId}"]`;

async function navigate(url: string, h?: GateAHarness): Promise<Cdp> {
  const p = await ensureBrowser();
  await p.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  p.errors.length = 0;
  await p.send('Page.navigate', { url });
  await waitFor(() => p.eval<boolean>('return document.readyState === "complete" && !!document.querySelector("#connect-form")'), 'console DOM', 10_000);
  if (!await p.eval<boolean>('return !!document.querySelector("#runs")')) throw new SkipProbe('Runs UI has not landed: #runs is absent');
  await waitFor(() => p.eval<boolean>('return !!document.body.dataset.authMode'), 'auth mode', 10_000);
  if (h && await p.eval<string>('return document.body.dataset.authMode') !== 'none') {
    await p.eval<void>(`document.querySelector('#k-reader').value=${JSON.stringify(h.key('alpha', 'reader'))};
      document.querySelector('#k-admin').value=${JSON.stringify(h.key('alpha', 'admin'))}; document.querySelector('#connect-form').requestSubmit();`);
  }
  await waitFor(() => p.eval<boolean>('return (document.querySelector("#conn-status")?.textContent || "").startsWith("connected")'), 'connected', 10_000);
  assert.equal(await p.eval<boolean>('return document.body.classList.contains("view-runs")'), true, 'Runs is the default view');
  return p;
}

async function text(selector: string): Promise<string> {
  assert.ok(page);
  return norm(await page.eval<string>(`return document.querySelector(${JSON.stringify(selector)})?.textContent || ''`));
}

async function expectText(selector: string, expected: string): Promise<void> {
  await waitFor(async () => (await text(selector)) === norm(expected) ? true : null, `text ${expected}`, 10_000);
  assert.equal(await text(selector), norm(expected));
}

async function setViewport(width: number): Promise<void> {
  await page!.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:width===390 });
  await page!.eval<void>('await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
}

async function rendered(selector: string): Promise<void> {
  await waitFor(() => page!.eval<boolean>(`const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;
    e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    const r=e.getBoundingClientRect();let visible=true;
    for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)visible=false;}
    return visible&&r.width>0&&r.height>0&&r.top>=-1&&r.left>=-1&&r.bottom<=innerHeight+1&&r.right<=innerWidth+1;`), `rendered in viewport: ${selector}`, 10_000);
}

async function selectRun(runId:string):Promise<void>{
  const row=`.run-row[data-run-row="${runId}"]`;
  await rendered(row);
  await page!.eval<void>(`document.querySelector(${JSON.stringify(row)}).click()`);
  await waitFor(()=>page!.eval<boolean>(`const e=document.querySelector(${JSON.stringify(selectCard(runId))});
    return !!e?.hasAttribute('data-selected')&&e.getBoundingClientRect().width>0`), 'selected card',10_000);
  assert.equal(await page!.eval<number>('return document.querySelectorAll("#runs .run-card[data-selected]").length'),1,'one selected card');
  assert.equal(await page!.eval<boolean>('return [...document.querySelectorAll("#runs .run-card:not([data-selected])")].every(e=>getComputedStyle(e).display==="none")'),true,'unselected cards retained but hidden');
}

async function startFromMenu(scenario:string):Promise<string>{
  const p=page!;
  await rendered('#scenario-open');
  await p.eval<void>(`if(document.querySelector('#scenario-menu').hidden)document.querySelector('#scenario-open').click()`);
  const button=`#scenario-menu button[data-scenario="${scenario}"]:not(:disabled)`;
  await rendered(button);
  const before=await text('#run-status');
  await p.eval<void>(`document.querySelector(${JSON.stringify(button)}).click()`);
  return waitFor(async()=>{const current=await text('#run-status');return current!==before&&current.startsWith('started ')?current.slice(8).trim():null;},'menu started a new run',10_000);
}

async function checkSummary(mode:'gate'|'shadow', expected:Record<string,number>):Promise<void>{
  for(const [key,value] of Object.entries(expected))await expectText(`#runs-summary [data-count="${key}"]`,String(value));
  const opposite=mode==='gate'?'wouldStop':'stoppedBySilex';
  assert.equal(await page!.eval<boolean>(`return !!document.querySelector('#runs-summary [data-count="${opposite}"]')`),false,'mode-specific summary variant');
  for(const key of ['calls','ran',mode==='gate'?'stoppedBySilex':'wouldStop'])await rendered(`#runs-summary [data-count="${key}"]`);
  for(const key of ['didNotRun','waiting'])assert.equal(await page!.eval<boolean>(`const e=document.querySelector('#runs-summary [data-count="${key}"]');return !!e?.closest('[hidden]')&&e.getBoundingClientRect().width===0`),true,key+' is intentionally hidden');
}

async function reviewVisibility(runId:string):Promise<void>{
  for(const width of [1440,390]){
    await setViewport(width);
    await selectRun(runId);
    for(const selector of [`${selectCard(runId)} .step-waiting [data-review-note]`,'#reviews .lv-rv-note[data-review-note]']){
      await rendered(selector);
      assert.ok((await text(selector)).includes('it does not approve, release or run the action'),'full visible review explanation');
    }
  }
}

async function drawerProbe(step:string):Promise<void>{
  const link=`${step} [data-details="decision"]`;
  await rendered(link);
  await page!.eval<void>(`document.querySelector(${JSON.stringify(link)}).click()`);
  await rendered('#runs-detail');
  assert.equal(await page!.eval<boolean>('return !document.querySelector("#runs-detail").hidden'),true);
  await page!.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await page!.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor(()=>page!.eval<boolean>('return document.querySelector("#runs-detail").hidden'),'Esc closes drawer',10_000);
}

async function freshHarness(mode:'gate'|'shadow',authNone=false):Promise<GateAHarness>{
  assert.ok(stub);
  const judge={backend:'stub' as const,baseUrl:stub.url,model:'stub-latest',expectedRun:'stub',maxRps:100,maxInputTokensPerSec:1_000_000,maxResponseBytes:1_000_000};
  const options={judge,gateJudge:judge,sourceMode:mode==='gate'?'live_sandbox_gate' as const:'live_sandbox_shadow' as const,
    faultInjection:true,worker:{autostart:true,leaseMs:30_000,realtimeTtlMs:60_000}};
  return authNone?harnessFromApp(await createApp({...options,auth:'none',tenants:[...TENANTS],mirrorOtlp:false}),null):startGateAHarness(options);
}

// Expectations are literal plan wording, not computed by the production verdict module.
const EXPECTED: Record<string, string[]> = {
  SOC1: ['read-only · No objection · ran', 'No objection · ran', 'No objection · ran'],
  SOC2: ['read-only · No objection · ran', 'Held for approval · did not run', 'No objection · ran'],
  SOC3: ['read-only · No objection · ran', 'Held for approval · did not run'],
  SOC4: ['read-only · No objection · ran', 'Blocked · did not run'],
  SOC5: ['read-only · No objection · ran', 'No objection · ran', 'No objection · ran', 'No objection · ran'],
  F1: ['read-only · Flagged · ran', 'Held for review · did not run'],
  S5: ['No objection · ran'], S9: ['No objection · ran'],
};

async function hygiene(): Promise<void> {
  const p = page!;
  assert.deepEqual(p.errors, [], 'no console errors or unhandled exceptions');
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await p.eval<void>('await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const width = await p.eval<{scroll:number; inner:number}>('return {scroll:document.documentElement.scrollWidth, inner:window.innerWidth}');
  assert.ok(width.scroll <= width.inner + 1, JSON.stringify(width));
  await p.eval<void>(`document.querySelector('[data-view="engineer"]').click()`);
  assert.equal(await p.eval<boolean>(`return document.body.classList.contains('view-engineer') &&
    ['#stream','#inspector'].every(s=>{const e=document.querySelector(s);return e && e.getBoundingClientRect().width>0 && getComputedStyle(e).visibility!=='hidden'})`), true, 'Engineer toggle reveals stream and inspector');
  await p.eval<void>(`document.querySelector('[data-view="runs"]').click()`);
  assert.equal(await p.eval<boolean>('return document.body.classList.contains("view-runs")'), true);
  assert.deepEqual(p.errors, [], 'toggle and mobile layout are clean');
  await p.send('Emulation.clearDeviceMetricsOverride');
}

async function liveProbe(scenario: string, mode: 'gate'|'shadow'): Promise<string> {
  const h=await freshHarness(mode);
  try {
    const p = await navigate(h.url('/'), h);
    const runId=await startFromMenu(scenario);
    const timeline = await waitFor(async () => {
      const r = await h.json<Timeline>('GET', `/v1/runs/${runId}`);
      return r.response.status === 200 && r.body.timeline.some(x=>x.event.boundary==='run_finished') ? r.body.timeline : null;
    }, 'run finished', 15_000);
    await h.app.worker.drain();
    const calls = timeline.filter(x=>x.event.boundary==='pre_tool');
    const expected = [...EXPECTED[scenario]!];
    if (mode === 'shadow' && scenario === 'SOC2') expected[1] = 'Would hold for approval · ran';
    assert.equal(calls.length, expected.length, 'all calls covered by the oracle');
    await waitFor(()=>p.eval<boolean>(`return !!document.querySelector(${JSON.stringify(selectCard(runId)+'[data-selected]')})`),'newest run auto-selected',10_000);
    await selectRun(runId);
    for (let i=0;i<calls.length;i++) await expectText(`${selectStep(runId,calls[i]!.event.event_id)} .step-verdict`, expected[i]!);
    const steps = await p.eval<number>(`return document.querySelectorAll(${JSON.stringify(selectCard(runId)+' .step[data-tool]')}).length`);
    assert.equal(steps, calls.length, 'one merged line per tool call');
    if (mode === 'gate' && (scenario === 'SOC2' || scenario === 'SOC3')) {
      const note = await waitFor(async () => (await text(`${selectCard(runId)} [data-review-note]`)) || null, 'review note loaded', 10_000);
      assert.match(note, /labels/); assert.match(note, /does not approve, release or run/);
      await reviewVisibility(runId);
    }
    const post=timeline.filter(x=>x.event.boundary==='post_tool');
    const ran=post.filter(x=>x.event.attributes.receipt_status==='executed').length;
    const didNotRun=post.filter(x=>x.event.attributes.receipt_status==='not_executed').length;
    const reviews=await h.json<{reviews:unknown[]}>('GET','/v1/reviews?status=open');
    await checkSummary(mode,{calls:calls.length,ran,didNotRun,waiting:reviews.body.reviews.length,
      [mode==='gate'?'stoppedBySilex':'wouldStop']:scenario==='SOC2'||scenario==='SOC3'||scenario==='SOC4'||scenario==='F1'?1:0});
    if(scenario==='SOC5'){
      for(const call of calls.filter(x=>x.event.operation?.tool==='identity.suspend_user')){
        const selector=`${selectStep(runId,call.event.event_id)} .step-signals`;
        await rendered(selector);
        const value=await text(selector);assert.match(value,/goal_deviation\s+0\.10\b/);
        assert.match(value,/uncalibrated/);assert.match(value,/never block/);
      }
    }
    if (scenario === 'F1') {
      const payment = calls.find(x=>x.event.operation?.tool==='payments.execute')!;
      const decision = (await h.json<Timeline>('GET', `/v1/runs/${runId}`)).body.timeline.find(x=>x.event.event_id===payment.event.event_id)!.decisions.find(d=>!d.replay_of)!;
      assert.equal(decision.decided_by, 'judge_unavailable');
      assert.ok(decision.rule_results.length > 0, 'F1 has actual rule results');
      assert.ok(decision.reasons.some(r=>r.includes('required semantic signal unavailable')), 'F1 records its judge outage reason');
      assert.ok(decision.rule_results.every(r=>r.verdict==='PASS'), 'F1 has no failing rule');
      const why = await text(`${selectStep(runId,payment.event.event_id)} .step-why`);
      for (const reason of decision.reasons) assert.ok(why.includes(norm(reason)), `missing decision reason: ${reason}`);
    }
    if (scenario === 'S5' || scenario === 'S9') {
      const state = scenario==='S5' ? 'unknown_after_deadline' : 'verified_success';
      const payment = calls[0]!.event;
      const selector = `${selectStep(runId,payment.event_id)} .step-outcome`;
      // Payment deadline remains 10s. Expiry is observed on the next scheduled check:
      // at most 2s backoff + 250ms timer tick, with a small browser-delivery margin.
      try {
        await waitFor(() => p.eval<boolean>(`return document.querySelector(${JSON.stringify(selector)})?.dataset.outcomeState===${JSON.stringify(state)}`), `${scenario} business result`, 13_000);
      } catch(error) {
        const checks=await h.db.query(`SELECT state, attempts, next_check_at, deadline_at FROM outcome_checks WHERE tenant_id=$1 AND run_id=$2`, ['t-alpha',runId]);
        throw new Error(`${String(error)}; verifier=${JSON.stringify(checks.rows)}; UI=${await text(selector)}`);
      }
      const check = await h.db.query<{elapsed:number}>(`SELECT EXTRACT(EPOCH FROM (o.created_at-(c.deadline_at-interval '10 seconds')))*1000 AS elapsed FROM outcomes o JOIN outcome_checks c ON c.tenant_id=o.tenant_id AND c.operation_id=o.operation_id WHERE c.tenant_id=$1 AND c.run_id=$2 AND o.state=$3`, ['t-alpha',runId,state]);
      assert.equal(check.rows.length,1);
      const elapsed=Number(check.rows[0]!.elapsed);
      if(scenario==='S9')assert.ok(elapsed<=10_000,'S9 verifies within the payment deadline');
      else {assert.ok(elapsed>=10_000,'S5 only expires after its payment deadline');assert.ok(elapsed<=12_500,'S5 deadline plus backoff and verifier tick');}
      assert.match(await text(selector), scenario==='S5' ? /unknown after deadline/i : /verified/i);
      if (scenario==='S9') {
        const latest=(await h.json<Timeline>('GET',`/v1/runs/${runId}`)).body.timeline;
        const statement=latest.find(x=>x.event.boundary==='post_generation')!;
        const decision=statement.decisions.find(d=>!d.replay_of)!;
        const claimSelector=selectStep(runId,statement.event.event_id);
        const reasons=await text(`${claimSelector} .step-claim-time`);
        assert.match(reasons,/At the time the agent said this:/);
        assert.ok(decision.reasons.some(r=>r.startsWith('authoritative outcomes at claim time:')));
        for(const reason of decision.reasons) assert.ok(reasons.includes(norm(reason)), `claim-time reason retained: ${reason}`);
        assert.match(reasons,/pending/,'claim-time state remains pending after verification');
        const line=await text(`${claimSelector} .step-verdict`);
        assert.equal(line,'No objection'); assert.doesNotMatch(line,/Held|Blocked|did not run|result pending/);
      }
    }
    await setViewport(1440);
    await drawerProbe(selectStep(runId,calls[0]!.event.event_id));
    await hygiene();
    return `${calls.length} merged calls; exact verdicts, scenario-specific checks, clean/mobile/toggle`;
  } finally { await h.close(); }
}

async function sizeProbe():Promise<string>{
  const h=await freshHarness('gate',true);
  try{
    await navigate(h.url('/'),h);await setViewport(1440);
    const ids:string[]=[];
    for(const scenario of ['SOC1','SOC2','SOC3','SOC4','SOC5','S9']){
      const id=await startFromMenu(scenario);ids.push(id);
      await waitFor(async()=> (await h.json<Timeline>('GET',`/v1/runs/${id}`)).body.timeline.some(x=>x.event.boundary==='run_finished'),'run finished',15_000);
      await h.app.worker.drain();
    }
    const latest=ids.at(-1)!;
    await waitFor(()=>page!.eval<boolean>(`return document.querySelector(${JSON.stringify(selectCard(latest))})?.hasAttribute('data-selected')`),'newest auto selected',10_000);
    assert.equal(await page!.eval<number>('return document.querySelectorAll("#runs .run-card").length'),6);
    await checkSummary('gate',{calls:15,stoppedBySilex:3,ran:12,didNotRun:3,waiting:2});
    await page!.eval<void>('document.querySelector("#scenario-menu").hidden=true');
    await setViewport(1440);
    const height=await page!.eval<number>('return document.documentElement.scrollHeight');
    assert.ok(height<=1000,`six-run page height ${height} exceeds 1000`);
    await selectRun(ids[1]!);await reviewVisibility(ids[1]!);await hygiene();
    return `six menu-started runs, newest selected, older selection, review visibility; 1440x900 height=${height}`;
  }finally{await h.close();}
}

// Capture public HTTP requests/responses, never a hook into the renderer.
async function captureRequests():Promise<void>{
  await page!.eval<void>(`window.__probeRequests=[];const original=window.fetch.bind(window);window.fetch=async(input,init)=>{
    const response=await original(input,init);const url=new URL(typeof input==='string'?input:input.url,location.href);
    if((init?.method||'GET').toUpperCase()==='POST'){
      let body=null,reply=null;try{body=JSON.parse(init.body)}catch{}try{reply=await response.clone().json()}catch{}
      window.__probeRequests.push({path:url.pathname,body,reply,status:response.status});
    }return response;};`);
}
type ReplayReply={judge_calls:number;run_id?:string;results:Array<{decision_id:string;error?:string;before?:{recommended:string};after?:{recommended:string;decision_id:string;semantic?:{hits:Array<{question_id:string;value:number;band:string}>}}}>};
type Captured={path:string;body:{kind?:string;run_id?:string;decision_ids?:string[];policy?:{semantic:{bands:Record<string,{review_at:number;risk_option:string|null}>}}};reply:ReplayReply;status:number};
async function captured(kind:string):Promise<Captured>{
  return waitFor(()=>page!.eval<Captured|null>(`return window.__probeRequests.find(x=>x.body?.kind===${JSON.stringify(kind)}||x.path===${JSON.stringify(kind)})||null`),'completed '+kind+' request',20_000);
}
async function requireHook(selector:string):Promise<void>{
  if(!await page!.eval<boolean>(`return !!document.querySelector(${JSON.stringify(selector)})`))throw new SkipProbe('r7 UI not landed: '+selector+' absent');
}
function originals(t:Timeline){return t.timeline.map(x=>({event:x.event,decisions:x.decisions.filter(d=>!d.replay_of)}));}
async function completeRun(h:GateAHarness,scenario:string):Promise<string>{
  const id=await startFromMenu(scenario);
  await waitFor(async()=> (await h.json<Timeline>('GET',`/v1/runs/${id}`)).body.timeline.some(x=>x.event.boundary==='run_finished'),'run finished',15_000);
  await h.app.worker.drain();await selectRun(id);return id;
}
async function recheckProbe():Promise<string>{
  const h=await freshHarness('gate');
  try{
    await navigate(h.url('/'),h);
    const id=await completeRun(h,'SOC2');await requireHook(selectCard(id)+' [data-recheck]');
    const before=(await h.json<Timeline>('GET',`/v1/runs/${id}`)).body;
    const original=originals(before);await captureRequests();const calls=stub!.calls.length;
    const card=selectCard(id);await rendered(card+' [data-recheck]');
    await page!.eval<void>(`document.querySelector(${JSON.stringify(card+' [data-recheck]')}).click()`);
    const response=await captured('model_reeval');assert.equal(response.status,200);
    const successful=response.reply.results.filter(x=>!x.error);
    assert.ok(successful.length>0,'nonvacuous successful re-evaluation');
    // A separate no-question fixture tests the skip branch; hard-rule diagnostic evaluations can make real SOC2 rows eligible.
    assert.equal(response.reply.judge_calls,successful.length,'one-attempt stub call count');
    assert.equal(stub!.calls.length-calls,response.reply.judge_calls,'actual outbound stub calls');
    await expectText(card+' [data-judge-calls]',String(response.reply.judge_calls));
    await waitFor(()=>page!.eval<boolean>(`return document.querySelectorAll(${JSON.stringify(card+' .recheck-row')}).length===${response.reply.results.length}`),'all replay rows',10_000);
    const rows=await page!.eval<Array<{status:string;text:string}>>(`return [...document.querySelectorAll(${JSON.stringify(card+' .recheck-row')})].map(e=>({status:e.dataset.status,text:e.textContent}))`);
    assert.equal(rows.filter(x=>['skipped','error'].includes(x.status)).length,response.reply.results.filter(x=>x.error).length);
    assert.equal(rows.filter(x=>['changed','unchanged'].includes(x.status)).length,successful.length);
    const words:Record<string,string>={NO_CONFIGURED_RISK:'No objection',ALERT:'Flagged',HOLD:'Held',REVIEW:'Held for review',UNKNOWN:'Held for review',BLOCK:'Blocked',STOP:'Blocked'};
    for(let i=0;i<response.reply.results.length;i++){
      const result=response.reply.results[i]!,row=rows[i]!;if(result.error)continue;
      const changed=result.before!.recommended!==result.after!.recommended;
      assert.equal(row.status,changed?'changed':'unchanged');
      const expected=changed?`changed: ${words[result.before!.recommended]??result.before!.recommended} → ${words[result.after!.recommended]??result.after!.recommended}`:`unchanged: ${words[result.before!.recommended]??result.before!.recommended}`;
      assert.ok(norm(row.text).includes(expected),'exact API before/after wording');
    }
    await rendered(card+' [data-audit-note]');assert.match(await text(card+' [data-audit-note]'),/original decisions are unchanged/);
    assert.deepEqual(originals((await h.json<Timeline>('GET',`/v1/runs/${id}`)).body),original);
    await hygiene();return `${successful.length} real one-attempt calls; row wording, count and originals verified`;
  }finally{await h.close();}
}
async function runAgainProbe():Promise<string>{
  const h=await freshHarness('gate',true);
  try{
    await navigate(h.url('/'),h);
    const id=await completeRun(h,'SOC1');await requireHook(selectCard(id)+' [data-run-again]');const card=selectCard(id);
    const original=originals((await h.json<Timeline>('GET',`/v1/runs/${id}`)).body);
    await rendered(card+' [data-run-again-note]');assert.match(await text(card+' [data-run-again-note]'),/allowed sandbox writes happen again/);
    // Reset only this ephemeral harness's ticket to make the repeated sandbox write observable.
    const ticket=original.flatMap(x=>x.event.boundary==='pre_tool'&&x.event.operation?.tool==='ticket.update'?[x.event.operation.args.ticket_id]:[])[0];
    assert.equal(typeof ticket,'string');
    await h.db.query(`UPDATE sandbox.soc_tickets SET status='open',note='R3 repeat-write sentinel' WHERE tenant_id=$1 AND ticket_id=$2`,['t-alpha',ticket]);
    await captureRequests();await page!.eval<void>(`document.querySelector(${JSON.stringify(card+' [data-run-again]')}).click()`);
    const response=await captured('/v1/sandbox/reexec');if(response.status===404)throw new SkipProbe('r7 backend not landed: POST /v1/sandbox/reexec absent');assert.equal(response.status,202,'login-off admin route works');
    const next=response.reply.run_id!;assert.ok(next&&next!==id);
    await waitFor(async()=> (await h.json<Timeline>('GET',`/v1/runs/${next}`)).body.timeline.some(x=>x.event.boundary==='run_finished'),'re-executed run finishes',15_000);
    await h.app.worker.drain();await selectRun(next);
    assert.equal(await page!.eval<number>('return document.querySelectorAll("#runs .run-card").length'),2,'old and new cards retained');
    const state=await h.db.query<{status:string;note:string}>(`SELECT status,note FROM sandbox.soc_tickets WHERE tenant_id=$1 AND ticket_id=$2`,['t-alpha',ticket]);
    assert.equal(state.rows.length,1);assert.notEqual(state.rows[0]!.note,'R3 repeat-write sentinel','new run changed authoritative ticket');assert.notEqual(state.rows[0]!.status,'open');
    assert.deepEqual(originals((await h.json<Timeline>('GET',`/v1/runs/${id}`)).body),original);
    await hygiene();return 'login off: new run/card, unchanged original records, repeated authoritative ticket write';
  }finally{await h.close();}
}
async function whatifProbe():Promise<string>{
  const h=await freshHarness('gate');
  try{
    await navigate(h.url('/'),h);await requireHook('#whatif-open');
    const ids=[await completeRun(h,'SOC1'),await completeRun(h,'SOC2')];
    const timelines=await Promise.all(ids.map(async id=>(await h.json<Timeline>('GET',`/v1/runs/${id}`)).body));
    const before=timelines.map(originals);await captureRequests();const calls=stub!.calls.length;
    await page!.eval<void>('document.querySelector("#whatif-open").click()');await rendered('#whatif [data-whatif-note]');
    assert.match(await text('#whatif [data-whatif-note]'),/never holds or blocks/);
    assert.ok(await page!.eval<number>('return document.querySelectorAll("#whatif input[type=range][data-band]").length')>0);
    await page!.eval<void>(`for(const e of document.querySelectorAll('#whatif input[type=range][data-band]')){e.value=e.dataset.band==='goal_deviation'?'0.05':'0.95';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}`);
    await rendered('#whatif [data-whatif-run]');await page!.eval<void>('document.querySelector("#whatif [data-whatif-run]").click()');
    const response=await captured('policy_only');assert.equal(response.status,200);assert.equal(response.reply.judge_calls,0);
    assert.equal(stub!.calls.length,calls,'zero actual judge calls');
    await waitFor(async()=>/0 judge calls/.test(await text('#whatif [data-whatif-summary]')),'zero-call summary',10_000);
    const bands=response.body.policy!.semantic.bands;assert.equal(bands.goal_deviation!.review_at,0.05);
    const expected=new Map<string,number>();
    const entries=timelines.flatMap(t=>t.timeline);
    for(const entry of entries){if(!['pre_tool','post_generation'].includes(entry.event.boundary))continue;
      const decision=entry.decisions.find(d=>!d.replay_of);if(!decision)continue;
      const ev=entry.evaluations?.find(e=>e.evaluation_id===decision.evaluation_id);
      for(const [qid,signal] of Object.entries(ev?.signals??{})){
        const band=bands[qid];if(!band)continue;
        const value=signal.type==='noul'?signal.raw_probability:band.risk_option&&'probabilities' in signal?signal.probabilities?.[band.risk_option]:null;
        if(typeof value==='number'&&value>=band.review_at)expected.set(entry.event.event_id+'::'+qid,value);
      }
    }
    assert.ok(expected.size>0,'nonempty independently computed flagged set');
    await waitFor(()=>page!.eval<boolean>('return document.querySelectorAll("#whatif .whatif-row").length>0'),'what-if rows',10_000);
    const rows=await page!.eval<Array<{event:string;flagged:string;hits:Array<{question:string;value:number}>;today:Array<{question:string;value:number}>}>>(`return [...document.querySelectorAll('#whatif .whatif-row')].map(e=>({event:e.dataset.eventId,flagged:e.dataset.flagged,hits:[...e.querySelectorAll('td:last-child [data-question][data-value]')].map(h=>({question:h.dataset.question,value:Number(h.dataset.value)})),today:[...e.querySelectorAll('td:nth-child(2) [data-question][data-value]')].map(h=>({question:h.dataset.question,value:Number(h.dataset.value)}))}))`);
    assert.equal(new Set(rows.map(r=>r.event)).size,rows.length,'one row per original event, no replay duplication');
    for(const row of rows){const entry=entries.find(e=>e.event.event_id===row.event);assert.ok(entry,'row is a recorded event');const orig=entry.decisions.find(d=>!d.replay_of)!;const today=orig.semantic.hits.filter(h=>['experimental_review','review'].includes(h.band)).map(h=>({question:h.question_id,value:h.value}));assert.deepEqual(row.today,today,'Today uses the original stored hits');}
    const actual=new Map<string,number>();for(const row of rows){assert.ok(['true','false'].includes(row.flagged));assert.equal(row.flagged==='true',row.hits.length>0);for(const hit of row.hits)actual.set(row.event+'::'+hit.question,hit.value);}
    assert.deepEqual([...actual.keys()].sort(),[...expected.keys()].sort(),'exact flagged event/question set');
    for(const [key,value] of expected)assert.ok(Math.abs(actual.get(key)!-value)<0.006,'displayed signal value matches stored value');
    for(let i=0;i<ids.length;i++)assert.deepEqual(originals((await h.json<Timeline>('GET',`/v1/runs/${ids[i]}`)).body),before[i]);
    assert.deepEqual(page!.errors,[]);await setViewport(390);assert.equal(await page!.eval<boolean>('return document.documentElement.scrollWidth<=innerWidth+1'),true);
    return `${expected.size} independently computed flags; zero actual calls; visible scope label; originals unchanged`;
  }finally{await h.close();}
}

async function serveFixture(): Promise<string> {
  fixtureServer=createServer((req,res)=>{
    const path=new URL(req.url??'/', 'http://localhost').pathname;
    const rel=path==='/tests/probe/runs-fixture.html'?'tests/probe/runs-fixture.html':path.startsWith('/web/')?path.slice(1):null;
    if(!rel || rel.split('/').includes('..')){res.writeHead(404);res.end();return;}
    void readFile(join(ROOT,rel)).then(body=>{res.setHeader('content-type',rel.endsWith('.js')?'text/javascript':rel.endsWith('.css')?'text/css':'text/html');res.end(body);}).catch(()=>{res.writeHead(404);res.end();});
  });
  await new Promise<void>(resolve=>fixtureServer!.listen(0,'127.0.0.1',resolve));
  const address=fixtureServer.address(); assert.ok(address && typeof address==='object');
  return `http://127.0.0.1:${address.port}/tests/probe/runs-fixture.html`;
}

const FIXTURE_GATE: Record<string,string> = {
  failed:'No objection · attempt failed (refused by the tool)',
  invalid:'No objection · did not run', contradiction:'Held for approval · ran',
  readStop:'read-only · Recommended: block (not enforced) · ran',
  readUnknown:'read-only · Recommended: hold for review (not enforced) · ran',
  statement:'Recommended: open an investigation', pending:'No objection · result pending',
  unknown:'Decision: FUTURE_VALUE · ran', evidence:'Held for review · did not run',
  stopped:'Held for approval · did not run',
};
const FIXTURE_SHADOW: Record<string,string> = {alert:'Flagged · ran', review:'Would hold for review · ran', unknownReview:'Would hold for review · ran'};

async function fixtureProbe(url:string,mode:'gate'|'shadow',negative=false,caseId?:string):Promise<string>{
  const p=await navigate(`${url}?mode=${mode}${negative?'&swap-receipts=1':''}`);
  const expected=mode==='gate'?FIXTURE_GATE:FIXTURE_SHADOW;
  await waitFor(()=>p.eval<boolean>('return document.title === "runs fixture ready"'), 'fixture emitted', 10_000);
  if(negative){
    const selector=`${selectStep('run-fixture-stopped','evt-stopped-pre')} .step-verdict`;
    await waitFor(()=>p.eval<boolean>(`return !!document.querySelector(${JSON.stringify(selector)})`),'negative-control stopped line',10_000);
    await selectRun('run-fixture-stopped');
    const value=await text(selector);
    assert.match(value,/ · ran$/, 'receipt swap must actually reach the UI');
    let rejected=false;
    // This oracle is independent of the changed input: the baseline stopped case must never say ran.
    try{assert.doesNotMatch(value,/\bran\b/,'stopped call never reads ran');}catch(e){if(e instanceof assert.AssertionError)rejected=true;else throw e;}
    assert.equal(rejected,true,'negative control must reject the altered receipt');
    await hygiene();return 'NC PASS: unchanged stopped-call oracle rejected swapped receipt';
  }
  await waitFor(()=>p.eval<boolean>(`return document.querySelectorAll('#runs .run-card').length===${Object.keys(expected).length}`),'all cards retained',10_000);
  await checkSummary(mode, mode==='gate'?{calls:9,ran:4,didNotRun:3,waiting:1,stoppedBySilex:2}:{calls:3,ran:3,didNotRun:0,waiting:0,wouldStop:2});
  for(const [id,value] of Object.entries(expected)){
    if(caseId && id!==caseId)continue;
    await selectRun(`run-fixture-${id}`);
    const selector=selectStep(`run-fixture-${id}`,`evt-${id}-${id==='statement'?'say':'pre'}`);
    await expectText(`${selector} .step-verdict`,value);
    const contradiction=await p.eval<boolean>(`return !!document.querySelector(${JSON.stringify(selector+' [data-contradiction="true"]')}) || document.querySelector(${JSON.stringify(selector)})?.dataset.contradiction==='true'`);
    assert.equal(contradiction,id==='invalid'||id==='contradiction',id+' contradiction');
    assert.doesNotMatch(await text(`${selector} .step-verdict`),/⛔/);
    if(contradiction)assert.equal(await p.eval<boolean>(`const e=document.querySelector(${JSON.stringify(selector+' .step-contradiction')});return !!e&&!e.closest('.step-verdict')`),true,'contradiction is outside exact verdict');
    if(id==='stopped')await reviewVisibility(`run-fixture-${id}`);
    if(id==='statement'){
      assert.match(await text(`${selector} .step-claim-time`),/authoritative outcomes at claim time: pending/);
      assert.doesNotMatch(await text(`${selector} .step-verdict`),/result pending|ran/);
    }
    if(id==='evidence')assert.match(await text(`${selector} .step-why`),/missing evidence: authority:invoice/);
  }
  await hygiene(); return `${caseId ?? Object.keys(expected).length} independent fixture expectation(s); clean/mobile/toggle`;
}

async function recheckSkipFixture(url:string):Promise<string>{
  await navigate(url+'?mode=gate');
  await waitFor(()=>page!.eval<boolean>('return document.querySelectorAll("#runs .run-card").length===10'),'fixture cards',10_000);
  const id='run-fixture-stopped',card=selectCard(id);await selectRun(id);await requireHook(card+' [data-recheck]');await captureRequests();
  await page!.eval<void>(`document.querySelector(${JSON.stringify(card+' [data-recheck]')}).click()`);
  const response=await captured('model_reeval');assert.equal(response.reply.results.length,1);assert.equal(response.reply.results[0]!.error,'no_judge_questions_for_this_decision');
  await expectText(card+' [data-judge-calls]','0');await rendered(card+' .recheck-row[data-status="skipped"]');
  assert.match(await text(card+' .recheck-row'),/judge nothing|no judge questions/);await rendered(card+' [data-audit-note]');
  assert.equal(await page!.eval<number>(`return document.querySelectorAll(${JSON.stringify(card+' .recheck-row')}).length`),1);
  await hygiene();return 'no-question HTTP response renders one skipped row and zero calls, with audit note';
}

async function probe(id:string,fn:()=>Promise<string>){
  const only=process.argv.indexOf('--only');
  if(only>=0 && process.argv[only+1]!==id)return;
  let status='PASS',detail='';
  try{detail=await fn();}catch(e){status=e instanceof SkipProbe?'SKIP':'FAIL';detail=e instanceof Error?e.message:String(e);}
  results.push({id,status,detail});console.log(`${status} ${id} — ${detail}`);
}

async function cleanup(){
  page?.ws.close();browser?.ws.close();chrome?.kill();await stub?.close();
  if(fixtureServer){fixtureServer.closeAllConnections();await new Promise<void>(resolve=>fixtureServer!.close(()=>resolve()));}
}

try{
  stub=await startStubJudge();
  for(const id of ['SOC1','SOC2','SOC3','SOC4','SOC5','F1','S5','S9'])await probe(`GATE-${id}`,()=>liveProbe(id,'gate'));
  for(const id of ['SOC2','SOC5'])await probe(`SHADOW-${id}`,()=>liveProbe(id,'shadow'));
  await probe('GATE-SIX-RUN-LAYOUT',sizeProbe);
  await probe('RECHECK',recheckProbe);
  await probe('RUN-AGAIN',runAgainProbe);
  await probe('WHAT-IF',whatifProbe);
  const url=await serveFixture();
  await probe('RECHECK-SKIP-FIXTURE',()=>recheckSkipFixture(url));
  for(const id of Object.keys(FIXTURE_GATE))await probe(`FIXTURE-GATE-${id}`,()=>fixtureProbe(url,'gate',false,id));
  for(const id of Object.keys(FIXTURE_SHADOW))await probe(`FIXTURE-SHADOW-${id}`,()=>fixtureProbe(url,'shadow',false,id));
  await probe('NC',()=>fixtureProbe(url,'gate',true));
}catch(e){results.push({id:'BOOT',status:'FAIL',detail:String(e)});console.log(`FAIL BOOT — ${String(e)}`);}
finally{
  await cleanup();
}
console.log(`\n${results.filter(r=>r.status==='PASS').length} PASS · ${results.filter(r=>r.status==='SKIP').length} SKIP · ${results.filter(r=>r.status==='FAIL').length} FAIL`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
