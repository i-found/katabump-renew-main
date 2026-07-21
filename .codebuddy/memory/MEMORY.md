# Project Memory

## Katabump Renew - 技术方案

- 原项目为 Python (SeleniumBase) + GitHub Actions 定时签到 katabump.com
- 已迁移至 Node.js (Playwright) + Railway VPS 部署
- 核心依赖: playwright, playwright-extra, puppeteer-extra-plugin-stealth, node-cron
- 通过 Dockerfile (mcr.microsoft.com/playwright) 在 Railway 上构建运行
- 使用 node-cron 替代 GitHub Actions cron 实现每日定时签到
- HTTP 健康检查端点绑定 $PORT 满足 Railway 容器存活要求
- 环境变量: KATABUMP_EMAIL, KATABUMP_PASSWORD, TG_BOT_TOKEN, TG_CHAT_ID, CRON_SCHEDULE, RUN_ON_START, RETRY_MAX, RETRY_DELAY_MS
- **Cloudflare Turnstile 通过的必备条件（关键经验）**：
  1. `INJECTED_SCRIPT` Hook `Element.prototype.attachShadow` 捕获 Shadow DOM 内 checkbox 坐标到 `window.__turnstile_data`
  2. `attemptTurnstileCdp(page)` 用 CDP `Input.dispatchMouseEvent` 发原生鼠标点击（非 Playwright click）
  3. **必须 xvfb 虚拟显示 + `headless: false`**，否则 headless 模式被 Cloudflare 检测导致验证失败
  4. 启动方式：Dockerfile `CMD ["./start.sh"]`，`start.sh` 显式拉起 `Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp` 并 `export DISPLAY=:99` 后再 `exec node index.js`（**不要用 `xvfb-run`**，在 Railway 下会卡在 Starting Container）
  5. index.js `launchBrowser()` 按 `process.env.DISPLAY` 决定 `headless`：有显示用有头，无显示回退 headless，防止 Xvfb 异常时崩溃循环
- 用户另有已验证可用的参考项目 `i-found/katabump`（renew.js），遇到瓶颈优先参考它
- playwright npm 包版本与 Docker 镜像版本必须锁定一致（当前 v1.61.1）
