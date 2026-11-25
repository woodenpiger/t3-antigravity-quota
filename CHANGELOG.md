# Changelog

All notable changes to **T3 Antigravity Quota** will be documented in this file.

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
