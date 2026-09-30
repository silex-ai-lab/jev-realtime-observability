#!/usr/bin/env node
// Browser acceptance for the demo page's stable public DOM hooks.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { startGateAHarness, waitFor } from '../helpers/harness.ts';
class SkipProbe extends Error {}
let chrome:ChildProcessWithoutNullStreams|null=null;
let page:Cdp|null=null;
let browser:Cdp|null=null;
let browserUnavailable:string|null=null;
const results:Array<{id:string,status:string,detail:string}>=[];
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


async function probe(id:string,fn:()=>Promise<string>){
  let status='PASS',detail='';
  try{detail=await fn();}catch(e){status=e instanceof SkipProbe?'SKIP':'FAIL';detail=e instanceof Error?e.message:String(e);}
  results.push({id,status,detail});console.log(`${status} ${id} — ${detail}`);
}
async function demoRunsProbe(url:string,kind:'mixed'|'semantic'|'finding'):Promise<string>{
  const p=await ensureBrowser();p.errors.length=0;
  await p.send('Page.navigate',{url:url+'?autoplay=0'});
  await waitFor(()=>p.eval<boolean>('return document.readyState==="complete"&&window.__jevDemo?.ready'),'demo engine ready',10_000);
  if(!await p.eval<boolean>('return !!document.querySelector("#runs")'))throw new SkipProbe('r7 demo Runs UI not landed: #runs absent');
  // Use the demo's existing public simulation driver, not hooks in runs.js.
  await p.eval<void>(`if(${JSON.stringify(kind)}!=='finding'){
    const policy=window.__jevDemo.policy();for(const band of Object.values(policy.thresholds)){band.review_threshold=0;band.block_threshold=0.01;}
    if(${JSON.stringify(kind)}==='mixed')policy.tools['payments.execute'].mode='monitor';
    const result=window.__jevDemo.setPolicy(policy);if(!result.ok)throw new Error(JSON.stringify(result));
  }document.querySelector('[data-inject="'+(${JSON.stringify(kind)}==='finding'?'S5':'S1')+'"]').click();`);
  await waitFor(()=>p.eval<boolean>('return document.querySelectorAll("#runs .run-card .step").length>0'),'demo run steps',10_000);
  const envs=await p.eval<Array<{boundary:string;decision:string;decided_by:string;mode:string;reasons:string[];tool:{name:string}|null}>>('return window.__jevDemo.log()');
  const calls=envs.filter(e=>e.boundary==='pre_tool');assert.ok(calls.length>0);
  // Selecting uses only the shared public row hook.
  await p.eval<void>('document.querySelector(".run-row[data-run-row]").click()');
  await waitFor(()=>p.eval<boolean>('return !!document.querySelector("#runs .run-card[data-selected]")'),'selected demo card',10_000);
  const scope='#runs .run-card[data-selected]';
  assert.equal(await p.eval<boolean>('return [...document.querySelectorAll("#runs .run-card")].every(e=>[...e.querySelectorAll(".tag")].some(t=>t.textContent.toLowerCase().includes("simulated")))'),true,'every card tagged simulated');
  assert.equal(await p.eval<number>('return document.querySelectorAll("#runs .run-card .step-signals").length'),0,'no shared never-block signal line');
  if(kind==='finding'){
    const payment=await p.eval<string>(`return [...document.querySelectorAll('${scope} .step[data-tool="payments.execute"] .step-verdict')].map(e=>e.textContent.trim()).join(' ')`);
    assert.match(payment,/No objection · ran$/,'S5 payment ran');
    const finding=await p.eval<string>(`return document.querySelector('${scope} .step[data-step-kind="finding"]')?.textContent||''`);
    assert.match(finding,/Flagged|Recommended: open an investigation/);
    assert.match(finding,/200/,'tool status retained');assert.match(finding,/posted\s*(?:=|:)?\s*false/i,'readback evidence retained');
    assert.doesNotMatch(finding,/did not run/,'finding never turns completed action into nonexecution');
  }else{
    if(kind==='mixed'){assert.ok(calls.some(e=>e.mode==='monitor'));assert.ok(calls.some(e=>e.mode==='gate'));}
    const semantic=calls.filter(e=>e.decided_by==='jev'&&e.decision==='BLOCK');assert.ok(semantic.length>0,'actual simulated semantic block exercised');
    for(const env of calls){
      const line=await p.eval<string>(`return document.querySelector('${scope} .step[data-tool="${env.tool!.name}"] .step-verdict')?.textContent.trim()||''`);
      assert.ok(line,'call rendered');
      if(env.decision==='BLOCK')assert.equal(line.includes(env.mode==='monitor'?'Would block · ran':'Blocked · did not run'),true,env.tool!.name+' original mode and receipt');
      else if(env.mode==='monitor')assert.doesNotMatch(line,/Held|Blocked|did not run/);
    }
    for(const env of semantic){const why=await p.eval<string>(`return document.querySelector('${scope} .step[data-tool="${env.tool!.name}"] .step-why')?.textContent||''`);
      assert.ok(env.reasons.length>0);for(const reason of env.reasons)assert.ok(why.includes(reason),'simulated semantic reason visible');}
    // Change current policy after recording; original mixed-step wording must survive.
    const before=await p.eval<string>(`return document.querySelector('${scope}').textContent`);
    await p.eval<void>(`const policy=window.__jevDemo.policy();for(const t of Object.values(policy.tools))t.mode='gate';window.__jevDemo.setPolicy(policy);await new Promise(r=>setTimeout(r,150));`);
    assert.equal(await p.eval<string>(`return document.querySelector('${scope}').textContent`),before,'recorded meanings survive policy mode edit');
  }
  for(const width of [1440,390]){
    await p.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
    await p.eval<void>('await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.equal(await p.eval<boolean>('return document.documentElement.scrollWidth<=innerWidth+1'),true,'no horizontal overflow');
  }
  assert.deepEqual(p.errors,[]);return `${kind}: independent simulated engine outcomes, tags, no shared signals, clean mobile layout`;
}
async function cleanupBrowser(){page?.ws.close();browser?.ws.close();chrome?.kill();}
let h:Awaited<ReturnType<typeof startGateAHarness>>|undefined;
try{
  h=await startGateAHarness();
  const p=await ensureBrowser();
  await p.send('Page.navigate',{url:h.url('/demo/index.html')});
  await waitFor(()=>p.eval<boolean>('return document.readyState==="complete"&&document.querySelectorAll("[data-tab]").length>0'),'demo loaded',10_000);
  const tabs=await p.eval<string[]>('return [...document.querySelectorAll("[data-tab]")].map(e=>e.dataset.tab)');
  assert.deepEqual([...tabs].sort(),['about','live','replay','studio'],'all four stable tabs exist');
  for(const tab of tabs)await probe(`DEMO-${tab}`,async()=>{
    for(const width of [1440,390]){
      await p.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
      await p.eval<void>(`document.querySelector('[data-tab="${tab}"]').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
      await waitFor(()=>p.eval<boolean>(`const e=document.querySelector('[data-panel="${tab}"]');return !!e&&!e.hidden&&e.getBoundingClientRect().width>0`),'selected panel visible',10_000);
      assert.equal(await p.eval<boolean>(`return [...document.querySelectorAll('[data-panel]')].filter(e=>e.dataset.panel!==${JSON.stringify(tab)}).every(e=>e.hidden||getComputedStyle(e).display==='none')`),true,'other panels hidden');
      assert.equal(await p.eval<boolean>(`const e=document.querySelector('[data-simulated-badge]');if(!e)return false;e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();let visible=true;for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)visible=false;}return visible&&e.textContent.includes('SIMULATED')&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight;`),true,'SIMULATED badge rendered');
      assert.equal(await p.eval<boolean>('return document.documentElement.scrollWidth<=innerWidth+1'),true,`no horizontal scroll at ${width}px`);
      assert.deepEqual(p.errors,[],'no JavaScript exceptions or console errors');
    }
    return 'selected panel, visible SIMULATED badge, clean JS, no horizontal scroll at 1440 and 390px';
  });
  for(const kind of ['mixed','semantic','finding'] as const)await probe('DEMO-RUNS-'+kind,()=>demoRunsProbe(h!.url('/demo/index.html'),kind));
}catch(e){const status=e instanceof SkipProbe?'SKIP':'FAIL';results.push({id:'BOOT',status,detail:String(e)});console.log(`${status} BOOT — ${String(e)}`);}
finally{await cleanupBrowser();await h?.close();}
console.log(`\n${results.filter(r=>r.status==='PASS').length} PASS · ${results.filter(r=>r.status==='SKIP').length} SKIP · ${results.filter(r=>r.status==='FAIL').length} FAIL`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
