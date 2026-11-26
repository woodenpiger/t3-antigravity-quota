## T3 Antigravity Quota v2.3.0 — T3 Code 自动更新自愈修复版

> **核心修复**：解决 **T3 Code 自动更新（如 `0.1.11 → 0.1.12`）覆盖 `server.asar` 导致插件消失** 的问题，新增零空转事件驱动自愈守护、独立防清理备份目录与防版本降级保护。

### 🛠️ 本次修复与升级

- **T3 更新自愈守护（`scripts/auto-heal.mjs`）**：
  - 安装时自动将插件核心副本持久化保存至 `%LOCALAPPDATA%\t3code-antigravity-quota\payload\`（即使事后删掉下载的解压目录也不受影响），并注册无需管理员权限的零黑框自愈守护（`HKCU\...\Run\T3AntigravityQuotaAutoHeal`）。
  - 基于操作系统内核 `fs.watch` 监听 `resources/server.asar`，待机 **0% CPU**；一旦感知到 T3 Code 更新覆盖了 `server.asar`：
    - 若 T3 未运行，约 `240ms` 内自动重新注入；
    - 若 T3 更新后已自动拉起，**绝不强杀你正在进行的对话**，而是静默等待你关闭 T3 Code 后瞬间自动完成自愈，下次打开插件立刻回归。
  - 若不想启用后台自愈，命令行安装时加 `--no-auto-heal` 即可；运行 `uninstall.cmd` 会自动彻底停止并清理注册表项与本地目录。
- **彻底修复版本更新时的 3 处隐患**：
  - **独立备份目录**：将原版 `server.asar` 校验备份迁出 `Programs/t3code/resources/`（NSIS 更新会清空该目录），改为保存在 `%LOCALAPPDATA%\t3code-antigravity-quota\backups\`（自动保留最近 2 版）。
  - **防旧备份误降级**：安装器与卸载器改为直接读取 `server.asar` 内置 `package.json` 版本号并优先检测当前文件是否纯净，杜绝 T3 升级后用旧版备份覆盖新版 `server.asar`。
  - **动态 `unpacked` 模块数校验**：移除原先写死的 `unpacked !== 24`，改为动态比对源 `server.asar` 的原生模块数量，兼容未来所有 T3 Code 版本。
- **诊断增强（`scripts/health.mjs`）**：实时输出 `t3_version`、`asar_injected` 与自愈守护运行状态。

### 📦 安装 / 升级步骤（Windows 10 / 11，需 Node.js ≥ 18）

1. 下载下方附件 **`t3-antigravity-quota-v2.3.0.zip`** 并解压；
2. 先退出正在运行的 T3 Code（或由脚本自动关闭）；
3. 双击运行 **`install.cmd`**，自动注入新版 `v2.3.0` 并开启更新自愈守护；
4. 如需无损卸载，双击 **`uninstall.cmd`** 即可自动移除自愈守护并还原原版 `server.asar`。

### ✅ 验证记录

- 实测适配 **T3 Code `0.1.12`**（`3639` 文件、`24` 个 `unpacked` 原生模块，`integrity_ok=true`，还原条目 `3639/3639` 严格一致）
- `node --test helper/test/quota.test.cjs`：`20 / 20` 全部通过（含新增的防版本降级单测）
