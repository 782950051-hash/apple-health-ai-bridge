/** Both switches require an explicit later acceptance. Default can never call/send. */
export function stageD3Mode(env = process.env) {
  if (env.HEALTH_STAGE_C_AUTOMATION !== 'enabled') return 'prepare';
  return ['analysis', 'delivery'].includes(env.HEALTH_STAGE_D3_MODE) ? env.HEALTH_STAGE_D3_MODE : 'prepare';
}
