import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runWeatherBarrierCycle, renderMorning41, reportId } from '../src/weather-barrier.js';
import { ReportOutbox } from '../src/report-outbox.js';

const now = () => new Date('2026-11-03T08:05:00+08:00');
const cutoff = '2026-11-03T07:00:00+08:00';
const hash = b => createHash('sha256').update(b).digest('hex');
const analysis = { analysis: '这是隔离测试分析，仅用于验证排版与持久化机制。'.repeat(5), suggestions: ['测试建议一。', '测试建议二。'] };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'weather-barrier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'); let weather = [];
  await mkdir(join(dataDir, 'v33-import'), { recursive: true });
  await mkdir(join(dataDir, 'exports'), { recursive: true });
  const opts = { root, dataDir, now, activationAt: cutoff, readWeather: async () => ({ records: weather, rejected_count: 0 }) };
  return { root, dataDir, opts, weather: rows => { weather = rows; } };
}
function weather(stamp='2026-11-03T07:59:00+08:00') {
  const value = { schema_version:'1.0', source:'apple_weather_shortcuts', observed_at:stamp,
    forecast_date:stamp.slice(0,10), location_name:'隔离测试城市', temperature_max_c:22.19,
    temperature_min_c:16.57, condition:'微雨' };
  return { weather:value, sha256:hash(JSON.stringify(value)), filename:'weather-test.json' };
}
async function health(s, { stamp='2026-11-03T08:00:00+08:00', sleepDay='2026-11-03', corrupt=false }={}) {
  const p=JSON.parse(await readFile(new URL('./fixtures/apple-health-v33.json', import.meta.url), 'utf8'));
  p.captured_at=stamp; p.event_received_at=stamp; p.run_id='isolated-run';
  for (const sample of p.sleep.samples) for (const k of ['start_date','end_date']) sample[k]=sample[k].replace('2026-11-01',sleepDay).replace('2026-10-31', '2026-11-02');
  for(const m of Object.values(p.metrics)) for(const a of m.samples) for(const k of ['start_date','end_date']) a[k]=a[k].replace('2026-11-01',sleepDay);
  if(sleepDay==='2026-11-02') p.sleep.samples=[{...p.sleep.samples[0],start_date:'2026-11-02T18:00:00+08:00',end_date:'2026-11-02T23:00:00+08:00'}];
  const bytes=JSON.stringify(p), digest=hash(bytes);
  await writeFile(join(s.dataDir,'exports',digest+'.json'),corrupt?'{}':bytes);
  await writeFile(join(s.dataDir,'v33-import','ledger.json'),JSON.stringify({version:1,imported:{[digest]:{export_id:digest,source:'health-isolated.json'}},failures:{}}));
  return digest;
}
async function state(s) { return JSON.parse(await readFile(join(s.root,'stage-d3','2026-11-03.json'),'utf8')); }
test('health alone waits durably; weather later permits only ready in manual mode',async t=>{
 const s=await setup(t); await health(s);
 assert.equal((await runWeatherBarrierCycle(s.opts)).waiting,1);
 assert.equal((await state(s)).status,'waiting_weather');
 s.weather([weather()]); await runWeatherBarrierCycle(s.opts);
 assert.equal((await state(s)).status,'ready');
 assert.equal((await new ReportOutbox(s.root).list()).length,0);
});
test('weather first waits; health later pairs; duplicate scan and restart do not call or enqueue',async t=>{
 const s=await setup(t);s.weather([weather()]); await runWeatherBarrierCycle(s.opts);
 assert.equal((await state(s)).status,'waiting_health');
 await health(s);await runWeatherBarrierCycle({...s.opts});await runWeatherBarrierCycle({...s.opts});
 assert.equal((await state(s)).status,'ready');assert.equal((await new ReportOutbox(s.root).list()).length,0);
});
test('stale, after-health, wrong-day and mismatched-offset weather never release barrier',async t=>{
 const s=await setup(t);await health(s);
 for(const stamp of ['2026-11-03T07:00:00+08:00','2026-11-03T08:01:00+08:00','2026-11-02T07:59:00+08:00','2026-11-03T07:59:00+09:00']) {
  s.weather([weather(stamp)]);await runWeatherBarrierCycle(s.opts);
  assert.equal((await state(s)).status,'waiting_weather');
 }
});
test('closest preceding weather wins; ready state survives source disappearance',async t=>{
 const s=await setup(t);await health(s);s.weather([weather('2026-11-03T07:50:00+08:00'),weather()]);
 await runWeatherBarrierCycle(s.opts);const a=await state(s);assert.equal(a.weather.weather.observed_at,'2026-11-03T07:59:00+08:00');
 s.weather([]);await runWeatherBarrierCycle(s.opts);assert.equal((await state(s)).status,'ready');
});
test('corrupt raw archive and historical capture cannot create a report',async t=>{
 const s=await setup(t);await health(s,{corrupt:true});s.weather([weather()]);
 const r=await runWeatherBarrierCycle(s.opts);assert.equal(r.invalid_health,1);assert.equal((await state(s)).status,'waiting_health');
 await health(s,{stamp:'2026-11-02T08:00:00+08:00'});await runWeatherBarrierCycle(s.opts);
 assert.equal((await state(s)).status,'waiting_health');
});
test('one authorized injected analysis persists; queued job and repeated cycles never reanalyze',async t=>{
 const s=await setup(t);await health(s);s.weather([weather()]);let calls=0;
 const opts={...s.opts,allowAnalysis:true,analyzer:{analyze:async()=>{calls++;return analysis;}}};
 await runWeatherBarrierCycle(opts);await runWeatherBarrierCycle({...opts});
 assert.equal(calls,1);assert.equal((await state(s)).analysis_status,'succeeded');
 const jobs=await new ReportOutbox(s.root).list();assert.equal(jobs.length,1);assert.equal(jobs[0].status,'queued');
 assert.equal(jobs[0].report_date,'2026-11-03');assert.equal(jobs[0].stage_d3,true);
 assert.match(jobs[0].text,/最高温：22℃/);assert.doesNotMatch(jobs[0].text,/partial|collection_status|count\/min|历史趋势/);
});
test('interrupted analysis becomes uncertain and never automatically reenters model',async t=>{
 const s=await setup(t);await health(s);s.weather([weather()]);await runWeatherBarrierCycle(s.opts);
 let a=await state(s);a.status='analyzing';a.analysis_status='running';
 await writeFile(join(s.root,'stage-d3','2026-11-03.json'),JSON.stringify(a));let calls=0;
 await runWeatherBarrierCycle({...s.opts,allowAnalysis:true,analyzer:{analyze:async()=>{calls++;return analysis;}}});
 assert.equal(calls,0);assert.equal((await state(s)).analysis_status,'uncertain');
});
test('persisted analysis result resumes enqueue without another model invocation',async t=>{
 const s=await setup(t);await health(s);s.weather([weather()]);await runWeatherBarrierCycle(s.opts);
 const a=await state(s);a.analysis_status='succeeded';a.analysis=analysis;
 a.text=renderMorning41({date:a.date,payload:a.health.payload,weather:a.weather.weather,analysis});a.status='analyzed';
 await writeFile(join(s.root,'stage-d3','2026-11-03.json'),JSON.stringify(a));let calls=0;
 await runWeatherBarrierCycle({...s.opts,allowAnalysis:true,analyzer:{analyze:async()=>{calls++;}}});
 assert.equal(calls,0);assert.equal((await new ReportOutbox(s.root).list()).length,1);
});
test('old sent daily job suppresses new analysis; legacy queued job is never sent',async t=>{
 for(const sent of [false,true]) {
  const s=await setup(t);const id=await health(s);s.weather([weather()]);let calls=0;
  const outbox=new ReportOutbox(s.root);const job=await outbox.enqueue({exportId:id,report:{date:'2026-11-03',manual:false,text:'old'}});
  if(sent){job.status='sent';await outbox.write(job);}
  await runWeatherBarrierCycle({...s.opts,allowAnalysis:true,allowSend:true,analyzer:{analyze:async()=>{calls++;}},sender:{send:async()=>{calls++;}}});
  assert.equal(calls,0);assert.equal((await state(s)).status,sent?'sent':'blocked_existing_outbox');
 }
});
test('send requires separate authorization; unknown outcome is not retried',async t=>{
 const s=await setup(t);await health(s);s.weather([weather()]);let sends=0;
 const opts={...s.opts,allowAnalysis:true,analyzer:{analyze:async()=>analysis},sender:{send:async()=>{sends++;throw Error('unknown');}}};
 await runWeatherBarrierCycle(opts);assert.equal(sends,0);
 await runWeatherBarrierCycle({...opts,allowSend:true});await runWeatherBarrierCycle({...opts,allowSend:true});
 assert.equal(sends,1);assert.equal((await new ReportOutbox(s.root).list())[0].status,'delivery_uncertain');
});
test('concurrent cycles serialize and cannot analyze twice',async t=>{
 const s=await setup(t);await health(s);s.weather([weather()]);let calls=0;
 const opts={...s.opts,allowAnalysis:true,analyzer:{analyze:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return analysis;}}};
 await Promise.all([runWeatherBarrierCycle(opts),runWeatherBarrierCycle(opts)]);assert.equal(calls,1);
});
test('sleep date may be previous day; morning weather still matches capture day',async t=>{
 const s=await setup(t);await health(s,{sleepDay:'2026-11-02'});s.weather([weather()]);
 await runWeatherBarrierCycle(s.opts);assert.equal((await state(s)).date,'2026-11-03');assert.equal((await state(s)).status,'ready');
});
test('failed analysis remains blocked; manual mode never invokes injected interfaces',async t=>{
 const s=await setup(t);await health(s);s.weather([weather()]);let calls=0;
 const analyzer={analyze:async()=>{calls++;throw Error('unavailable');}},sender={send:async()=>{calls++;}};
 await runWeatherBarrierCycle({...s.opts,analyzer,sender});assert.equal(calls,0);
 await runWeatherBarrierCycle({...s.opts,allowAnalysis:true,analyzer,sender});
 await runWeatherBarrierCycle({...s.opts,allowAnalysis:true,analyzer,sender});assert.equal(calls,1);
 assert.equal((await state(s)).analysis_status,'failed');assert.equal((await new ReportOutbox(s.root).list()).length,0);
});
test('pending pair expires without analysis or sending on next local day',async t=>{
 const s=await setup(t);await health(s);s.weather([weather()]);await runWeatherBarrierCycle(s.opts);let calls=0;
 await runWeatherBarrierCycle({...s.opts,now:()=>new Date('2026-11-04T08:00:00+08:00'),allowAnalysis:true,analyzer:{analyze:async()=>{calls++;return analysis;}}});
 assert.equal(calls,0);assert.equal((await state(s)).reason,'report_day_expired_manual_review');
});
test('weather-only data persists across restart even if iCloud is temporarily unavailable',async t=>{
 const s=await setup(t);s.weather([weather()]);await runWeatherBarrierCycle(s.opts);
 s.weather([]);await health(s);await runWeatherBarrierCycle({...s.opts});
 assert.equal((await state(s)).status,'ready');
});
test('a dead cycle owner is recovered before subsequent cycle; interrupted analysis stays uncertain',async t=>{
 const s=await setup(t);await health(s);s.weather([weather()]);await runWeatherBarrierCycle(s.opts);
 const a=await state(s);a.analysis_status='running';a.status='analyzing';
 await writeFile(join(s.root,'stage-d3','2026-11-03.json'),JSON.stringify(a));
 await writeFile(join(s.root,'stage-d3','cycle.lock'),JSON.stringify({pid:999999999}));let calls=0;
 const opts={...s.opts,allowAnalysis:true,analyzer:{analyze:async()=>{calls++;return analysis;}}};
 assert.equal((await runWeatherBarrierCycle(opts)).locked,1);
 await runWeatherBarrierCycle(opts);assert.equal(calls,0);assert.equal((await state(s)).analysis_status,'uncertain');
});
test('even with both future authorizations, either missing input blocks every external call; both arrival orders deliver once',async t=>{
 for(const healthFirst of [true,false]) {
  const s=await setup(t);let analyses=0,sends=0;
  const opts={...s.opts,allowAnalysis:true,allowSend:true,
   analyzer:{analyze:async()=>{analyses++;return analysis;}},
   sender:{send:async()=>{sends++;return{accepted:true,message_id:'isolated-test-only'};}}};
  if(healthFirst)await health(s);else s.weather([weather()]);
  await runWeatherBarrierCycle(opts);assert.equal(analyses,0);assert.equal(sends,0);
  assert.equal((await new ReportOutbox(s.root).list()).length,0);
  if(healthFirst)s.weather([weather()]);else await health(s);
  await runWeatherBarrierCycle(opts);await runWeatherBarrierCycle(opts);
  assert.equal(analyses,1);assert.equal(sends,1);assert.equal((await state(s)).status,'sent');
 }
});
