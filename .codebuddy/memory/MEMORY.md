# Project Memory

## Katabump Renew - 技术方案

- 原项目为 Python (SeleniumBase) + GitHub Actions 定时签到 katabump.com
- 已迁移至 Node.js (Playwright) + Railway VPS 部署
- 核心依赖: playwright, node-cron
- 通过 Dockerfile (mcr.microsoft.com/playwright) 在 Railway 上构建运行
- 使用 node-cron 替代 GitHub Actions cron 实现每日定时签到
- HTTP 健康检查端点绑定 $PORT 满足 Railway 容器存活要求
- 环境变量: KATABUMP_EMAIL, KATABUMP_PASSWORD, TG_BOT_TOKEN, TG_CHAT_ID, CRON_SCHEDULE, RUN_ON_START, RETRY_MAX, RETRY_DELAY_MS
- 包含 Cloudflare Turnstile + ALTCHA 两种验证码自动处理逻辑
- 失败自动重试，默认 3 次，间隔 60 秒
