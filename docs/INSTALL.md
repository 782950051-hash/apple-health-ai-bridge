# 安装与验收

本节是候选代码的部署说明，不是“已在新用户 Mac/iPhone 验收”的声明。三个快捷指令副本已经提供，但健康候选尚未经目标 iPhone 重新导入验收。

## 1. 检查环境

- 确认 macOS 和 Apple Silicon/Intel 架构；Hermes 的 macOS 安装支持范围以其[官方安装文档](https://hermes-agent.nousresearch.com/docs/getting-started/installation)为准。
- 检查 `node --version` 为 20 或更高，`python3 --version` 可运行。
- 确认 iCloud Drive 已登录并完成初次同步。
- 检查 `command -v hermes`、`hermes --version` 和 `hermes status`。
- 检查是否已存在另一个 Apple Health receiver，避免两个进程同时扫描/发送。

## 2. 安装本地副本

从候选仓库复制到用户自己的稳定目录，不要从开发工作区启动生产服务。安装依赖仅使用 Node 自带模块：

```sh
cd mac/receiver
npm test
```

在仓库根目录运行完整隔离测试：

```sh
npm test
```

创建私有数据目录和 LaunchAgent 前，先完成 `docs/CONFIGURATION.md` 中的路径与 token 配置。`.env.example` 仅列出变量，不会由 Node 自动加载；部署时将已填值放入权限为 `0600` 的本机 LaunchAgent 配置。不要把运行配置或 `wechat-self.json` 加入 Git。

## 3. 设置 iCloud 输入目录

把 Mac 的 iCloud Drive 快捷指令目录设为 `HEALTH_ICLOUD_DIR`。先使用一个测试文件夹验证接收器能列出文件、稳定读取 JSON，再指向含有真实数据的目录。iCloud 可见性与文件内容物化是两件事；延迟时接收器应保留待重试状态。

## 4. 配置 Hermes 和 Weixin

按 [Hermes 官方微信配置指南](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin) 配置你自己的账号。

本仓库 sender 与私有 Hermes Weixin 状态格式耦合，跨版本兼容性尚未验证。首次安装时先禁用自动发送，只检查导入、解析、健康事实文本和天气消息预览。

## 5. LaunchAgent

候选模板位于 `mac/launchd/com.example.apple-health-ai-bridge.plist.example`。将 `__PROJECT_ROOT__` 改成安装目录，把 token 等环境值仅写入本机的私有 LaunchAgent 配置。保持权限为 `0600`，不要提交已填值的 plist。验证 `launchctl print gui/$(id -u)/<label>`、进程参数、日志和 60 秒扫描；只在完成隔离测试后启用 `delivery`。

## 6. iPhone 配置

1. 导入 `shortcuts/Apple Health Export v3.3 Stage B1 Auto Core.shortcut`。
2. 导入 `shortcuts/Health Morning Independent.shortcut`，确认主流程可以调用 B1。
3. 导入 `shortcuts/Weather Morning Independent.shortcut`。
4. 按需分别授予健康快捷指令的 Health/iCloud 权限和天气快捷指令的定位/iCloud 权限。
5. 用户自行创建健康与天气个人自动化，并关闭不必要的确认提示；不要让旧目标和新目标同时触发同一流程。
6. 通过隔离目录或新的测试日期验证文件生成，不删除生产每日成功标记。

候选签名文件仍需目标 iPhone 真机验收。Mac 上的快捷指令清单不能证明 iPhone 已安装相同版本。

## 7. 验收清单

- 天气与健康独立扫描、独立状态和独立 outbox。
- 无健康文件时天气仍能解析、预览。
- 无天气文件时健康导入仍能继续。
- 文件稳定读取、校验、哈希去重和重启恢复均通过隔离测试。
- 未启用发送时不会调用微信。
- `delivery_uncertain`、历史已发送和重复日期均保持阻断。
- 真正发送需在新用户设备上单独做一次本人收件测试，并核对 outbox `sent`/回执，不得用模拟 sender 冒充真实送达。
