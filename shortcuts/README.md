# Shortcuts

## 健康流程

- `Health Morning Independent.shortcut`：从用户指定的 iCloud Drive 签名包生成的独立发布副本。
- `Apple Health Export v3.3 Stage B1 Auto Core.shortcut`：健康主流程调用的 B1 子快捷指令，必须一并导入。

Mac Shortcuts 列表中存在同名 `Health Morning Independent` 主流程，但当前安装项无法通过 `shortcuts` CLI 导出以逐字节比较；本地 iCloud 文件与生产同名，且其动作和依赖已完成静态审计。该关联证据不能证明设备安装载荷与候选文件完全相同。健康候选未经本轮 iPhone 重新导入验证。

## 天气流程

`Weather Morning Independent.shortcut` 是 `Hermes Weather Morning Independent v3.3.1` 的签名副本，已在作者 iPhone 真机验证。候选文件未编辑内部动作。

## 安装顺序

先导入 `Apple Health Export v3.3 Stage B1 Auto Core.shortcut`，再导入 `Health Morning Independent.shortcut`，最后单独导入 `Weather Morning Independent.shortcut`。安装健康主流程前确认 B1 子快捷指令已出现在 Shortcuts 中。两条用户流程应由用户分别设置自动化；本仓库不代替用户创建或切换个人自动化。
