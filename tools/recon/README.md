# 线上版本探查脚本

用途：开发计划 P2（协议采样），见 `docs/offline-plan.md`。静态代码和数据已经可以直接用 curl 抓取，这个脚本主要用来**录制真实对局的 WebSocket 帧**，以便还原服务器消息的字段结构。

用 Chromium 打开线上游戏，把离线化所需的信息全部抓下来：所有静态资源、每个 HTTP 请求、WebSocket 帧、localStorage/Cookie、控制台输出、HAR 和截图。

```bash
npm i -D playwright
npx playwright install chromium
node tools/recon/recon.mjs http://103.205.253.194:27527/ 300   # 抓 300 秒
```

运行时会弹出浏览器窗口，请在窗口里**正常玩一遍**（登录、开局、打开各菜单、存档/读档等），覆盖到的功能越多，抓到的接口越全。

结果在 `recon-output/`，提交到仓库后就能据此分析出资源清单和后端接口。
