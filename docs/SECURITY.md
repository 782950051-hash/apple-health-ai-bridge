# 安全与隐私

本项目读取 Apple Health/Apple Watch 健康样本、天气位置、Hermes/Weixin 状态并可能向个人微信发送摘要。请按敏感数据处理。

候选仓库不得包含：

- 真实健康或睡眠 JSON、天气历史或精确坐标。
- 微信/Weixin token、账号/接收者 ID、context token 或登录状态文件。
- Hermes 私有配置、API key、上传 token、launchd 日志或生产 outbox。
- 作者个人文件路径、Apple ID、邮箱、电话。
- 原始私人 Git 历史。

接收器示例只使用合成值。数据目录建议权限 `0700`，状态文件权限 `0600`；密钥只保存在本机配置中。不要把真实健康样本粘贴到公开 issue、AI 服务或日志里。

作者明确授权加入的联系/打赏二维码，以及 `docs/images/` 中经作者确认用于公开展示的两张真实推送截图，是本候选的限定例外。推送截图中的日期、天气地区与数值、睡眠信息和健康指标未遮挡；该许可只覆盖这两份图片，不授权上传其他真实健康或天气数据。维护者应在 README 和发布审计中说明内容已由作者授权公开、图片元数据已清除。

发布前扫描候选树与 Git 索引：

```sh
rg -n -i 'wangbaiwan|/Users/|@gmail\.|@icloud\.|Bearer |WEIXIN_TOKEN|context_token|latitude|longitude' --glob '!docs/SECURITY.md' .
git status --short
git diff --cached --name-only
```

这些扫描只能发现已知字符串模式，不能代替逐文件审查、图像/二维码人工检查或对签名快捷指令内部 plist 的结构审计。测试快捷指令的签名不证明隐私安全。

维护者不得要求贡献者提供微信登录凭据或真实健康文件。安全问题使用私下渠道报告，不发布密钥和样本。
