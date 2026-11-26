# Changelog

All notable changes to **T3 Antigravity Quota** will be documented in this file.

## [2.3.2] - 2026-11-26

### T3 Code 0.1.12 CORS Fix, Timeout Tuning & OAuth Safety Hardening
- **T3 Code 0.1.12 Stripped-Origin CORS Fix (`helper/lib/quota-router.cjs`, `renderer/antigravity-quota.js`)**: Handled Electron main-process `stripDesktopOriginHeaders` stripping `Origin: t3code://app` on outbound loopback requests in T3 Code `0.1.12`, returning CORS headers for origin-less loopback requests while continuing to return `403` to any disallowed browser/iframe `Origin` (`https://*`, `'null'`). Also added parallel `127.0.0.1:3773` fallback discovery in `ensureApiBase()` and cleaner error mapping (`stale` / `rateProtected`).
- **Ordered Multi-Layer Timeout Budget (`renderer/antigravity-quota.js`, `helper/quota-service.cjs`, `helper/lib/http-post.cjs`)**: Aligned deadlines strictly from outer to inner (`22s` frontend fetch > `18s` service deadline > `7s` ACP renewal / `3.5s` proxy direct fallback), eliminating spurious timeout races where frontend aborted before backend completed proxy/ACP fallback.
- **Google OAuth-Compliant ACP Cooldown Refinement (`helper/quota-service.cjs`)**: Separated transient ACP timeouts (`60s` background cooldown, manual refresh retries immediately) from revoked/interactive-login OAuth states (`needsT3Refresh: true`, strict `5m` cooldown even across repeated manual clicks, automatically cleared once a fresh `antigravity-oauth-token` is written on disk). Upstream HTTP `429`/`403` `5m` circuit breaker remains strictly non-bypassable.
- **Auto-Heal & CLI Robustness (`scripts/install.mjs`, `scripts/auto-heal.mjs`, `scripts/health.mjs`)**: Included backend helper hashes in `buildTag` so `auto-heal.mjs` detects backend updates cleanly; fixed `parseHealthArgs` so flags like `--install-dir` and `--refresh` no longer produce `NaN` ports. Expanded unit test coverage to `23/23`.

## [2.3.0] - 2026-11-26

### T3 Code Auto-Update Survival & Safety Hardening
- **Event-Driven Auto-Heal Guard (`scripts/auto-heal.mjs`)**: Fixes the bug where T3 Code's NSIS auto-updater overwrites `resources/server.asar` and removes the plugin. Uses OS kernel `fs.watch` (zero idle CPU, no UAC prompt, hidden `wscript.exe` launcher via `HKCU\...\Run`) plus a self-contained payload persisted in `%LOCALAPPDATA%\t3code-antigravity-quota\payload\` so auto-heal continues working even if the original download folder is deleted.
- **Non-Disruptive Re-Injection**: Never forcibly kills T3 Code mid-conversation when an update is detected while T3 is running; automatically re-injects in ~240ms the moment T3 Code exits (or on next Windows logon). Can be opted out via `--no-auto-heal` and is completely removed by `uninstall.mjs`.
- **Anti-Downgrade Source Selection (`chooseInstallSource`)**: Both `install.mjs` and `uninstall.mjs` now inspect the live `server.asar` and read its embedded `package.json` version (`t3VersionFromAsar`) first, ensuring an older backup can NEVER overwrite or downgrade a newly updated T3 Code `server.asar`.
- **Persistent External Backups & Dynamic Unpacked Check**: Moved verified clean backups out of `Programs/t3code/resources/` (where NSIS wipes them) into `%LOCALAPPDATA%\t3code-antigravity-quota\backups\` (auto-pruned to latest 2 versions), and replaced the hardcoded `unpacked !== 24` check with dynamic `sourceUnpacked` parity so future T3 Code versions with changed native modules install cleanly.
- **Enhanced Health Diagnostics (`scripts/health.mjs`)**: Now reports live `t3_version`, `asar_injected`, `auto_heal_registered`, `auto_heal_running`, and `auto_heal_status`. Verified end-to-end on T3 Code `0.1.12` (`20/20` unit tests + ASAR round-trip).

## [2.2.0] - 2026-11-25

### UI & Visual Redesign (4-Layer SDF Liquid Glass × Suzhe Typography)
- **True 4-Layer Optical Liquid Glass**: Rebuilt `renderer/antigravity-quota.css` and `renderer/antigravity-quota.js` with low-alpha neutral translucent glass (`0.44–0.64` dark / `0.48–0.64` light), `1.25px` masked Fresnel specular bevel, seamless neutral top meniscus sheen, and layered inner translucent glass sub-cards (Hero metric, per-pool cards, collapsible model drawer, and hover mini card).
- **Zero-Dependency Edge SDF Optical Refraction**: Generates rounded-rectangle SDF displacement maps on an offscreen `<canvas>` once at mount and attaches SVG `<feDisplacementMap>` (`#t3ag-lens-panel` / `#t3ag-lens-mini`) so background content bends optically along the curved glass perimeter while keeping interior text 100% crisp.
- **De-AI-Slop Restraint**: Removed rainbow gradient logo, neon progress-bar halos, navy/indigo dark fog, and redundant pill borders; switched to a monochrome native-matched `A` prism, editorial OKLCH mineral bars, neutral ink for healthy/moderate numerals, and hairline-divided tabular model rows (zero ellipsis truncation).
- **Suzhe Typography & Accessibility**: Enforced Apple/CJK display & text font stack (`SF Pro`, `PingFang SC`, `HarmonyOS Sans SC`, `Inter`), `font-feature-settings: "calt" 0 !important`, `font-synthesis: none`, W3C CLReq line breaking, `2.45rem` display Hero metric, `>= 12px` metadata readability floor, native `<dialog popover="auto">` with `showModal()` fallback, `prefers-reduced-transparency: reduce` opaque fallback, and `<= 18px` backdrop blur budget with zero `requestAnimationFrame` loops.
- **Docs & Showcase Assets**: Refreshed `docs/assets/hero-banner.svg`, all 4 2x Retina screenshots in `docs/screenshots/`, and `README.md`.

## [2.1.0] - 2026-11-24

### Reliability, Anti-Ban Compliance & Data Sync
- **Google Anti-Ban Protocol Alignment**: Matched T3 Code's official `antigravityUsageLimits` headers/endpoints, removed idle background polling, added tiered caching (`60s` summary / `5m` models / `30m` plan), `15s` manual force-refresh cooldown, and `5m` circuit breaker on HTTP `429`/`403`.
- **4-Layer Anti-Spin Hard Timeouts**: Added wall-clock deadlines across frontend `fetch` (`11s`), service aggregation (`12.5s`), HTTP proxy tunnels, and `agy.exe acp` silent refresh (`8s` timeout + `10m` cooldown + forced stream cleanup).
- **Protobuf3 `0%` Exhausted Fix**: Correctly distinguishes omitted `remainingFraction` with valid `resetTime` as `0%` exhausted and reconciles pool/model snapshots (`reconcileModelsWithPools`).
- **Mini & Detail Synchronization**: Unified `canonicalPools()` and `snapshotTimestamp()` so the hover mini card and click detail dialog always show identical pools, percentages, and update timestamps.

## [2.0.0] - 2026-11-22

### Architecture Overhaul
- Embedded quota API directly into T3 Code's `server.asar` (`/__t3_ag_quota`) via `ag-quota-hook.mjs` with zero external dependencies and full SHA-256 verified backup/restore.
- Docked trigger icon natively into T3 Code's left sidebar footer alongside Settings / PR / Issues / Usage with hover mini card and click detail view.
- Added Windows Registry dynamic proxy resolution (`win-proxy.cjs`) and zero-popup `agy.exe acp` silent token renewal (`agy-refresh.cjs`).
