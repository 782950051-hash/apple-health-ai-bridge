# 发布候选审计记录

检查日期：2026-11-20

范围：v0.1.0 首版快照。已按作者要求使用个人非商业许可证；本轮验收涵盖仓库内容、签名载荷与隔离测试。

## 文件来源和范围

- 天气 Shortcut 来自 iCloud 中已在作者 iPhone 验证的 `Hermes Weather Morning Independent v3.3.1`。
- 健康主 Shortcut 来自用户指定的 iCloud 签名包；B1 子 Shortcut 来自三个字节完全一致的本地副本之一。
- Mac Node 源码和测试从现有 Apple Health receiver worktree 提取；Python 天气 reader 从现有 weather reader 模块提取。
- 未复制任何源仓库 Git 历史、个人配置、真实生产状态、真实健康/天气 JSON、日志、outbox 或 Hermes/微信状态文件。
- Node 业务代码只使用 Node 内置模块；Python reader 使用 Python 标准库/系统 API，不新增第三方 package 依赖。
- 两个健康测试 fixture 改为合成样例。样例中的日期和数值不代表真实采集。

## 快捷指令

候选含三份可独立下载的 AEA1 签名包，均以系统 `shortcuts sign --mode anyone` 生成。使用 Apple AEA 解包工具验证签名并与来源包比较，动作载荷逐项相同：健康主快捷指令 238 个动作，B1 425 个动作，天气 119 个动作。三者包头仅含通用 `SigningCertificateChain`，未包含 `AppleIDValidationRecord`。候选 SHA-256：健康主 `ac94a35fdffbd6dc98eaa9ab467ec5175f7f8e5995c6d39aaa23728fcaed7ba3`；B1 `e74dbdf1a7b9f8a269dfa5f84e3f9b5945984263dac2f607eead4c524abbe966`；天气 `e8a2b471d11eed1d1d8dbe1277dc1197109ccfd1a97d4899f00119cac34030ae`。

天气包未发现健康读取动作，保留 UTC+8 偏移检查、北京时间 05:00 门槛、每日状态键和固定天气文件逻辑。健康主流程及 B1 包含预期的健康读取动作。三份快捷指令均未发现指向缺失动作的输出引用、显式导入问答或「每次询问」令牌；常见凭据及私人路径扫描无命中。

签名包使用 AEA1 格式，包头包含 Apple 签名证书链及公钥，不含私钥或 Apple ID 验证记录。本轮未将发布副本重新导入 iPhone；真机历史验证属于原始来源包。

健康主 Shortcut 的「运行快捷指令」动作位于第 193 位，明确引用 `Apple Health Export v3.3 Stage B1 Auto Core`，无显式输入；返回 `Result` 被后续 JSON 匹配与字典字段验证动作读取。主包仅发现这一个子快捷指令调用。用户已确认在 iPhone 恢复原 B1；候选重签副本本身仍需目标 iPhone 导入验收。Mac 安装列表显示同名主流程，但无法导出其已安装载荷，因此无法证明候选与设备已安装内容逐字节相同。安装顺序为先 B1、再健康主流程。

## 源码与通道差异

候选代码移除了 Hermes 与 Python 绝对安装路径，使用 `PATH` 和环境配置。私有 health JSON、天气 JSON、token 和 outbox 均未包含。

发布版 sender 读取 Hermes Weixin 本地私有状态结构并请求 iLink；它不是 Hermes 官方公开、稳定的通用发送 SDK。隔离测试覆盖 recipient pinning、状态校验、发送异常分类和不确定状态保护，但没有用新用户 Hermes 安装进行兼容性验证。新用户必须使用自己的 Hermes 和微信账号；未确认兼容前保持发送关闭。

Hermes 的安装与 Weixin setup 文档链接到 Hermes 官方文档。Hermes 自身未被复制到仓库。

## 许可证

作者已确认署名为 `Copyright (c) 2026 Arden.W (GitHub: 782950051-hash)`。`LICENSE` 已从 PolyForm Noncommercial 替换为项目专用的 `Apple Health AI Bridge Personal Non-Commercial License 1.0`，并在 README 与 `docs/LICENSING.md` 同步说明个人非商业使用、免费修改和再分发、署名及同条件要求、禁止商业使用和事先书面授权要求。该限制排除 OSI 开源定义，项目只能称为源码公开、非商业许可。许可文本已按作者规则拟定，未进行律师审阅。

## 隐私扫描

已扫描候选签名载荷、源码、测试夹具和文档中的用户名路径、邮箱、电话样式、token/API key 样式、地理坐标、真实健康数值等常见标记；在快捷指令载荷、源码和测试夹具中未发现作者凭据或生产数据。测试夹具中的可识别结构均标注/改写为合成值。用户明确授权公开的推送截图则包含真实健康和天气信息，详见下文；此例外不适用于 JSON、数据库、日志、生产状态或其他数据文件。

新增两张作者主动提供、用于公开联系和自愿打赏的 JPG：`images/wechat-contact.jpg` 与 `images/wechat-donation.jpg`。复制前后 SHA-256 一致，未裁剪、重编码或修改二维码内容。macOS Vision 分别从每张图片识别出一个 QR；这验证了图像中的编码可被本地解码器读取，不代替用户在微信中的真机扫码验收。EXIF 只有方向、分辨率等信息，没有 GPS 坐标。联系码图片本身可见微信昵称、浙江杭州字样和头像；收款码图片本身含微信收款二维码、头像及部分遮挡的名称。这些是用户明确提供用于公开展示的图像内容，不属于可通过删元数据去除的内容。

已解包检查三份签名包载荷：未发现作者绝对路径、邮箱、token/API key、精确坐标或 Apple ID 验证记录。天气包原签名曾包含 AppleID 验证元数据；公开候选已重签并验证动作载荷不变。扫描为模式检测，不能证明绝对无隐私。联系二维码及打赏码是作者明确提供的公开展示素材；图像中的昵称、地区、头像和收款二维码本身可见，未改变二维码内容。图片相对路径为 `images/wechat-contact.jpg` 与 `images/wechat-donation.jpg`，EXIF 未见 GPS 数据。

## 真实微信推送截图

作者本轮提供了两张真实微信推送截图，已加入 README 展示区。发布副本路径：

- `docs/images/weather-wechat-delivery.png`
- `docs/images/health-wechat-delivery.png`

来源为用户本轮提供的天气 JPG 与健康 PNG 附件。发布副本保持画面原样，无裁切、遮挡或内容修改；以 PNG 保存时去除了 EXIF、XMP、GPS、源文件创建时间和其他图片元数据。已目视核对发布副本的画面与附件显示内容一致，源附件未覆盖。

作者明确要求保留图片信息。天气图可见日期、台州市、天气与气温、降水概率、状态栏时间及背景；健康图可见日期、睡眠时间与分期、心率、HRV、血氧及健康分析文本。README 已明确说明这些信息未遮挡且由作者要求保留。此公开选择会将真实健康和天气信息发布到仓库，应作为个人敏感信息处理；不得声称其已被脱敏。详情见 `docs/SCREENSHOT_PRIVACY.md`。

## 验证

- Node 隔离测试：123/123 通过。
- Python 天气 reader 测试：7/7 通过。
- LaunchAgent plist 模板：`plutil -lint` 通过。
- 三个 Shortcut 签名载荷：分别与各自来源包动作载荷完全相同；健康/B1/天气分别为 238/425/119 动作。
- 三个候选包均为 AEA1，包头不含 AppleIDValidationRecord。
- 未运行候选 LaunchAgent、真实模型分析、真实微信发送或生产快捷指令；无任何新用户真机验收。

## 验收范围

- Hermes Weixin sender 与本机状态格式耦合，尚未进行跨安装或跨版本验收；启用前需在使用者自己的环境中验证。
- 本轮未操作 iPhone。健康主快捷指令与 B1 的发布签名包仍需在使用者设备导入验证。
- 项目许可证只覆盖作者有权授权的项目材料。Hermes 和 Apple 服务是外部依赖；其软件、配置和运行数据不包含在发布快照中。

## 暂存发布文件清单

以下 91 项是首版允许发布的文件。初始提交不继承其他项目的历史。截图只包含经作者授权的 PNG 发布副本，不包含临时源附件。

```text
.env.example
.gitignore
LICENSE
README.md
README_EN.md
docs/CONFIGURATION.md
docs/CONTACT.md
docs/HERMES.md
docs/ICLOUD.md
docs/INSTALL.md
docs/LICENSING.md
docs/PUBLISHING_AUDIT.md
docs/SCREENSHOT_PRIVACY.md
docs/images/health-wechat-delivery.png
docs/images/weather-wechat-delivery.png
docs/SECURITY.md
docs/TROUBLESHOOTING.md
docs/WECHAT.md
examples/health.example.json
examples/weather.example.json
images/wechat-contact.jpg
images/wechat-donation.jpg
mac/launchd/com.example.apple-health-ai-bridge.plist.example
mac/receiver/README.md
mac/receiver/package.json
mac/receiver/src/config.js
mac/receiver/src/export-store.js
mac/receiver/src/health-report.js
mac/receiver/src/hermes-analyzer.js
mac/receiver/src/hermes-morning-analyzer.js
mac/receiver/src/icloud-file.js
mac/receiver/src/icloud-import.js
mac/receiver/src/independent-report-cycle.js
mac/receiver/src/metric-catalog.json
mac/receiver/src/metric-coverage.js
mac/receiver/src/pending-wake.js
mac/receiver/src/report-outbox.js
mac/receiver/src/report-worker.js
mac/receiver/src/server.js
mac/receiver/src/stage-d3-mode.js
mac/receiver/src/status.js
mac/receiver/src/store.js
mac/receiver/src/types.js
mac/receiver/src/v33-import.js
mac/receiver/src/v33-report-worker.js
mac/receiver/src/v33.js
mac/receiver/src/validation.js
mac/receiver/src/wake-upload.js
mac/receiver/src/weather-barrier.js
mac/receiver/src/weather-report-worker.js
mac/receiver/src/wechat-self.js
mac/receiver/test/export-upload.test.js
mac/receiver/test/fixtures/apple-health-v33.json
mac/receiver/test/fixtures/complete-payload.json
mac/receiver/test/health-report-e2e.test.js
mac/receiver/test/health-report.test.js
mac/receiver/test/hermes-analyzer.test.js
mac/receiver/test/hermes-morning-analyzer.test.js
mac/receiver/test/icloud-file.test.js
mac/receiver/test/icloud-import.test.js
mac/receiver/test/independent-report-cycle.test.js
mac/receiver/test/metric-coverage.test.js
mac/receiver/test/morning-layout.test.js
mac/receiver/test/pending-wake.test.js
mac/receiver/test/report-outbox.test.js
mac/receiver/test/report-worker.test.js
mac/receiver/test/server.test.js
mac/receiver/test/stage-d3-mode.test.js
mac/receiver/test/status.test.js
mac/receiver/test/store.test.js
mac/receiver/test/v33-import-recovery.test.js
mac/receiver/test/v33-import.test.js
mac/receiver/test/v33-report-worker.test.js
mac/receiver/test/validation.test.js
mac/receiver/test/wake-upload.test.js
mac/receiver/test/weather-barrier.test.js
mac/receiver/test/weather-reader-integration.test.js
mac/receiver/test/weather-report-worker.test.js
mac/receiver/test/wechat-self.test.js
mac/scripts/health_stage_c_status.mjs
mac/scripts/icloud_file_access.py
mac/scripts/run_health_receiver.mjs
package.json
prompts/AI_INSTALL_PROMPT.md
scripts/apple_weather_d2.py
scripts/weather_d3_reader.py
shortcuts/README.md
shortcuts/Apple Health Export v3.3 Stage B1 Auto Core.shortcut
shortcuts/Health Morning Independent.shortcut
shortcuts/Weather Morning Independent.shortcut
tests/test_weather_d3_reader.py
```
