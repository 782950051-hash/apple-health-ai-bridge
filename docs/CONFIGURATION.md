# 配置与快捷指令

## 天气快捷指令

候选天气文件为 `shortcuts/Weather Morning Independent.shortcut`，源自已在作者 iPhone 验证的 `Hermes Weather Morning Independent v3.3.1` 签名副本。本次未编辑 shortcut 内部动作，未把个人位置或健康数据写入文件。

触发规则为设备配置在 UTC+8 时北京时间 05:00 后由用户打开微信触发；当天成功保存后使用持久化状态避免重复采集。它不读取 HealthKit，不依赖睡眠。导入副本后仍须在目标 iPhone 真机检查时间、定位和 iCloud 权限及每日去重。

## 健康快捷指令来源与限制

健康主流程为 `shortcuts/Health Morning Independent.shortcut`，其调用的子流程为 `shortcuts/Apple Health Export v3.3 Stage B1 Auto Core.shortcut`。主流程来源于用户提供的 iCloud 签名文件，并以 `shortcuts sign --mode anyone` 制作独立发布副本。用户已确认在 iPhone 恢复原 B1；这不等于本候选重新签名的 B1 已在 iPhone 导入验收。Mac Shortcuts 列表存在同名主流程，但无法通过 CLI 导出安装载荷作逐字节比较；因此不能证明候选文件与当前设备安装内容完全相同。主包静态审计记录为 238 个动作，B1 为 425 个动作；变量引用、流程闭合和输入问题检查通过。

## 新用户需配置

1. 先导入 B1 子快捷指令，再导入健康主快捷指令和天气快捷指令。
2. 选择 Mac 本地数据目录，例如 `~/Library/Application Support/AppleHealthUpload`。
3. 在 Mac 的 iCloud Drive 中选择快捷指令 JSON 目录，并设置 `HEALTH_ICLOUD_DIR`。
4. 生成仅供本机 receiver 使用的随机 `HEALTH_UPLOAD_TOKEN`；此候选使用环境变量，不把 token 写入仓库。
5. 设置 `HERMES_BIN`、`HERMES_HOME` 和 Python 命令路径（如果不在 `PATH`）。
6. 在私有 `wechat-self.json` 中按本机 Hermes 安装和同意的本人接收者设置 sender 的 account/recipient 与状态文件路径。该格式是当前候选代码的本地耦合配置，不是 Hermes 官方稳定配置接口；不要从作者机器复制任何值，也不要公开该文件。

根目录 `.env.example` 展示变量名。运行时配置必须保存在权限为 `0600` 的本地文件或 LaunchAgent 私有环境中。

## 文件名与数据

天气 reader 支持 `weather-YYYY-MM-DD.json` 与旧版 `weather-YYYY-MM-DD-HHMMSS.json`。健康导入器按 `health-*.json` 扫描并用内容哈希去重。两类 JSON 的字段要求见 [examples](../examples/) 和对应验证器源码；样例为合成数据。
