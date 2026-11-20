# AI 安装提示词

请先阅读本仓库的 `README.md`、`docs/INSTALL.md`、`docs/CONFIGURATION.md`、`docs/HERMES.md`、`docs/WECHAT.md`、`docs/ICLOUD.md` 和 `docs/SECURITY.md`，再按以下要求帮助我部署。

你必须在我的 Mac 上实际检查环境、代码和状态。不要把文档步骤当作已执行结果，也不要把隔离测试说成真实端到端成功。

## 安全边界

- 不要把健康 JSON、天气位置、微信状态、Hermes 配置、API key 或 token 上传到公共仓库或发给第三方。
- 不要覆盖已有 Hermes 配置、记忆、Gateway、快捷指令或自动化。
- 不要停止/重启现有服务、修改已有账本、清空去重状态或发送正式报告，除非我在本次会话明确授权。
- 不要假设你拥有 iPhone 控制权限。需要用户授权、扫码、健康/定位权限或创建个人自动化时，提供清楚步骤。
- 未知发送结果标记为 `delivery_uncertain`；不要通过重试制造重复微信消息。
- 默认使用 prepare/manual 模式；只有我明确授权后才能打开自动发送。

## 第一步：只读盘点

检查 macOS/CPU、Node.js、Python、iCloud Drive、Hermes 版本与状态、Weixin/Gateway 状态、相关 LaunchAgent、现有接收器和端口。所有令牌只检查是否存在、权限和长度，不输出值。发现重复接收器、冲突端口或状态文件时先停止部署并报告。

## 第二步：评估候选完整性

确认三个 Shortcut 文件存在并检查签名/结构：健康主流程 `shortcuts/Health Morning Independent.shortcut`、其 B1 依赖 `shortcuts/Apple Health Export v3.3 Stage B1 Auto Core.shortcut`、天气流程 `shortcuts/Weather Morning Independent.shortcut`。健康文件来源于用户提供的 iCloud 签名包；当前已安装项无法导出载荷逐字节比较，因此只具备同名及来源证据，不得宣称完全一致。说明这一限制，不从源码生成替代快捷指令，也不使用测试 fixture 冒充。

## 第三步：隔离部署

在新目录安装依赖，保留现有服务。生成本机私有配置并设置 `0600` 权限。运行仓库隔离测试；再使用临时目录和合成天气/健康样例启动 receiver，sender 必须是 mock。证明坏 JSON 被拒绝、重复扫描不重复入队、重启能恢复待处理状态、天气与健康故障互不阻塞。

## 第四步：Hermes 与微信

将 [Hermes 官方微信配置指南](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin) 提供给我，由我配置自己的账号。未确认发送适配兼容前，保持 `delivery` 关闭。

## 第五步：iPhone 手工步骤

只提供仓库实际包含且已审计的 Shortcut。按顺序导入 B1、健康主流程、天气流程；逐条说明授权、触发器及天气 UTC+8/05:00 限制。候选包未经新用户 iPhone 导入验收，不得承诺自动化已工作。

## 第六步：分阶段验收

依次报告：

1. 静态检查和隔离测试。
2. Mac 临时目录真实进程测试。
3. 用户本人在 iPhone 的快捷指令运行结果。
4. Mac 对真实文件的接收与解析记录。
5. Hermes AI 分析的真实调用记录。
6. 微信发送回执和用户确认收到。

进行下一阶段前说明风险及可能的外部副作用。任何环节失败时保留错误和恢复状态，不修改历史账本来制造通过。

最终给出实际修改文件、当前配置模式、最近日志证据、未验证边界和回滚方法。
