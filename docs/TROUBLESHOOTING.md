# 故障排查

## 天气文件没有出现

- 检查 iPhone 当天是否已过北京时间 05:00，快捷指令是否获得定位和 iCloud 权限。
- 查看 Shortcut 的每日状态；不要删除生产状态来强制重试。
- 核对文件名为 `weather-YYYY-MM-DD.json`，JSON 完整且日期与内部 `forecast_date` 一致。

## 文件在 Finder 可见但 Mac 未导入

- 核对 `HEALTH_ICLOUD_DIR` 与 Finder 实际目录。
- 检查最近扫描日志的时间、模块、操作阶段、错误代码和 retry 状态。
- 等待 File Provider 完成下载；不要通过重启或手工清账本绕过稳定性检查。
- reader 会拒绝坏 JSON、错误日期、未知字段和不可信单位。

## Hermes 未分析健康数据

- 确认该日健康 payload 被验证并导入，`collection_status`/睡眠样本满足 worker 条件。
- 查看健康 outbox 和 analysis 状态。若分析结果不确定或失败，不要清除状态强制重复调用。
- 核对 `HERMES_BIN`、`PATH`、`HERMES_HOME` 及本机 Hermes 状态。

## 微信未收到报告

- 确认对应 channel outbox 状态是 `sent`、`retry`、`blocked` 还是 `delivery_uncertain`。
- 若为 `delivery_uncertain`，不要直接重发；先核对本人微信是否已收到并按操作规程处理。
- 检查 Hermes Weixin Gateway 登录是否过期，必要时本人重新运行官方 QR setup。
- 健康和天气 outbox 命名空间独立；一个 worker 出错不应吞掉另一通道状态。

## 已知限制

真实系统曾遇到 iCloud 暂时不可读及健康旧文件 `ENOENT` 后续重试。天气 reader 曾出现间歇性拒绝。自动重试可恢复一部分 File Provider 延迟，不能保证 Apple 服务端、网络或设备始终可用。
