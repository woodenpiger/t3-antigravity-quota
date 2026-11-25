## T3 Antigravity Quota v2.2.0 — 4-Layer SDF Liquid Glass 重构版

> **核心升级**：彻底重构前端视觉为 **4 层真·液态玻璃（SDF 边缘折射 + 内层玻璃子卡 + Suzhe 字体字阶）**，全面去除廉价霓虹发光与 AI 模板味，同时完整保留 `v2.1.0` Google 合规防封号策略、四层硬超时防转圈与简/详实时同步。

### ✨ 本次更新亮点

- **真·液态玻璃四件套**：
  - 低 Alpha 中性透射玻璃体（暗色 `0.44–0.54` / 亮色 `0.48–0.64`），背后代码与卡片自然透出，告别不透明灰盒与蓝紫雾感。
  - **零依赖边缘 SDF 光学透镜折射**：启动时离线 Canvas 一次性生成圆角 SDF 位移贴图，挂载 SVG `<feDisplacementMap>` 仅弯曲外圈倒角，内部文字 100% 锐利零畸变。
  - **`1.25px` 镜面渐变描边 + 顶部弯月高光**，搭配 Hero 指标卡、双池卡与「各模型可用性」内层透光玻璃子卡，形成三层立体光学层次。
- **彻底去 AI 味 & Suzhe 排版**：
  - 侧栏与标题回归与 T3 原生一致的极简纯色棱镜 `A`；移除进度条外发光霓虹与冗余胶囊边框。
  - 正常/适中额度保持中性高对比墨色，仅在偏低（`<30%`）或危急/耗尽（`<10%`）时用克制 OKLCH 矿石色提醒。
  - 升级 `2.45rem` Suzhe Display 等宽核心大数字、全链路 `≥ 12px` 可读性下限与无截断单模型对齐列表。
- **性能、无障碍与稳定性**：
  - `backdrop-filter` 严格控制在 `≤ 18px`，零 `requestAnimationFrame` 空转；完整支持 `prefers-reduced-transparency: reduce`、`prefers-reduced-motion: reduce` 与 Windows 高对比度模式。
  - 沿用原生 `<dialog popover="auto">` 顶层轻退弹层（兼顾 `showModal()` 兜底）、Google 合规零静默后台轮询、`60s/5m/30m` 分层缓存、`429/403` 熔断冷却及 Protobuf3 `0%` 准确识别。

### 📦 安装 / 升级步骤（Windows 10 / 11，需 Node.js ≥ 18）

1. 下载下方附件 **`t3-antigravity-quota-v2.2.0.zip`** 并解压；
2. 先退出正在运行的 T3 Code（或直接让脚本自动关闭）；
3. 双击运行 **`install.cmd`**，自动完成备份校验、注入更新并重新启动 T3 Code。
4. 如需无损卸载，双击 **`uninstall.cmd`** 即可字节级还原原版 `server.asar`。

### ✅ 验证记录

- `node --test helper/test/quota.test.cjs`：`19 / 19` 全部通过
- `server.asar` 注入与 SHA-256 还原往返测试：`entries=3640, unpacked=24, integrity_ok=true, restored_entries=3631`
