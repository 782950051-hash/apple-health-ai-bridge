import test from 'node:test';
import assert from 'node:assert/strict';
import { stageD3Mode } from '../src/stage-d3-mode.js';
test('manual and missing/unknown acceptance switch always prepare; delivery requires both switches',()=>{
 assert.equal(stageD3Mode({}), 'prepare');
 for(const value of ['analysis','delivery','enabled']) assert.equal(stageD3Mode({HEALTH_STAGE_C_AUTOMATION:'manual',HEALTH_STAGE_D3_MODE:value}),'prepare');
 assert.equal(stageD3Mode({HEALTH_STAGE_C_AUTOMATION:'enabled'}),'prepare');
 assert.equal(stageD3Mode({HEALTH_STAGE_C_AUTOMATION:'enabled',HEALTH_STAGE_D3_MODE:'analysis'}),'analysis');
 assert.equal(stageD3Mode({HEALTH_STAGE_C_AUTOMATION:'enabled',HEALTH_STAGE_D3_MODE:'delivery'}),'delivery');
});
