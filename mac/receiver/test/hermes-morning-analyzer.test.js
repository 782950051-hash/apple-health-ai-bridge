import test from 'node:test';
import assert from 'node:assert/strict';
import { createHermesMorningAnalyzer } from '../src/hermes-morning-analyzer.js';

const analysis={analysis:'这是一段隔离测试专用的中文分析，仅用于验证输出契约。'.repeat(4),suggestions:['建议一。','建议二。']};
test('native one-shot adapter issues exactly one injected call and validates output',async()=>{
 let calls=0;
 const a=createHermesMorningAnalyzer({bin:'/test/hermes',env:{},execFileFn:async(bin,args,opts)=>{
  calls++;assert.equal(bin,'/test/hermes');assert.equal(args[0],'-z');assert.match(args[1],/100.*150/);
  assert.deepEqual(args.slice(2),['--reasoning','minimal']);assert.equal(opts.timeout,90000);
  assert.deepEqual(opts.env,{});return{stdout:JSON.stringify(analysis)};
 }});
 assert.deepEqual(await a.analyze({factualReport:'隔离测试事实。'}),analysis);assert.equal(calls,1);
});
test('invalid or ambiguous output fails without automatic retry',async()=>{
 for(const output of ['', '{}', '```json\n{}\n```', JSON.stringify({...analysis,analysis:'太短'})]) {
  let calls=0;const a=createHermesMorningAnalyzer({execFileFn:async()=>{calls++;return{stdout:output};}});
  await assert.rejects(a.analyze({factualReport:'隔离测试事实'}));assert.equal(calls,1);
 }
});
