# 🚀 katabump 自动续期（Railway VPS）

基于 Node.js + Playwright 的自动化签到服务，部署在 Railway 上每天定时登录 [katabump](https://dashboard.katabump.com) 并完成续期，获取 4 天使用权限。

---

## 🔐 环境变量配置（Railway Variables）

| 变量名 | 必填 | 说明 |
|---|---|---|
| `KATABUMP_EMAIL` | ✅ 必填 | katabump 登录邮箱 |
| `KATABUMP_PASSWORD` | ✅ 必填 | katabump 登录密码 |
| `TG_BOT_TOKEN` | 可选 | Telegram Bot Token（签到结果通知） |
| `TG_CHAT_ID` | 可选 | Telegram Chat ID（接收通知） |
| `CRON_SCHEDULE` | 可选 | Cron 表达式（UTC），默认 `0 0 * * *`（北京 8:00） |
| `RUN_ON_START` | 可选 | 启动时立即签到一次，默认 `true` |
| `RETRY_MAX` | 可选 | 失败最大重试次数，默认 `3` |
| `RETRY_DELAY_MS` | 可选 | 重试间隔（毫秒），默认 `60000` |

---

## 📦 Railway 部署步骤

1. Fork 或上传本项目到 GitHub
2. 在 [Railway](https://railway.app) 新建项目，选择 **Deploy from GitHub repo**
3. Railway 会自动检测 `Dockerfile` 并使用 Playwright 镜像构建
4. 在项目 **Variables** 中配置上述环境变量（至少填 `KATABUMP_EMAIL` 和 `KATABUMP_PASSWORD`）
5. 部署完成后，服务会自动启动并在每天 UTC 0:00 执行签到

---

## ⏰ Cron 表达式参考

| 表达式 | 说明 |
|---|---|
| `0 0 * * *` | 每天 UTC 0:00（北京 8:00） |
| `0 2 * * *` | 每天 UTC 2:00（北京 10:00） |
| `0 0 */3 * *` | 每 3 天 UTC 0:00 |
| `30 8 * * *` | 每天 UTC 8:30（北京 16:30） |

---

## 🖥️ 本地开发

```bash
npm install
npx playwright install chromium
KATABUMP_EMAIL=your@email.com KATABUMP_PASSWORD=yourpass node index.js
```

---

## 📋 日志查看

在 Railway 控制面板的 **Deployments → View Logs** 中可实时查看签到日志。日志格式：

```
[2026-07-22 08:00:01] [INFO] ===== Katabump Auto Renew Service =====
[2026-07-22 08:00:01] [INFO] 定时: 0 0 * * * (UTC)
[2026-07-22 08:00:02] [STEP] 开始自动续期流程
[2026-07-22 08:00:05] [SUCCESS] 登录成功！
[2026-07-22 08:00:10] [SUCCESS] 续期成功
```

---

## 🛡️ 注意事项

- 服务作为常驻后台进程运行，通过 `node-cron` 驱动定时任务
- 内置 HTTP 健康检查端点（监听 `$PORT`），确保 Railway 不回收容器
- 网络请求失败自动重试（默认 3 次，间隔 60 秒）
- 浏览器在 headless 模式下运行，无需图形界面
