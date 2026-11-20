# iCloud Drive 数据流

iPhone Shortcut 在 iCloud Drive 的 Shortcuts 目录保存 JSON。Mac 上的 iCloud Drive 客户端把文件同步到本地 File Provider 目录；Node receiver 每 60 秒扫描指定目录，等待文件稳定后使用受限辅助进程读取内容，再进行 JSON/schema 校验和 SHA-256 去重。

Finder 中看见文件不代表文件内容已经下载或可被后台进程读取。接收器遇到 `ENOENT`、`EAGAIN`、`ETIMEDOUT` 或 File Provider materialization 错误时，会保留待重试状态；不可恢复或持续失败会记录诊断状态。

天气文件支持固定名 `weather-YYYY-MM-DD.json` 和旧版带时分秒文件名。相同固定路径内容变化时，reader 依据内容哈希区分新版本。健康和天气分别进入独立 worker 与 outbox。

隐私边界：健康 JSON 属于敏感健康信息。只保存在用户自己的 iPhone、Mac、iCloud 和用户明确授权的 Hermes 模型/同步服务中。任何对外模型或消息调用都应在用户确认的数据范围内进行。
