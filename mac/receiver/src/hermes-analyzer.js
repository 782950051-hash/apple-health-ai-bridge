import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const DEFAULT_BIN = process.env.HERMES_BIN ?? 'hermes';

/** Use the installed Hermes one-shot interface only after a new report is queued. */
export function createHermesAnalyzer({ bin = process.env.HERMES_BIN ?? DEFAULT_BIN, execFileFn = execFile, env = process.env } = {}) {
  return {
    async analyze({ factualReport }) {
      if (typeof factualReport !== 'string' || !factualReport.trim()) throw new Error('empty factual report');
      const prompt = [
        '你是 Apple Health 晨报整理器。只根据下面已经由本地程序计算并校验的事实生成中文晨报。',
        '不得补写缺失指标、疾病诊断、健康评分、个人基线或天气；天气不可用时保留不可用说明。',
        '保留睡眠时间、分期、心率/HRV/血氧的原始单位和数据不足说明。输出不超过 3500 字，只输出晨报正文。',
        '', factualReport,
      ].join('\n');
      const result = await execFileFn(bin, ['-z', prompt, '--reasoning', 'minimal'], {
        env: { ...env },
        timeout: 90000, maxBuffer: 128 * 1024,
      });
      const text = String(result.stdout ?? '').trim();
      if (!text || text.length > 4000) throw new Error('invalid Hermes analysis output');
      return text;
    },
  };
}
