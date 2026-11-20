import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWeatherReader } from '../src/weather-barrier.js';
import { runWeatherReportCycle } from '../src/weather-report-worker.js';

test('weather adapter also enables native materialization in its own child process', async t => {
 const root=await mkdtemp(join(tmpdir(),'weather-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const helper=join(root,'weather_d3_reader.py');
 await writeFile(helper,'import ctypes,json,sys\np=ctypes.CDLL("/usr/lib/libSystem.B.dylib").getiopolicy_np(3,0) if sys.platform=="darwin" else 2\nprint(json.dumps({"records":[],"materialization_policy":p}))\n');
 const reader=createWeatherReader({directory:root,helper});
 const r=await reader({now:new Date()});assert.equal(r.materialization_policy & 3,2);
});

test('real local Python reader rejects damaged files, accepts stable typed JSON, ignores health',async t=>{
 const root=await mkdtemp(join(tmpdir(),'d3-reader-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const now=new Date('2026-11-03T08:05:00+08:00');
 const weather={schema_version:'1.0',source:'apple_weather_shortcuts',observed_at:'2026-11-03T08:00:00+08:00',forecast_date:'2026-11-03',location_name:'隔离城市',temperature_max_c:22.19,temperature_min_c:16.57,condition:'微雨'};
 const p=join(root,'weather-2026-11-03-080000.json');await writeFile(p,JSON.stringify(weather));
 await utimes(p,now.valueOf()/1000-10,now.valueOf()/1000-10);
 await writeFile(join(root,'weather-2026-11-03-080001.json'),'{');
 await writeFile(join(root,'health-test.json'),'do not touch');
 const reader=createWeatherReader({directory:root,helper:fileURLToPath(new URL('../../../scripts/weather_d3_reader.py',import.meta.url))});
 const result=await reader({now});assert.equal(result.records.length,1);assert.deepEqual(result.records[0].weather,weather);
 assert.equal(result.rejected_count,1);
});

test('raw Shortcut fields are normalized before the isolated weather message is rendered',async t=>{
 const root=await mkdtemp(join(tmpdir(),'d3-raw-weather-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const now=new Date('2026-11-03T08:05:00+08:00');
 const weather={schema_version:'1.0',source:'apple_weather_shortcuts',
  observed_at:'2026-11-03T08:00:00+08:00',forecast_date:'2026-11-03',location_name:'隔离城市',
  temperature_max_c:22.19,temperature_min_c:16.57,condition:'微雨',
  temperature_current_raw:'68°F',
  temperature_current_source:'apple_weather_current_conditions.temperature',
  temperature_current_raw_unit:'embedded',temperature_current_raw_type:'shortcuts_text',
  temperature_feels_like_raw:'18°C',
  temperature_feels_like_source:'apple_weather_current_conditions.feels_like',
  temperature_feels_like_raw_unit:'embedded',temperature_feels_like_raw_type:'shortcuts_text',
  precipitation_probability_raw:'40%',
  precipitation_probability_source:'apple_weather_daily_forecast.precipitation_chance',
  precipitation_probability_raw_unit:'embedded',precipitation_probability_raw_type:'shortcuts_text'};
 const p=join(root,'weather-2026-11-03.json');await writeFile(p,JSON.stringify(weather));
 await utimes(p,now.valueOf()/1000-10,now.valueOf()/1000-10);
 const reader=createWeatherReader({directory:root,helper:fileURLToPath(new URL('../../../scripts/weather_d3_reader.py',import.meta.url))});
 let sent='';
 const result=await runWeatherReportCycle({root,now:()=>now,readWeather:reader,
  sender:{send:async text=>{sent=text;return {accepted:true};}}});
 assert.equal(result.sent,1);
 assert.match(sent,/当前温度：20℃/);
 assert.match(sent,/体感温度：18℃/);
 assert.match(sent,/今日降水概率：40%/);
});

test('daily precipitation chance text is normalized from its documented source semantics',async t=>{
 const root=await mkdtemp(join(tmpdir(),'d3-ambiguous-weather-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const now=new Date('2026-11-03T08:05:00+08:00');
 const weather={schema_version:'1.0',source:'apple_weather_shortcuts',
  observed_at:'2026-11-03T08:00:00+08:00',forecast_date:'2026-11-03',location_name:'隔离城市',
  temperature_max_c:22.19,temperature_min_c:16.57,condition:'微雨',
  precipitation_probability_raw:'1',
  precipitation_probability_source:'apple_weather_daily_forecast.precipitation_chance',
  precipitation_probability_raw_unit:'embedded',precipitation_probability_raw_type:'shortcuts_text'};
 const p=join(root,'weather-2026-11-03.json');await writeFile(p,JSON.stringify(weather));
 await utimes(p,now.valueOf()/1000-10,now.valueOf()/1000-10);
 const reader=createWeatherReader({directory:root,helper:fileURLToPath(new URL('../../../scripts/weather_d3_reader.py',import.meta.url))});
 const result=await reader({now});
 assert.equal(result.records[0].weather.precipitation_probability_pct,100);
 assert.deepEqual(result.normalization_issues,{});
 const cycle=await runWeatherReportCycle({root,now:()=>now,readWeather:reader});
 assert.equal(cycle.queued,1);
 assert.equal(cycle.normalization_issues,undefined);
});
