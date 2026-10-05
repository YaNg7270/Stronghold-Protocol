# 卫戍协议：盟约 离线化 — 探查报告与开发计划

探查对象：`http://103.205.253.194:27527/`（2026-10-05，客户端 `APP_VERSION 0.1.3`，`PROTOCOL_VERSION 1`）

## 一、探查结论

### 1. 前端：可以原样离线运行

- 未打包的原生 ES Modules，没有构建步骤：`index.html` → `/js/main.js`，用 import map 映射 `preact` / `preact/hooks` / `htm`。
- UI：Preact + htm。战场渲染：PixiJS + pixi-spine（`/vendor/pixi.min.js`、`/vendor/pixi-spine.js`），3D 棋盘用 three.js（`/vendor/three.module.js`，需要 WebGL2，不支持时退回 2D）。
- 代码已经全部抓到并通过校验：138 个 JS 模块、13 个 data JSON，共约 8 MB。
- 外部依赖只有 Google Fonts（Noto Sans SC / Oxanium / Rajdhani），而且不阻塞渲染，下载到本地即可。

### 2. 美术和音频资源：约 330 MB，可以完整下载

所有资源 URL 都来自两份清单：`/data/assets.json` 和 `/data/local-assets.json`（代码注释里写明“nothing is guessed”），所以按清单下载就能下全。

| 目录 | 数量 | 估算体积 |
|---|---|---|
| `/assets/spine/*.skel/.atlas/.png` | 529 × 3 | ~126 MB |
| `/assets/ui` | 601 | ~59 MB |
| `/assets/audio/*.mp3` | 517 | ~59 MB |
| `/assets/char` | 520 | ~52 MB |
| `/assets/local`（含 3D 棋盘贴图） | ~1450 | ~13 MB |
| skill / enemy / item / band / bond / token / prof | ~790 | ~21 MB |

注意：服务器时不时返回 502，有些响应会被截断但状态码仍是 200，下载器必须核对 `Content-Length` 并重试。

### 3. 服务器：WebSocket，权威服务器，源码未公开（这是主要工作量）

- 只有一条连接 `ws(s)://<host>/ws`，传 JSON 文本帧 `{ t, rid?, ...payload }`。完整的消息目录在 `shared/protocol.js`：
  - C2S：`hello`、`ping`、`room.*`（create/join/leave/ready/addBot/start/loadout…）、`g.*`（band/buy/refresh/freeze/levelUp/sell/move/equip/art/reward/choice/ready/pause…）、`b.progress`、`b.result`
  - S2C：`welcome`、`ok`、`error`、`pong`、`room.state`、`m.public`、`m.private`、`m.field`、`m.toast`、`m.ticker`、`m.result`、`m.unitStats`、`b.start`、`b.pool`、`b.end`
- `server/` 目录（lobby、match/Match.js、PlayerState、board、fields、waves、choices、finalAssault、bondsMeta…）**没有对外提供**，访问都是 404。

### 4. 战斗模拟：已经在客户端，这是最大的利好

- 战斗由浏览器自己模拟（“client-side combat”，DESIGN §14）。服务器只发 `b.start { spec }`，客户端跑完后用 `b.result` 回报结果。
- 战斗内核（`server/sim`）以只读方式挂在 `/sim/`，已全部抓到：约 32,000 行，包括 `Battle.js`、6 个 tier 的干员 kit、敌人、Boss、羁绊、装备、策略（band）、驻防。
- 模拟是确定性的：不读系统时钟，也不用 `Math.random`。已验证这些模块能在 Node 下直接 import（`buildBattleSpec`、`createBattleFromSpec` 等都能用），所以本地服务器也能无界面地跑战斗（AI 队友的战场要用到）。
- 准备阶段的内容逻辑有一部分也在 `/sim/content/*/meta.js`（策略、装备、驻防、support）里，但它们依赖服务器端的 registry 接口（`ctx.hand()`、`ctx.roundStats()`、`ctx.teammates()` 等），这个接口需要我们自己实现。

### 5. 对局规则：大部分在数据里

`/data/config.json` 里有：各模式配置、经济（收入表、价格、卡池份数、商店概率 `shopOdds`、合成数、手牌/暂存/上阵上限、冻结规则、奖励）、计时器、生命值上限（LP）、Boss 血量缩放、隐秘核心、联防（unite）、最终攻势、禁用规则、策略选择、奖杯和奖励公式等。
`/data/choices.json`、`/data/bosses.json`、`stages.json`、`waves.json` 里分别是机变选项、Boss、地图和波次。

**缺的是“流程代码”**：阶段状态机、刷新商店、买卖/合成/移动/装备的合法性检查、根据 `waves.json` 生成 `spawns`/`routes`、结算、AI 队友。这些都要按协议和数据重写。好在客户端注释写得很细（每条消息、每个阶段都注明了服务器的行为和对应文件），可以作为主要参照。

## 二、技术方案

**不改原客户端代码，在浏览器里放一个本地服务器。**

`net.js` 在连接时才去取 `globalThis.WebSocket`（`net.js:218`）。所以只要在 `index.html` 里、`main.js` 之前加载一个 `offline/shim.js`，把 `WebSocket` 换成一个假的实现：连向 `/ws` 的连接转给本地服务器，其余连接照常交给原生 WebSocket。原版客户端（UI、渲染、战斗模拟）一行都不用改。

```
index.html
 ├─ offline/shim.js        FakeWebSocket：拦截 /ws，在浏览器内转发消息
 ├─ js/main.js …           原版客户端（不改）
 └─ offline/server/        本地服务器（跑在 Web Worker 里，纯 ESM）
     ├─ session.js         hello/welcome/ping/pong，单机身份
     ├─ lobby.js           room.*（单人房间，加 AI 队友）
     ├─ match/             阶段状态机、商店、棋盘、合成、装备、机变、结算
     ├─ waves.js           根据 waves.json 和 stages.json 生成 spawns/routes
     ├─ meta.js            content meta registry（驱动 /sim/content/*/meta.js）
     ├─ bots.js            AI 队友（购买和布阵策略）
     └─ 直接复用 /sim/（buildBattleSpec、headless 战斗）和 /data/*.json
```

单人模式下，玩家自己的战斗由原客户端模拟（`authoritative: true`），本地服务器只负责下发 `b.start`、接收 `b.result`。AI 队友的战场由本地服务器在 Worker 里无界面地跑。

## 三、开发计划

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **P0 探查** | 本报告 | ✅ 已完成 | — |
| **P1 资源镜像** | 写下载器：按两份清单和代码图下载，带重试和完整性校验，Google Fonts 存到本地；本地静态服务器能打开标题页 | `tools/mirror/`，产物放在 `game/`（不提交到 git） | 1–2 天 |
| **P2 协议采样** | 在能访问线上的电脑上用 `tools/recon/recon.mjs` 录下几局完整对局（单人各难度、加 AI 队友的合作局、最终攻势、隐秘核心）的全部 WS 帧，整理出各消息的字段结构 | `docs/protocol/*.md` + 样本 JSON | 1–2 天 |
| **P3 骨架** | FakeWebSocket + Worker 服务器：hello/welcome/ping，单人建房 → INFO_CHECK → BAND_DRAFT → 进入 PREP 画面 | 能断网进入对局界面 | 2–3 天 |
| **P4 单人对局** | 阶段机（ROUND_START/SP_DRAFT/PREP/COMBAT/SETTLE）；商店（`shopOdds`、共享卡池、刷新、冻结、升级）；手牌、棋盘、暂存区；合成金卡；装备和 art；奖励和机变；策略和禁用；羁绊统计；meta registry；`waves` → `b.start`；结算（LP、收入）；FINAL_ASSAULT、HIDDEN_CORE、RESULT | **单人完整可玩** | 3–5 周 |
| **P5 合作模式（AI 队友）** | AI 队友的购买和布阵逻辑，队友战场在 Worker 里跑，联防阶段、最终攻势配对、观战画面 | 离线 1 人 + 1–3 个 AI | 1–2 周 |
| **P6 存档** | 对局进度存到 IndexedDB，刷新或关闭后能接着打；设置和干员配置原本就存在 localStorage | 断点续玩 | 2–3 天 |
| **P7 打包** | ES Module 和 fetch 不能在 `file://` 下运行。方案 A：Tauri/Electron 用自定义协议托管（推荐 Tauri，体积小）；方案 B：单个 exe 内嵌静态服务器；方案 C：PWA + Service Worker 缓存 | 双击即玩的离线包 | 2–4 天 |
| **P8 校验** | 用相同 seed 和操作对比线上和离线的 `m.public`/`b.result`；用 Node 给本地服务器写单元测试（sim 本身在 Node 下能跑）；断网后过一遍全流程，确认没有任何对外请求 | 回归测试集 | 持续进行 |

建议的里程碑：**P1 + P3**（能离线打开、进入对局界面）→ **P4**（单人完整可玩，这是核心交付）→ P5、P6、P7 按需要做。

## 四、风险和注意事项

1. **服务器流程只能重写，和原版不可能完全一致。** 例如商店抽卡的随机数实现、AI 行为、各种边界规则。P2 采到的数据越多，还原度越高。
2. **最省事的办法：联系作者。** 这是“网页联机复刻（非官方同人作品）”，客户端代码质量很高、文档完整。如果作者愿意提供服务器源码或者离线模式，P3–P5 基本可以直接省掉。建议先试着联系。
3. **版权。** 美术和音频来自《明日方舟》（鹰角网络），前端代码属于复刻作者。离线版只适合个人使用，不要公开分发；资源不要提交到公开仓库，仓库里只放下载器和本地服务器代码，资源由下载器在本地拉取。
4. **版本漂移。** 线上会继续更新（当前 0.1.3）。镜像只是某个时间点的快照，客户端和本地服务器要锁定在同一个协议版本。
5. **线上服务器不太稳定。** 会间歇性返回 502、截断响应。下载器要核对文件大小并重试，并发不宜太高（目前用 6–8 个）。
