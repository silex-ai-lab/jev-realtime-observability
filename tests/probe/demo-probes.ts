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
// Domain probes use the public controls; engine imports provide expectations,
// while the pinned verdict table prevents engine/UI agreement from being vacuous.
async function loadDemo(url: string, query: string) {
  const p = await ensureBrowser();
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.send('Page.navigate', { url: url + query });
  await waitFor(() => p.eval<boolean>('return document.readyState==="complete"&&!!window.__jevDemo?.ready'), 'domain ready', 10_000);
  return p;
}
async function domainContents(p: Cdp, domain: 'ap'|'soc') {
  const actual = await p.eval<{tools:string[],rules:string[],questions:string[],agents:string[],inject:string[],replayQuestions:string[],pressed:string[]}>(`return {
    tools:[...document.querySelectorAll('[data-tool-mode]')].map(e=>e.dataset.toolMode),
    rules:[...document.querySelectorAll('#studio-rules [data-rule]')].map(e=>e.dataset.rule),
    questions:[...document.querySelectorAll('#studio-battery [data-question]')].map(e=>e.dataset.question),
    agents:[...document.querySelectorAll('#f-agent option')].map(e=>e.value).filter(Boolean),
    inject:[...document.querySelectorAll('#inject [data-inject]')].map(e=>e.dataset.inject),
    replayQuestions:[...new Set([...document.querySelectorAll('#replay-thr [data-threshold]')].map(e=>e.dataset.threshold.split('.')[0]))],
    pressed:[...document.querySelectorAll('.jv-domain [aria-pressed="true"]')].map(e=>e.dataset.domain)
  }`);
  const expected = await p.eval<typeof actual>(`const {DOMAINS,SHARED_RULES}=await import('./js/engine/domains.js');const {BATTERY}=await import('./js/engine/types.js');const d=DOMAINS[${JSON.stringify(domain)}];return {tools:Object.keys(d.tools),rules:[...d.rules,...SHARED_RULES].map(r=>r[0]),questions:BATTERY.map(q=>q.id),agents:[d.agent],inject:d.inject.map(r=>r[0]),replayQuestions:BATTERY.filter(q=>q.type==='noul'&&d.questions.includes(q.id)).map(q=>q.id),pressed:[d.id]}`);
  for (const key of Object.keys(expected) as Array<keyof typeof actual>) assert.deepEqual([...actual[key]].sort(), [...expected[key]].sort(), domain+' '+key);
  assert.equal(await p.eval<string>('return window.__jevDemo.domain'), domain);
  assert.ok(await p.eval<string>('return document.querySelector("#lede[data-lede]").textContent'));
}
async function domainSwitchProbe(url: string) {
  const p = await loadDemo(url, '?seed=19&autoplay=0&domain=ap');
  for (const [from,to] of [['ap','soc'],['soc','ap']] as const) {
    await domainContents(p, from);
    await p.eval<void>(`document.querySelector('[data-tab="studio"]').click();const e=document.querySelector('[data-tool-mode]');e.value='monitor';e.dispatchEvent(new Event('change',{bubbles:true}));`);
    assert.ok(await p.eval<boolean>('return Object.values(window.__jevDemo.policy().tools).some(t=>t.mode==="monitor")'), 'Studio edit applied before reload');
    await p.eval<void>(`document.querySelector('.jv-domain [data-domain="${to}"]').click()`);
    await waitFor(() => p.eval<boolean>(`return window.__jevDemo?.ready&&window.__jevDemo.domain==='${to}'`), 'switched domain', 10_000);
    assert.deepEqual(await p.eval<string[]>('const q=new URLSearchParams(location.search);return [q.get("seed"),q.get("autoplay"),q.get("domain")]'), ['19','0',to]);
    await domainContents(p, to);
    assert.equal(await p.eval<number>('return window.__jevDemo.log().length'), 0, 'old session cleared');
    assert.equal(await p.eval<boolean>('return Object.values(window.__jevDemo.policy().tools).every(t=>t.mode==="gate")'), true, 'Studio edit reset');
    await p.eval<void>('window.__jevDemo.flush();document.querySelector("[data-tab=replay]").click()');
    assert.ok(await p.eval<number>('return window.__jevDemo.log().length')>0,'flushed stream is nonempty');
    assert.ok(await p.eval<number>('return document.querySelectorAll("#replay-span option").length')>0,'Replay is nonempty');
    await waitFor(()=>p.eval<boolean>('return document.querySelectorAll(".run-card").length>0'),'flushed run cards',10_000);
    assert.equal(await p.eval<boolean>(`return window.__jevDemo.log().every(e=>e.agent==='${to}-agent')&&[...document.querySelectorAll('.run-card')].every(e=>e.dataset.runId.startsWith('${to==='soc'?'T-S':'T-'}'))`),true,'stream contains chosen agent only');
    assert.equal(await p.eval<boolean>(`return [...document.querySelectorAll('#replay-span option')].every(e=>${to==='soc'?"e.value.startsWith('T-SOC')||e.value.startsWith('T-SB')":"!e.value.startsWith('T-SOC')&&!e.value.startsWith('T-SB')"})`),true,'Replay contains chosen domain only');
    assert.deepEqual(p.errors, []);
  }
  await loadDemo(url, '?domain=unknown&autoplay=0');await domainContents(p,'ap');
  return 'bidirectional reload after Studio edits; query preservation, isolated sessions/tools/agents/Replay, unknown falls back to AP';
}
async function socProbe(url:string,id:string) {
  const p=await loadDemo(url,'?domain=soc&seed=7&autoplay=0');
  await domainContents(p,'soc');
  await p.eval<void>(`document.querySelector('#inject [data-inject="${id}"]').click()`);
  await waitFor(()=>p.eval<boolean>(`return !!document.querySelector('.run-card[data-scenario="${id}"] .step-verdict')`),'SOC card',10_000);
  const data=await p.eval<{calls:Array<{span_id:string,decision:string,decided_by:string,reasons:string[],tool:{name:string}}>,expected:unknown[],actual:unknown[]}>(`const {scenarioById,TENANT}=await import('./js/engine/scenarios.js');const {runStream}=await import('./js/engine/router.js');
    const spans=scenarioById('${id}').spans.map((s,i)=>({...structuredClone(s),trace_id:s.trace_id+'~i1',span_id:s.span_id+'~i1',parent_span_id:s.parent_span_id?s.parent_span_id+'~i1':null,t_ms:i*40}));
    const expected=runStream(spans,{tenant:TENANT,policy:window.__jevDemo.policy(),seed:7});
    const actual=window.__jevDemo.log();const tuple=e=>[e.span_id,e.decision,e.action,e.decided_by,e.reasons,e.alert,e.rule_hits.map(h=>h.id)];
    return {calls:actual.filter(e=>e.boundary==='pre_tool'),expected:expected.map(tuple),actual:actual.map(tuple)};`);
  assert.deepEqual(data.actual,data.expected,'independently rerouted scenario envelopes');
  const table:Record<string,string[][]>={
    SOC1:[['siem.search','ALLOW','policy'],['firewall.block_ip','ALLOW','policy'],['ticket.update','ALLOW','policy']],
    SOC2:[['siem.search','ALLOW','policy'],['firewall.allowlist_ip','HOLD','rule'],['ticket.update','ALLOW','policy']],
    SOC3:[['siem.search','ALLOW','policy'],['identity.suspend_user','HOLD','rule']],
    SOC4:[['siem.search','ALLOW','policy'],['webhook.post','BLOCK','rule']],
    SOC5:[['siem.search','ALLOW','policy'],['identity.suspend_user','ALLOW','policy'],['identity.suspend_user','REVIEW','jev'],['identity.suspend_user','REVIEW','jev']]
  };
  assert.deepEqual(data.calls.map(e=>[e.tool.name,e.decision,e.decided_by]),table[id],'pinned plan outcomes');
  await p.eval<void>(`document.querySelector('.run-row[data-run-row="T-${id}~i1"]').click()`);
  for(const call of data.calls){
    const text=await p.eval<{verdict:string,why:string}>(`const e=document.querySelector('.run-card[data-selected] .step[data-event-id="${call.span_id}"]');return {verdict:e?.querySelector('.step-verdict')?.textContent.trim()||'',why:e?.querySelector('.step-why')?.textContent||''}`);
    const line=call.decision==='ALLOW'?'No objection · ran':call.decision==='BLOCK'?'Blocked · did not run':call.decision==='HOLD'?'Held for approval · did not run':'Held for review · did not run';
    assert.equal(text.verdict,(call.tool.name==='siem.search'?'read-only · ':'')+line,call.span_id);for(const reason of call.reasons)assert.ok(text.why.includes(reason),'reason visible '+call.span_id);
  }
  assert.equal(await p.eval<boolean>('return [...document.querySelectorAll(".run-card")].every(e=>[...e.querySelectorAll(".tag")].some(t=>/simulated/i.test(t.textContent)))'),true);
  assert.equal(await p.eval<number>('return document.querySelectorAll(".run-card .step-signals").length'),0);
  const lede=await p.eval<string>('return document.querySelector("#lede").textContent');assert.match(lede,/live console.*uncalibrated/);assert.match(lede,/synthetic scores.*threshold policy/);
  if(id==='SOC2'){
    await p.eval<void>(`document.querySelector('[data-tab="replay"]').click();const s=document.querySelector('#replay-span');s.value='${data.calls[1].span_id}';s.dispatchEvent(new Event('change'));for(const e of document.querySelectorAll('#replay-thr [data-threshold]')){e.value=e.dataset.threshold.endsWith('review_threshold')?'0':'0.01';e.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('[data-replay-run]').click();`);
    assert.deepEqual(await p.eval<string[]>('return [document.querySelector("#replay-before").dataset.decision,document.querySelector("#replay-after").dataset.decision]'),['HOLD','HOLD']);
    assert.match(await p.eval<string>('return document.querySelector("#replay-note").textContent'),/no threshold reaches this decision/);
  }
  for(const tab of ['live','replay','studio','about'])for(const width of [1440,390]){
    await p.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
    await p.eval<void>(`document.querySelector('[data-tab="${tab}"]').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
    assert.equal(await p.eval<boolean>('return document.documentElement.scrollWidth<=innerWidth+1'),true,`${id} ${tab} ${width}px overflow`);
  }
  assert.match(await p.eval<string>('return document.querySelector("[data-panel=about]").textContent'),/synthetic scores.*threshold policy/i);
  assert.deepEqual(p.errors,[]);return 'button injection, independent envelopes and pinned verdicts/reasons, simulated tags and caveat; all tabs at 1440/390px'+(id==='SOC2'?'; hard-rule Replay invariant':'');
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
  await probe('DEMO-DOMAIN-SWITCH',()=>domainSwitchProbe(h!.url('/demo/index.html')));
  for(const id of ['SOC1','SOC2','SOC3','SOC4','SOC5'])await probe('DEMO-'+id,()=>socProbe(h!.url('/demo/index.html'),id));
}catch(e){const status=e instanceof SkipProbe?'SKIP':'FAIL';results.push({id:'BOOT',status,detail:String(e)});console.log(`${status} BOOT — ${String(e)}`);}
finally{await cleanupBrowser();await h?.close();}
console.log(`\n${results.filter(r=>r.status==='PASS').length} PASS · ${results.filter(r=>r.status==='SKIP').length} SKIP · ${results.filter(r=>r.status==='FAIL').length} FAIL`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
