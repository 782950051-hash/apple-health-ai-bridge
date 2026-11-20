# Hermes Agent

Hermes Agent 是 Nous Research 维护的个人 AI Agent。它运行在 Mac 上；本项目不在 iPhone 上运行 Hermes。

## 安装与健康检查

Hermes 安装流程和支持的平台会更新，按[官方安装指南](https://hermes-agent.nousresearch.com/docs/getting-started/installation)选择安装方式。macOS 桌面包目前标记为 Apple Silicon 支持；源码/命令行路径按官方平台支持页核实。

安装后在终端检查：

```sh
command -v hermes
hermes --version
hermes status
```

如已有 Hermes 环境，先复用该环境，不覆盖其配置、记忆或账号状态。部署服务后按用户本机 Hermes 文档启动/保持 Gateway 运行。不得假定某个未记录的后台启动命令在所有版本有效。

## 本项目的调用方式

健康 worker 先用确定性代码验证、计算睡眠区间和指标，再通过 Hermes one-shot（`hermes -z`）生成文字。AI 输入不应包含未验证的推测；分析失败时不得生成成功报告。

天气 worker 不需要健康分析模型：Mac reader 先校验天气来源和字段单位、转换气温与降水概率，再按模板渲染天气消息。

候选 receiver 的代码需要配置 `HERMES_BIN` 与可选 `HERMES_HOME`。候选默认值是 `hermes`，由 shell `PATH` 解析，不含作者本机路径。

## 权限

只授予 receiver 读取指定 iCloud 目录、写入项目私有数据目录、调用 Hermes CLI 所需权限。不要为方便而永久放行所有 Shell/Python，也不要授予健康数据以外的目录访问权。真实健康数据不上传至公共仓库。

Hermes 文档：[官方站点](https://hermes-agent.nousresearch.com/docs/)。
