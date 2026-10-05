# 卫戍协议：盟约 · 离线版

把网页游戏 [卫戍协议：盟约（网页联机复刻）](http://103.205.253.194:27527/) 做成**不联网也能玩的单人版**。

原版的前端（界面、战场渲染、战斗模拟）原样保留；联机服务器换成了一个运行在浏览器里的本地服务器（Web Worker），所有对局规则在本地计算。离线版只支持**独立模拟**（4 个难度，含最终攻势和隐秘核心），不支持同盟模拟。

> 仓库里只有工具和本地服务器的代码。游戏客户端和约 360 MB 的美术、音频需要用下载脚本从线上版本取得，不随仓库分发。游戏素材版权归上海鹰角网络 / Yostar 所有，网页复刻属于原作者，本项目仅供个人离线游玩。

## 快速开始

需要 [Node.js](https://nodejs.org) 20 或更高版本，以及一个现代浏览器（推荐 Chrome / Edge）。

```bash
npm install
npm run mirror      # 第一次需要联网：从线上版本下载客户端、数据和全部素材（约 360 MB，可断点续传）
npm start           # 打开 http://127.0.0.1:8080/ 开始游戏（之后完全不需要联网）
```

`npm run mirror` 中途失败时直接重新运行即可，已经下载完整的文件会被跳过。

## 打包成可以单独运行的版本

```bash
npm run build       # 生成 dist/stronghold-offline/（需要电脑上装有 Node.js 才能启动）
npm run build:exe   # 额外生成 Windows 可执行文件 stronghold-offline.exe（别的电脑无需安装 Node.js）
```

把整个 `dist/stronghold-offline` 文件夹复制到任意位置，双击 `启动游戏.bat`（Windows）或运行 `start.sh`（Linux / macOS）。启动后浏览器会自动打开 `http://127.0.0.1:27527/`，关闭启动器窗口即退出。

- 存档在浏览器里，按地址区分。对局进行中关闭页面或刷新，重新打开后会接着打。
- 可执行文件是用 Node.js 官方的 single executable application 方式生成的，没有数字签名，Windows 第一次运行时可能会弹出 SmartScreen 提示。

## 目录说明

| 路径 | 内容 |
|---|---|
| `offline/shim.js` | 在页面里替换 `WebSocket`，把游戏连接 `/ws` 转给本地服务器 |
| `offline/worker.js` | 本地服务器的 Worker 入口：加载数据、恢复存档、转发消息 |
| `offline/server/` | 本地服务器：会话、房间、对局阶段、商店、卡池、合成、羁绊、波次、机变、结算、效果分发 |
| `tools/mirror/` | 下载器：客户端代码、数据、素材清单里的全部文件、Google 字体 |
| `tools/serve.mjs` | 开发用静态服务器（自动注入 shim） |
| `tools/build.mjs` | 打包成独立文件夹 / 可执行文件 |
| `test/` | Node 单元测试、无界面整局对战、浏览器端到端测试 |
| `docs/` | 探查报告、开发计划、实现说明和假设清单 |

## 测试

```bash
npm test            # 服务器单元测试（经济、合成、放置、接管、断线重连、存档恢复、机变）
node test/play.mjs NORMAL 1 --rich     # 无界面完整对局（--rich：测试用资金，能打到隐秘核心）
npm run e2e -- --rounds 3 --reload     # 浏览器端到端：真实客户端，屏蔽所有外网请求，含刷新恢复
```

实现细节、和原版可能不一致的地方，见 [docs/offline-notes.md](docs/offline-notes.md)。
