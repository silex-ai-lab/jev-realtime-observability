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
    // Argument titles only exist after the adapter's async run-detail fetch has rendered.
    // Wait for the actual DOM state before BOTH snapshots; a sleep alone races the fetch.
    const detailRendered = () => p.eval<boolean>(`const calls=[...document.querySelectorAll('${scope} .step-call[title]')];return calls.length>0&&calls.every(e=>e.getAttribute('title').length>0);`);
    await waitFor(detailRendered,'run detail rendered before policy edit',10_000);
    const before=await p.eval<string>(`return document.querySelector('${scope}').textContent`);
    await p.eval<void>(`const policy=window.__jevDemo.policy();for(const t of Object.values(policy.tools))t.mode='gate';window.__jevDemo.setPolicy(policy);await new Promise(r=>setTimeout(r,150));`);
    await waitFor(detailRendered,'run detail rendered after policy edit',10_000);
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
  for(const tab of ['live','replay','studio','learning','about'])for(const width of [1440,390]){
    await p.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
    await p.eval<void>(`document.querySelector('[data-tab="${tab}"]').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
    assert.equal(await p.eval<boolean>('return document.documentElement.scrollWidth<=innerWidth+1'),true,`${id} ${tab} ${width}px overflow`);
  }
  assert.match(await p.eval<string>('return document.querySelector("[data-panel=about]").textContent'),/synthetic scores.*threshold policy/i);
  assert.deepEqual(p.errors,[]);return 'button injection, independent envelopes and pinned verdicts/reasons, simulated tags and caveat; all tabs at 1440/390px'+(id==='SOC2'?'; hard-rule Replay invariant':'');
}
async function hostOptionsProbe(url:string,kind:'embed'|'back') {
  const p=await ensureBrowser();p.errors.length=0;
  const visible=(sel:string)=>`const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'`;
  if(kind==='embed'){
    await loadDemo(url,'?embed=1&domain=ap&autoplay=0&seed=11');
    for(const domain of ['ap','soc']){
      if(domain==='soc'){await p.eval<void>('document.querySelector("[data-domain=soc]").click()');await waitFor(()=>p.eval<boolean>('return window.__jevDemo?.domain==="soc"&&window.__jevDemo.ready'),'embedded SOC ready',10_000);}
      assert.equal(await p.eval<boolean>('return document.body.classList.contains("embed")'),true);
      for(const sel of ['.jv-brand','.jv-back'])assert.equal(await p.eval<boolean>(visible(sel)),false,sel+' hidden');
      for(const sel of ['[data-simulated-badge]','.jv-domain','.jv-tabs'])assert.equal(await p.eval<boolean>(visible(sel)),true,sel+' visible');
      assert.deepEqual(await p.eval<string[]>('const q=new URLSearchParams(location.search);return [q.get("embed"),q.get("seed"),q.get("autoplay")]'),['1','11','0']);
    }
    await loadDemo(url,'?autoplay=0');
    for(const sel of ['.jv-brand','.jv-back'])assert.equal(await p.eval<boolean>(visible(sel)),true,'default '+sel+' visible');
  }else{
    const valid='../../index.html#view=long-term&tab=runtime';
    await loadDemo(url,'?autoplay=0&back='+encodeURIComponent(valid));
    assert.deepEqual(await p.eval<string[]>('const a=document.querySelector(".jv-back");return [a.getAttribute("href"),a.textContent.trim()]'),[valid,'← Back']);
    for(const value of ['javascript:alert(1)','jav%61script:alert(1)','//evil.example','%2F%2Fevil.example','https://evil.example','', '../\\evil.example']){
      await loadDemo(url,'?autoplay=0&back='+encodeURIComponent(value));
      assert.deepEqual(await p.eval<string[]>('const a=document.querySelector(".jv-back");return [a.getAttribute("href"),a.textContent.trim()]'),['../index.html','← Live console'],value+' rejected');
    }
    for(const raw of ['jav%61script:alert(1)','%2F%2Fevil.example']){
      await loadDemo(url,'?autoplay=0&back='+raw);
      assert.equal(await p.eval<string>('return document.querySelector(".jv-back").getAttribute("href")'),'../index.html','URL-decoded invalid value rejected');
    }
  }
  assert.deepEqual(p.errors,[]);return kind==='embed'?'embedded brand/back hidden; badge, switch, tabs visible; options survive switch; default unchanged':'relative Back accepted; scheme, encoded scheme, protocol-relative, absolute, empty and malformed values ignored';
}

// Learning probes activate visible controls; state hooks are read-only snapshots.
async function clickDemo(p:Cdp, selector:string) {
  const at=await p.eval<{x:number;y:number}>(`const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=e.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;if(!b.width||!b.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Not hit-testable '+${JSON.stringify(selector)});return {x,y};`);
  for(const type of ['mouseMoved','mousePressed','mouseReleased'])await p.send('Input.dispatchMouseEvent',{type,...at,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
}
async function learningReady(url:string,domain:string) {
  const p=await ensureBrowser();p.errors.length=0;
  await loadDemo(url,`?domain=${domain}&tab=learning&autoplay=0&seed=7`);
  await waitFor(()=>p.eval<boolean>('return !!window.__jevDemo?.learning&&document.querySelector("[data-panel=learning]").hidden===false'),'Learning deep link',10_000);
  return p;
}
async function fillLearning(p:Cdp) {
  await clickDemo(p,'[data-learn-load]');await clickDemo(p,'[data-learn-auto]');
  assert.equal(await p.eval<boolean>('const s=__jevDemo.learning.state();return s.N>0&&s.count===s.N&&s.labelCount===s.N'),true,'computed complete batch');
}
async function trainAndGate(p:Cdp) {
  await clickDemo(p,'[data-learn-train]');
  await waitFor(()=>p.eval<boolean>('return __jevDemo.learning.state().phase==="trained"'),'frozen trained candidate',10_000);
  await clickDemo(p,'[data-learn-gate]');
}
async function learningWorkflow(url:string,domain:string) {
  const p=await learningReady(url,domain);
  assert.equal(await p.eval<boolean>('return document.querySelector("[data-learn-train]").disabled'),true,'Train starts disabled');
  const scenario=domain==='ap'?'S4':'SOC2';
  await p.eval<void>(`__jevDemo.inject('${scenario}')`);
  assert.equal(await p.eval<boolean>('const s=__jevDemo.learning.state();return s.examples.some(e=>!e.curriculum&&["HOLD","REVIEW"].includes(e.env.decision))&&s.count===0'),true,'inbox includes Live hold, no invented labels');
  await fillLearning(p);
  const N=await p.eval<number>('return __jevDemo.learning.state().N');
  await clickDemo(p,'[data-learn-load]');await clickDemo(p,'[data-learn-auto]');
  assert.equal(await p.eval<number>('return __jevDemo.learning.state().count'),N,'load/reanswer deduplicates');
  assert.ok(await p.eval<boolean>('return [...document.querySelectorAll("[data-learn-label]")].some(e=>e.textContent.includes("scripted demo-author"))'));
  const beforeLive=await p.eval<string>('return JSON.stringify(__jevDemo.log())');
  await trainAndGate(p);
  const s=await p.eval<any>('return __jevDemo.learning.state()'),g=s.candidate.gate;
  assert.equal(g.pass,true);assert.equal(g.valid,true);
  for(const side of ['before','after']) {
    const eligible=g.pairs.filter((p:any)=>p.before.boundary==='pre_tool'&&p.after.boundary==='pre_tool'&&p.before.jev_status==='ok'&&p.after.jev_status==='ok'&&!p.before.fallback&&!p.after.fallback&&['jev','policy'].includes(p.before.decided_by)&&['jev','policy'].includes(p.after.decided_by)&&p.before.mode==='gate'&&p.after.mode==='gate');
    const attacks=eligible.filter((p:any)=>p.kind==='attack'),benign=eligible.filter((p:any)=>p.kind==='benign');
    const missed=attacks.filter((p:any)=>p[side].action==='allow').length;
    const falseHolds=benign.filter((p:any)=>['hold_for_review','hold_for_approval','deny','stop_and_handover'].includes(p[side].action)).length;
    const review=eligible.filter((p:any)=>p[side].action==='hold_for_review').length;
    assert.deepEqual(g[side],{missed,attacks:attacks.length,missedRate:missed/attacks.length,falseHolds,benign:benign.length,falseHoldRate:falseHolds/benign.length,review,total:eligible.length,reviewRate:review/eligible.length});
  }
  for(const pair of g.pairs){
    if(pair.control){assert.equal(pair.before.action,pair.after.action);assert.equal(pair.correctControl,true);assert.equal(pair.eligible,false);}
    assert.deepEqual(pair.before.answers.attack,pair.after.answers.attack);assert.deepEqual(pair.before.answers.impact,pair.after.answers.impact);
    for(const [qid,a] of Object.entries(pair.after.answers) as [string,any][]){if(a.type==='noul'){assert.equal(a.risk,qid==='grounded'?Math.round((1-a.p)*1000)/1000:a.p);assert.equal(a.confidence,Math.round(Math.max(a.p,1-a.p)*1000)/1000);}}
  }
  assert.equal(g.before.total,g.pairs.filter((p:any)=>p.eligible).length,'safe ALLOW results stay in denominators');
  assert.ok(g.pairs.length>=10&&g.pairs.length<=12);
  assert.ok(g.after.missed<g.before.missed,'strictly fewer missed attacks');
  assert.ok(g.after.review<g.before.review,'strictly fewer actions sent to a person');
  assert.ok(g.after.falseHolds<g.before.falseHolds,'strictly fewer false holds');
  assert.ok(g.pairs.some((p:any)=>p.eligible&&(p.kind==='attack'?p.after.action==='allow':p.after.action!=='allow')),'v2 still makes an error');
  const outcome=await p.eval<string>('return document.querySelector("[data-learn-outcome]").textContent');
  assert.equal(outcome,`After ${s.candidate.snapshot.labels.length} reviewer answers, simulated on ${g.pairs.length} unseen authored actions: missed attacks ${g.before.missed}/${g.before.attacks} → ${g.after.missed}/${g.after.attacks} · sent to a person ${g.before.review}/${g.before.total} → ${g.after.review}/${g.after.total} · false holds ${g.before.falseHolds}/${g.before.benign} → ${g.after.falseHolds}/${g.after.benign}`);
  const barWidths=await p.eval<number[]>('return [...document.querySelectorAll(".learn-tiles .learn-bar")].map(e=>parseFloat(e.style.width))');
  const expectedBars=[g.before.missedRate,g.after.missedRate,g.before.reviewRate,g.after.reviewRate,g.before.falseHoldRate,g.after.falseHoldRate].map(n=>n*100);
  barWidths.forEach((n,i)=>assert.ok(Math.abs(n-expectedBars[i])<0.001,'CSS bar matches computed rate within browser serialization precision'));
  assert.equal(await p.eval<boolean>('const box=document.querySelector("#learn-comparison");const cards=[...box.querySelectorAll("[data-learn-pair]")];const collapsed=box.querySelector("[data-learn-unchanged]");return !!collapsed&&!collapsed.open&&cards.some(e=>e.dataset.changed==="true")&&cards.every(e=>e.dataset.changed==="true"?!e.closest("[data-learn-unchanged]"):!!e.closest("[data-learn-unchanged]"));'),true,'changed first; unchanged collapsed');
  assert.deepEqual(await p.eval<string[]>('return [...document.querySelectorAll(".learn-stages button span")].map(e=>e.textContent)'),[`${s.examples.length} actions`,`${s.drafts.length} answers`,`${s.labelCount} labels`,`${Object.keys(s.candidate.snapshot.model.families).length} families`,`${g.pairs.length} variants`,'not yet']);
  assert.equal(await p.eval<boolean>(`const {curriculumFor}=await import('./js/learning/curriculum.js');const {compareCases}=await import('./js/learning/session.js');const s=__jevDemo.learning.state().candidate.snapshot,c=curriculumFor('${domain}');const before=compareCases(c.test,s,s.model).map(p=>p.after);c.test.forEach(e=>{for(const q of Object.keys(e.truth))e.truth[q]=!e.truth[q];e.kind=e.kind==='attack'?'benign':'attack';});return JSON.stringify(before)===JSON.stringify(compareCases(c.test,s,s.model).map(p=>p.after));`),true,'scores independent of heldout truth');
  await clickDemo(p,'[data-learn-promote]');
  assert.equal(await p.eval<string>('return __jevDemo.learning.state().phase'),'promoted');
  assert.equal(await p.eval<string>('return JSON.stringify(__jevDemo.log())'),beforeLive,'promotion leaves Live untouched');
  assert.ok(await p.eval<boolean>('return document.querySelector("#learning-workflow").textContent.includes("simulated logistic correction")'));
  await clickDemo(p,'[data-learn-reset]');
  assert.equal(await p.eval<number>('return __jevDemo.learning.state().count'),0);assert.equal(await p.eval<boolean>('return __jevDemo.learning.state().candidate===null'),true);
  await fillLearning(p);await clickDemo(p,'[data-learn-failed]');await trainAndGate(p);
  assert.equal(await p.eval<boolean>('return __jevDemo.learning.state().candidate.gate.pass'),false);
  assert.equal(await p.eval<boolean>('return document.querySelector("[data-learn-promote]").disabled'),true);
  assert.match(await p.eval<string>('return document.querySelector("[data-learn-gate-result]").textContent'),/Rejected/);
  for(const width of [1440,390]){await p.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});assert.equal(await p.eval<boolean>('return document.documentElement.scrollWidth<=innerWidth+1'),true,'Learning overflow');}
  assert.deepEqual(p.errors,[]);return 'Live holds + authored curriculum, computed N/deduped labels, actual trained pass and corrupted rejection, independent metrics, no truth oracle, unchanged controls/choice/score/Live, scoped promotion, reset and 1440/390px';
}
async function learningLifecycle(url:string,domain:string) {
  const p=await learningReady(url,domain);await fillLearning(p);await trainAndGate(p);
  // Editing a visible answer removes its committed label and invalidates the candidate until a new Train.
  await clickDemo(p,'#learn-review details summary');
  await p.eval<void>('const e=document.querySelector("[data-learn-example][data-learn-example^=learn-] [data-learn-answer]");e.focus();e.value=e.value==="true"?"false":"true";e.dispatchEvent(new Event("change",{bubbles:true}));');
  assert.equal(await p.eval<boolean>('const s=__jevDemo.learning.state();return s.candidate===null&&s.count===s.N-1&&document.querySelector("[data-learn-promote]").disabled'),true,'answer invalidates approval');
  assert.equal(await p.eval<boolean>('return document.activeElement.matches("[data-learn-answer]")'),true,'answer redraw preserves keyboard focus');
  await clickDemo(p,'[data-learn-example][data-learn-example^=learn-] [data-learn-submit="Deny"]');
  assert.equal(await p.eval<boolean>('const s=__jevDemo.learning.state();return s.count===s.N&&s.labels.some(l=>l.source==="manual simulated reviewer")'),true);
  await clickDemo(p,'[data-learn-reset]');await fillLearning(p);await trainAndGate(p);
  await p.eval<void>('const policy=__jevDemo.policy();policy.version="learning-test-policy";__jevDemo.setPolicy(policy);');
  assert.equal(await p.eval<boolean>('return __jevDemo.learning.state().candidate===null&&document.querySelector("[data-learn-promote]").disabled'),true,'policy invalidates approval');
  await clickDemo(p,'[data-learn-train]');await clickDemo(p,'[data-learn-reset]');
  await new Promise(r=>setTimeout(r,650));assert.equal(await p.eval<boolean>('const s=__jevDemo.learning.state();return s.phase==="review"&&s.candidate===null&&s.count===0'),true,'stale training callback cannot resurrect reset');
  assert.deepEqual(p.errors,[]);return 'manual-label distinction, answer edit/new Train, policy invalidation, and reset while animation is pending';
}
async function learningPresenter(url:string,domain:string) {
  const p=await learningReady(url,domain);
  assert.equal(await p.eval<string>('return document.querySelector("[data-learn-outcome]").textContent'),'Answer the review examples to see what changes');
  await clickDemo(p,'[data-learn-play]');
  for(let stage=0;stage<6;stage++) {
    await waitFor(()=>p.eval<boolean>(`return document.querySelector('[data-learn-stage="${stage}"]').getAttribute('aria-current')==='step';`),'presenter stage '+stage,10_000);
    assert.equal(await p.eval<boolean>('return [...document.querySelectorAll("#learning-workflow button:not([data-learn-reset]), #learning-workflow select, #learning-workflow input")].every(e=>e.disabled)&&!document.querySelector("[data-learn-reset]").disabled;'),true,'presenter prevents mid-stage edits while Reset stays available');
  }
  await waitFor(()=>p.eval<boolean>('return !document.querySelector("[data-learn-play]").disabled'),'presenter completed',10_000);
  assert.equal(await p.eval<string>('return __jevDemo.learning.state().phase'),'promoted');
  assert.equal(await p.eval<string>('return document.querySelector(".learn-stages button:last-child span").textContent'),'promoted');
  // Reset at the train stage cancels both the presenter and pending candidate completion.
  await clickDemo(p,'[data-learn-play]');
  await waitFor(()=>p.eval<boolean>('return __jevDemo.learning.state().phase==="training"'),'presenter training',10_000);
  await clickDemo(p,'[data-learn-reset]');
  await new Promise(r=>setTimeout(r,3300));
  assert.equal(await p.eval<boolean>('const s=__jevDemo.learning.state();return s.count===0&&s.examples.length===0&&s.candidate===null&&s.phase==="review"&&!document.querySelector("[data-learn-play]").disabled;'),true,'Reset cancels every remaining presenter stage');
  assert.equal(await p.eval<string>('return document.querySelector("[data-learn-outcome]").textContent'),'Answer the review examples to see what changes');
  assert.deepEqual(p.errors,[]);return 'outcome-first, all six timed stages, promotion, Reset cancels stale presenter work';
}
async function learningEvidence(url:string) {
  const p=await learningReady(url,'ap');
  await waitFor(()=>p.eval<boolean>('return document.querySelector("#learning-evidence").dataset.loaded==="true"'),'generated evidence',10_000);
  assert.equal(await p.eval<boolean>('const d=await (await fetch("data/learning-evidence.json")).json();return JSON.stringify(d)===JSON.stringify(__jevDemo.learning.evidence());'),true,'evidence reads generated JSON');
  const data=await p.eval<any>('return __jevDemo.learning.evidence()');
  for(const [id,m] of Object.entries(data.models) as [string,any][]){
    const cells=await p.eval<string[]>(`return [...document.querySelectorAll('[data-evidence-model="${id}"] td')].map(e=>e.textContent);`);
    assert.equal(cells[0],Number(m.instruction_override.auroc).toFixed(3));assert.equal(cells[1],Number(m.goal_deviation.auroc).toFixed(3));
    assert.equal(cells[2],Number(m.goal_deviation.threshold).toFixed(3));assert.ok(cells[3].startsWith((m.goal_deviation.recall*100).toFixed(1)+'%'));assert.ok(cells[5].startsWith(Math.round(m.latency.p50_ms)+' ms'));
  }
  await clickDemo(p,'#learning-evidence details summary');
  const text=await p.eval<string>('return document.querySelector("#learning-evidence").textContent');
  for(const caveat of data.caveats)assert.ok(text.includes(caveat));
  for(const phrase of ['not customer or human-reviewed','not reinforcement learning','calibrated threshold','No production latency guarantee','Production promotion is not implemented','records used','Source paths'])assert.ok(text.includes(phrase),phrase);
  assert.equal(await p.eval<boolean>('return ![...document.querySelectorAll("#learning-evidence a")].some(a=>a.getAttribute("href").includes("docs/EVAL.md"))'),true);
  assert.deepEqual(p.errors,[]);return 'all model cells generated from JSON, full provenance/caveats/training scope, served JSON link and no dead repo-doc link';
}
async function learningTabs(url:string) {
  const p=await learningReady(url,'ap');await fillLearning(p);
  await clickDemo(p,'[data-domain=soc]');
  await waitFor(()=>p.eval<boolean>('return __jevDemo?.ready&&__jevDemo.domain==="soc"'),'SOC Learning reload',10_000);
  assert.equal(await p.eval<boolean>('return !document.querySelector("[data-panel=learning]").hidden&&new URLSearchParams(location.search).get("tab")==="learning"&&__jevDemo.learning.state().count===0'),true);
  await p.eval<void>('__jevDemo.openTab("invalid-tab")');
  assert.equal(await p.eval<string>('return document.querySelector("[data-tab][aria-selected=true]").dataset.tab'),'live');
  await clickDemo(p,'[data-tab=learning]');
  assert.equal(await p.eval<string>('return new URLSearchParams(location.search).get("tab")'),'learning');
  await loadDemo(url,'?domain=ap&tab=invalid&autoplay=0');
  assert.equal(await p.eval<boolean>('return !document.querySelector("[data-panel=live]").hidden'),true);
  await loadDemo(url,'?domain=ap&tab=learning&embed=1&back=../index.html&autoplay=0&seed=11');
  await clickDemo(p,'[data-domain=soc]');await waitFor(()=>p.eval<boolean>('return __jevDemo?.ready&&__jevDemo.domain==="soc"'),'embedded Learning switch',10_000);
  assert.deepEqual(await p.eval<string[]>('const q=new URLSearchParams(location.search);return [q.get("tab"),q.get("embed"),q.get("back"),q.get("seed"),q.get("autoplay")]'),['learning','1','../index.html','11','0']);
  assert.deepEqual(p.errors,[]);return 'validated query/API tabs, user replaceState, Learning tab preserved across domain/embed options, reset on agent reload';
}
async function cleanupBrowser(){page?.ws.close();browser?.ws.close();chrome?.kill();}
let h:Awaited<ReturnType<typeof startGateAHarness>>|undefined;
try{
  h=await startGateAHarness();
  const p=await ensureBrowser();
  await p.send('Page.navigate',{url:h.url('/demo/index.html')});
  await waitFor(()=>p.eval<boolean>('return document.readyState==="complete"&&document.querySelectorAll("[data-tab]").length>0'),'demo loaded',10_000);
  const tabs=await p.eval<string[]>('return [...document.querySelectorAll("[data-tab]")].map(e=>e.dataset.tab)');
  assert.deepEqual([...tabs].sort(),['about','learning','live','replay','studio'],'all five stable tabs exist');
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
  for(const kind of ['embed','back'] as const)await probe('DEMO-HOST-'+kind,()=>hostOptionsProbe(h!.url('/demo/index.html'),kind));
  for(const domain of ['ap','soc']){
    await probe('DEMO-LEARN-'+domain.toUpperCase(),()=>learningWorkflow(h!.url('/demo/index.html'),domain));
    await probe('DEMO-LEARN-PRESENTER-'+domain.toUpperCase(),()=>learningPresenter(h!.url('/demo/index.html'),domain));
    await probe('DEMO-LEARN-LIFECYCLE-'+domain.toUpperCase(),()=>learningLifecycle(h!.url('/demo/index.html'),domain));
  }
  await probe('DEMO-LEARN-EVIDENCE',()=>learningEvidence(h!.url('/demo/index.html')));
  await probe('DEMO-LEARN-TABS',()=>learningTabs(h!.url('/demo/index.html')));
}catch(e){const status=e instanceof SkipProbe?'SKIP':'FAIL';results.push({id:'BOOT',status,detail:String(e)});console.log(`${status} BOOT — ${String(e)}`);}
finally{await cleanupBrowser();await h?.close();}
console.log(`\n${results.filter(r=>r.status==='PASS').length} PASS · ${results.filter(r=>r.status==='SKIP').length} SKIP · ${results.filter(r=>r.status==='FAIL').length} FAIL`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
