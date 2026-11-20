import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateMorningAnalysis } from './weather-barrier.js';

const execFile = promisify(nodeExecFile);

/** Same installed Hermes -z interface; invoked only after durable dual-file readiness. */
export function createHermesMorningAnalyzer({
  bin = process.env.HERMES_BIN ?? 'hermes',
  env = process.env, execFileFn = execFile,
} = {}) {
  return { async analyze({ factualReport }) {
    if (typeof factualReport !== 'string' || !factualReport.trim()) throw Error('missing_factual_input');
    const prompt = [
      '你是用户的私人健康管家。根据以下本地校验过的健康事实给出均衡、自然的中文解释。',
      '只输出一个 JSON 对象，键为 analysis（100–150 字中文单段）和 suggestions（恰好两条具体、可执行建议的字符串数组）。',
      '不得编造缺失指标、7天/30天趋势、个人基线、健康评分或天气。不要输出疾病诊断或对单次测量过度下结论。',
      '输入中的采集状态、技术日志、字段名不得出现在输出中。不要输出 Markdown 代码块或额外文本。',
      '数值和单位只依据以下事实；缺失样本不以睡眠外数据代替。',
      '', factualReport,
    ].join('\n');
    const result = await execFileFn(bin, ['-z', prompt, '--reasoning', 'minimal'], {
      env: { ...env },
      timeout: 90000, maxBuffer: 128 * 1024,
    });
    return validateMorningAnalysis(JSON.parse(String(result.stdout ?? '').trim()));
  } };
}
