/**
 * Katabump 自动续期服务 (Node.js / Railway)
 *
 * 每天定时使用 Playwright 自动化登录 katabump.com 并执行续期操作，
 * 获取 4 天使用权限。通过 Telegram Bot 推送续期结果通知。
 */

const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cron = require("node-cron");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");

// 挂载隐身插件 — 绕过 Cloudflare / Turnstile 的自动化检测
chromium.use(StealthPlugin());

// ============================================================
// 配置 — 全部通过 Railway 环境变量注入
// ============================================================
const EMAIL = process.env.KATABUMP_EMAIL || "";
const PASSWORD = process.env.KATABUMP_PASSWORD || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const BASE_URL = "https://dashboard.katabump.com";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 0 * * *"; // 默认 UTC 0:00（北京 8:00）
const RUN_ON_START = process.env.RUN_ON_START !== "false";       // 启动时是否立刻执行一次
const RETRY_MAX = parseInt(process.env.RETRY_MAX || "3", 10);    // 最大重试次数
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || "60000", 10); // 重试间隔
const PORT = parseInt(process.env.PORT || "3000", 10);           // HTTP 健康检查端口

// ============================================================
// 日志工具 — 带时间戳的日志输出
// ============================================================
function log(level, ...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const prefix = `[${ts}] [${level}]`;
  if (level === "ERROR") {
    console.error(prefix, ...args);
  } else if (level === "WARN") {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

const logger = {
  info: (...a) => log("INFO", ...a),
  warn: (...a) => log("WARN", ...a),
  error: (...a) => log("ERROR", ...a),
  success: (...a) => log("SUCCESS", ...a),
  step: (...a) => log("STEP", ...a),
};

// ============================================================
// HTTP 健康检查服务 — Railway 需要容器监听 PORT
// ============================================================
function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
  });
  server.listen(PORT, "0.0.0.0", () => {
    logger.info(`健康检查服务已启动 -> 0.0.0.0:${PORT}`);
  });
  return server;
}

// ============================================================
// Telegram 通知推送
// ============================================================
async function sendTgMessage(statusIcon, statusText, timeLeft = "") {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    logger.info("未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过 Telegram 推送。");
    return;
  }

  // 邮箱脱敏
  let maskedEmail = EMAIL;
  if (EMAIL.includes("@")) {
    const [name, domain] = EMAIL.split("@");
    maskedEmail = name.length > 4
      ? `${name.slice(0, 2)}****${name.slice(-2)}@${domain}`
      : `${name}@${domain}`;
  } else if (EMAIL.length > 4) {
    maskedEmail = EMAIL.slice(0, 2) + "****" + EMAIL.slice(-2);
  }

  // 北京时间
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const currentTime = now.toISOString().replace("T", " ").slice(0, 19);

  const text = [
    "🇫🇷 katabump 续期通知",
    "",
    `${statusIcon} ${statusText}`,
    `👤 续期账户: ${maskedEmail}`,
    `⏱️ 续期时间: ${currentTime}`,
    timeLeft ? `📋 ${timeLeft}` : "",
  ].filter(Boolean).join("\n");

  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      logger.info("Telegram 通知发送成功！");
    } else {
      logger.warn(`Telegram 通知发送失败: HTTP ${resp.status} ${await resp.text()}`);
    }
  } catch (e) {
    logger.error(`Telegram 通知发送异常: ${e.message}`);
  }
}

// ============================================================
// JS 注入脚本（从 Python 版本迁移）
// ============================================================

// 展开 Cloudflare Turnstile 的隐藏容器
const EXPAND_JS = `
(() => {
  const ts = document.querySelector('input[name="cf-turnstile-response"]');
  if (!ts) return 'no-turnstile';
  let el = ts;
  for (let i = 0; i < 20; i++) {
    el = el.parentElement;
    if (!el) break;
    const s = getComputedStyle(el);
    if (s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflowY === 'hidden')
      el.style.overflow = 'visible';
    el.style.minWidth = 'max-content';
  }
  document.querySelectorAll('iframe').forEach(f => {
    if (f.src && f.src.includes('challenges.cloudflare.com')) {
      f.style.width = '300px'; f.style.height = '65px';
      f.style.minWidth = '300px';
      f.style.visibility = 'visible'; f.style.opacity = '1';
    }
  });
  return 'done';
})()
`;

// 检测 Turnstile 是否存在
const EXISTS_JS = `(() => document.querySelector('input[name="cf-turnstile-response"]') !== null)()`;

// 检测 Turnstile 是否已通过
const SOLVED_JS = `(() => {
  const i = document.querySelector('input[name="cf-turnstile-response"]');
  return !!(i && i.value && i.value.length > 20);
})()`;

// 在模态框中展开 ALTCHA iframe
const ALTCHA_EXPAND_JS = `(() => {
  const modal = document.querySelector('div.modal.show') || document;
  const iframes = modal.querySelectorAll('iframe');
  for (const iframe of iframes) {
    const r = iframe.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      iframe.style.width = '300px';
      iframe.style.height = '150px';
      iframe.style.minWidth = '300px';
      iframe.style.minHeight = '150px';
      iframe.style.visibility = 'visible';
      iframe.style.opacity = '1';
      let el = iframe;
      for (let j = 0; j < 10; j++) {
        el = el.parentElement;
        if (!el) break;
        el.style.overflow = 'visible';
      }
      const r2 = iframe.getBoundingClientRect();
      return { cx: Math.round(r2.x + 30), cy: Math.round(r2.y + r2.height / 2) };
    }
  }
  return null;
})()`;

// 检测 ALTCHA 是否已验证通过
const ALTCHA_SOLVED_JS = `(() => {
  const modal = document.querySelector('div.modal.show') || document;
  // hidden input 有值
  for (const inp of modal.querySelectorAll('input[type="hidden"]')) {
    const n = (inp.name || '').toLowerCase();
    if ((n.includes('altcha') || n.includes('captcha')) && inp.value && inp.value.length > 20)
      return true;
  }
  // checkbox 变为 disabled
  for (const cb of modal.querySelectorAll('input[type="checkbox"]')) {
    if (cb.disabled) return true;
  }
  // widget data-state 属性
  if (modal.querySelector('[data-state="verified"],.altcha--verified,.altcha-verified'))
    return true;
  return false;
})()`;

// ============================================================
// Turnstile Shadow DOM Hook 注入脚本（核心：拦截 attachShadow 捕获 checkbox 坐标）
// 参考原项目 i-found/katabump（renew.js）的 INJECTED_SCRIPT
// ============================================================
const INJECTED_SCRIPT = `
(() => {
  // 只在 iframe 中运行（Turnstile 通常在 iframe 里）
  if (window.self === window.top) return;

  // 模拟鼠标屏幕坐标，降低自动化检测概率
  try {
    function getRandomInt(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    const screenX = getRandomInt(800, 1200);
    const screenY = getRandomInt(400, 600);
    Object.defineProperty(MouseEvent.prototype, "screenX", { value: screenX });
    Object.defineProperty(MouseEvent.prototype, "screenY", { value: screenY });
  } catch (e) { /* ignore */ }

  // Hook attachShadow：Turnstile 创建 Shadow DOM 时捕获 checkbox 位置
  try {
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const shadowRoot = originalAttachShadow.call(this, init);
      if (shadowRoot) {
        const checkAndReport = () => {
          const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
          if (checkbox) {
            const rect = checkbox.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
              const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
              const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
              window.__turnstile_data = { xRatio, yRatio };
              return true;
            }
          }
          return false;
        };
        if (!checkAndReport()) {
          const observer = new MutationObserver(() => {
            if (checkAndReport()) observer.disconnect();
          });
          observer.observe(shadowRoot, { childList: true, subtree: true });
        }
      }
      return shadowRoot;
    };
  } catch (e) { /* ignore */ }
})();
`;

// ============================================================
// CDP 原生鼠标点击（绕过自动化检测，参考原项目 attemptTurnstileCdp）
// ============================================================
async function attemptTurnstileCdp(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
      if (data) {
        const iframeElement = await frame.frameElement();
        if (!iframeElement) continue;
        const box = await iframeElement.boundingBox();
        if (!box) continue;

        const clickX = box.x + box.width * data.xRatio;
        const clickY = box.y + box.height * data.yRatio;
        logger.info(`CDP 计算坐标: (${clickX.toFixed(1)}, ${clickY.toFixed(1)}) ratio=(${data.xRatio.toFixed(3)},${data.yRatio.toFixed(3)})`);

        const client = await page.context().newCDPSession(page);
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: clickX,
          y: clickY,
          button: "left",
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: clickX,
          y: clickY,
          button: "left",
          clickCount: 1,
        });
        await client.detach();
        return true;
      }
    } catch (e) {
      /* 忽略跨域 frame 访问错误 */
    }
  }
  return false;
}

// ============================================================
// 浏览器启动（直接 spawn 干净 Chrome + connectOverCDP，对齐参考项目 i-found/katabump）
// ============================================================
const CHROME_DEBUG_PORT = parseInt(process.env.CHROME_DEBUG_PORT || "9222", 10);
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || "/tmp/chrome-profile-katabump";

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/opt/google/chrome/google-chrome",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) { /* ignore */ }
  }
  return null;
}

async function waitForDebugPort(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function launchBrowser() {
  // 有虚拟显示则用「有头模式」绕过 Cloudflare headless 检测；无显示回退 headless，避免崩溃循环。
  const hasDisplay = !!process.env.DISPLAY;
  const headless = hasDisplay ? false : true;
  const chromePath = findChromeBinary();

  // 关键（对齐参考项目 i-found/katabump）：直接 spawn 一个干净的真 Chrome 进程
  // （只带 --remote-debugging-port，无 Playwright launch 附加的自动化痕迹），再 connectOverCDP 接管。
  logger.info(
    `启动浏览器: spawn 真 Chrome (${chromePath || "未找到,回退launch"}) + connectOverCDP, headless=${headless}, DISPLAY=${process.env.DISPLAY || "无"}...`
  );

  if (chromePath) {
    try {
      const args = [
        `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
        `--user-data-dir=${CHROME_USER_DATA_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1920,1080",
        "--start-maximized",
      ];
      if (headless) args.push("--headless=new");

      const chromeProc = spawn(chromePath, args, { detached: false, stdio: "ignore" });
      const ready = await waitForDebugPort(CHROME_DEBUG_PORT, 20000);
      if (!ready) throw new Error("Chrome 调试端口 20s 未就绪");

      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
      const context = browser.contexts()[0];
      await context.addInitScript(INJECTED_SCRIPT);
      const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
      return { browser, context, page, chromeProc };
    } catch (e) {
      logger.warn(`spawn+connectOverCDP 失败(${e.message})，回退 playwright launch(channel=chrome)...`);
    }
  }

  // 回退：playwright 直接 launch 真 Chrome 内核
  const browser = await chromium.launch({
    channel: "chrome",
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "Asia/Shanghai",
  });
  await context.addInitScript(INJECTED_SCRIPT);
  const page = await context.newPage();
  return { browser, context, page, chromeProc: null };
}

// ============================================================
// 辅助：JS 填充输入框（模拟真实输入事件）
// ============================================================
async function jsFillInput(page, selector, text) {
  const safeText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await page.evaluate(
    ({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const nativeSetter =
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        ).set;
      if (nativeSetter) {
        nativeSetter.call(el, val);
      } else {
        el.value = val;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { sel: selector, val: safeText }
  );
}

// ============================================================
// 检测 Turnstile 是否已通过（双信号，对齐参考项目）
// ============================================================
async function isTurnstileSolved(page) {
  // 信号1: cf-turnstile-response hidden input 被填充
  try {
    if (await page.evaluate(SOLVED_JS)) return true;
  } catch (e) { /* ignore */ }
  // 信号2: cloudflare frame 中出现 "Success!" 文本（参考项目的判定方式）
  for (const f of page.frames()) {
    if (f.url().includes("cloudflare")) {
      try {
        if (await f.getByText("Success!", { exact: false }).isVisible({ timeout: 300 })) return true;
      } catch (e) { /* ignore */ }
    }
  }
  return false;
}

// ============================================================
// 处理 Cloudflare Turnstile 验证（重写版：精准访问 cloudflare frame）
// ============================================================
async function handleTurnstile(page) {
  logger.step("处理 Cloudflare Turnstile 验证...");
  await page.waitForTimeout(3000);

  // 检查是否已静默通过
  if (await isTurnstileSolved(page)) {
    logger.success("Turnstile 已静默通过");
    return true;
  }

  // 展开 Turnstile 容器
  for (let i = 0; i < 3; i++) {
    try { await page.evaluate(EXPAND_JS); } catch (e) { /* ignore */ }
    await page.waitForTimeout(500);
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    if (await isTurnstileSolved(page)) {
      logger.success(`Turnstile 通过（第 ${attempt + 1} 次尝试）`);
      return true;
    }

    logger.info(`第 ${attempt + 1} 次尝试解决 Turnstile...`);

    // 通过 CDP 注入原生鼠标点击（绕过自动化检测），最多轮询 15 次等待 checkbox 出现
    let cdpClickResult = false;
    for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
      cdpClickResult = await attemptTurnstileCdp(page);
      if (cdpClickResult) break;
      await page.waitForTimeout(1000);
    }

    if (cdpClickResult) {
      logger.info("CDP 点击已发送，等待 Cloudflare 验证（最多 12s）...");
      for (let w = 0; w < 24; w++) {
        await page.waitForTimeout(500);
        if (await isTurnstileSolved(page)) {
          logger.success(`Turnstile 通过（第 ${attempt + 1} 次尝试, ${((w + 1) * 0.5).toFixed(1)}s）`);
          return true;
        }
      }
    } else {
      logger.warn("未检测到 Turnstile checkbox（CDP 注入脚本未捕获）");
    }

    logger.warn(`第 ${attempt + 1} 次未通过（等待超时）`);
    try { await page.evaluate(EXPAND_JS); } catch (e) { /* ignore */ }
    await page.waitForTimeout(2000 + attempt * 1000);
  }

  logger.error("Turnstile 验证 4 次均失败");
  try {
    await page.screenshot({ path: "/tmp/turnstile_fail.png", fullPage: false });
    logger.info("截图已保存到 /tmp/turnstile_fail.png");
  } catch {}
  return false;
}

// ============================================================
// 登录流程
// ============================================================
async function login(page) {
  logger.step(`打开登录页面: ${BASE_URL}/auth/login`);
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);

  // 等待 Cloudflare 验证通过（最多 30 秒）
  logger.info("等待 Cloudflare 验证通过...");
  let cfPassed = false;
  for (let i = 0; i < 30; i++) {
    const pageSrc = (await page.content()).toLowerCase();
    if (pageSrc.includes('name="email"') || pageSrc.includes('input[name="email"]')) {
      cfPassed = true;
      logger.success(`Cloudflare 验证已通过（${i + 1}s）`);
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!cfPassed) {
    logger.warn("Cloudflare 验证可能未通过，继续尝试登录...");
  }

  // 等待登录表单出现
  try {
    await page.waitForSelector('input[name="email"]', { timeout: 15000 });
  } catch {
    try {
      await page.waitForSelector('input[name="Email"]', { timeout: 5000 });
    } catch {
      logger.error("页面未加载出登录表单");
      logger.error(`当前 URL: ${page.url()}`);
      logger.error(`当前标题: ${await page.title()}`);
      await page.screenshot({ path: "login_load_fail.png" }).catch(() => {});
      return false;
    }
  }

  // 关闭 Cookie 弹窗
  logger.info("关闭可能的 Cookie 弹窗...");
  try {
    const buttons = await page.$$("button");
    for (const btn of buttons) {
      const text = (await btn.textContent()) || "";
      if (text.toLowerCase().includes("accept")) {
        await btn.click();
        await page.waitForTimeout(500);
        break;
      }
    }
  } catch (e) {
    /* ignore */
  }

  // 填写邮箱和密码
  logger.step("填写邮箱...");
  await jsFillInput(page, 'input[name="email"]', EMAIL);
  await page.waitForTimeout(300);

  logger.step("填写密码...");
  await jsFillInput(page, 'input[name="password"]', PASSWORD);
  await page.waitForTimeout(1000);

  // 等待 Turnstile 验证框出现
  logger.info("等待 Turnstile 验证框出现...");
  let tsFound = false;
  for (let i = 0; i < 10; i++) {
    if (await page.evaluate(EXISTS_JS)) {
      tsFound = true;
      logger.success(`检测到 Turnstile（${i + 1}s）`);
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (tsFound) {
    if (!(await handleTurnstile(page))) {
      logger.error("登录界面的 Turnstile 验证失败");
      await page.screenshot({ path: "login_turnstile_fail.png" }).catch(() => {});
      return false;
    }
  } else {
    logger.info("未检测到 Turnstile");
  }

  // 提交登录
  logger.step("敲击回车提交表单...");
  await page.focus('input[name="password"]');
  await page.keyboard.press("Enter");

  // 等待登录跳转
  logger.info("等待登录跳转...");
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    const curUrl = page.url().split("?")[0].toLowerCase();
    const title = (await page.title()).toLowerCase();
    if (curUrl.startsWith(`${BASE_URL}/dashboard`) || title.includes("dashboard | katabump")) {
      break;
    }
  }

  const curUrl = page.url().split("?")[0].toLowerCase();
  const title = (await page.title()).toLowerCase();
  if (curUrl.startsWith(`${BASE_URL}/dashboard`) || title.includes("dashboard | katabump")) {
    logger.success(`登录成功！(URL: ${page.url()}, Title: ${await page.title()})`);
    return true;
  }

  logger.error(`登录失败，页面未跳转到账户页。(URL: ${page.url()}, Title: ${await page.title()})`);
  await page.screenshot({ path: "login_failed.png" }).catch(() => {});
  return false;
}

// ============================================================
// 续期流程
// ============================================================

/** 读取页面第一个 Bootstrap alert 文本 */
async function readAlert(page) {
  try {
    const el = await page.$("div.alert");
    if (el) {
      const text = await el.textContent();
      return (text || "").trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** 在 Dashboard 首页点击 See 进入服务器详情页 */
async function gotoServerDetail(page) {
  logger.step("正在进入服务器续期页...");
  await page.waitForTimeout(5000);

  // 检查"还无法续期"提示
  const alertText = await readAlert(page);
  if (alertText && /can't renew/i.test(alertText)) {
    logger.info(`页面顶部提示: ${alertText}`);
    await sendTgMessage("ℹ️", "⚠️ 未到续期时间", alertText);
    return false;
  }

  // 查找 See 链接
  const selectors = [
    'a[href*="/servers/edit?id="]',
    'td a[href*="/servers/edit"]',
    'table a[href*="/servers/edit"]',
    "table td a",
  ];

  let seeLink = null;
  for (const sel of selectors) {
    try {
      seeLink = await page.$(sel);
      if (seeLink) {
        logger.success(`通过选择器找到链接: ${sel}`);
        break;
      }
    } catch {
      /* continue */
    }
    // waitForSelector with short timeout as fallback
    try {
      seeLink = await page.waitForSelector(sel, { timeout: 3000 });
      if (seeLink) {
        logger.success(`通过选择器找到链接: ${sel}`);
        break;
      }
    } catch {
      /* continue */
    }
  }

  // 文本匹配
  if (!seeLink) {
    logger.warn("选择器未命中，尝试文本匹配...");
    const links = await page.$$("a");
    for (const a of links) {
      const text = ((await a.textContent()) || "").trim().toLowerCase();
      if (text === "see") {
        seeLink = a;
        logger.success("通过文本 'See' 找到链接");
        break;
      }
    }
  }

  if (!seeLink) {
    logger.error(`未找到 'See' 链接`);
    logger.error(`当前 URL: ${page.url()}`);
    logger.error(`页面标题: ${await page.title()}`);
    try {
      const links = await page.$$("a");
      logger.info(`页面共 ${links.length} 个链接:`);
      for (const a of links.slice(0, 20)) {
        const href = (await a.getAttribute("href")) || "";
        const txt = ((await a.textContent()) || "").trim().slice(0, 30);
        if (href) logger.info(`  - [${txt}] -> ${href}`);
      }
    } catch {
      /* ignore */
    }
    await page.screenshot({ path: "servers_page_fail.png" }).catch(() => {});
    return false;
  }

  logger.step("点击 'See' 进入服务器详情页...");
  await seeLink.click();
  await page.waitForTimeout(5000);
  logger.info(`当前页面: ${page.url()}`);
  return true;
}

/** 点击 Renew 按钮打开模态框 */
async function openRenewModal(page) {
  logger.step("查找 Renew 按钮...");
  let renewBtn = null;
  try {
    renewBtn = await page.waitForSelector(
      'button[data-bs-target="#renew-modal"]',
      { timeout: 10000 }
    );
  } catch {
    try {
      renewBtn = await page.waitForSelector(
        "button.btn.btn-outline-primary",
        { timeout: 5000 }
      );
    } catch {
      logger.error("未找到 Renew 按钮");
      return false;
    }
  }

  // 滚动到按钮
  await page.evaluate(() => {
    const btn =
      document.querySelector('button[data-bs-target="#renew-modal"]') ||
      document.querySelector("button.btn.btn-outline-primary");
    if (btn) btn.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  await page.waitForTimeout(800);

  await renewBtn.click();
  logger.step("已点击 Renew 按钮，等待 ALTCHA 验证框...");
  await page.waitForTimeout(3000);

  try {
    await page.waitForSelector("div.modal.show", { timeout: 5000 });
    logger.success("Renew 模态框已弹出");
  } catch {
    logger.warn("模态框未弹出");
    return false;
  }

  // Renew 模态框内的 Turnstile 同样用 CDP 原生点击处理
  logger.step("处理 Renew 模态框内 Turnstile...");
  let cdpResult = false;
  for (let findAttempt = 0; findAttempt < 20; findAttempt++) {
    cdpResult = await attemptTurnstileCdp(page);
    if (cdpResult) break;
    await page.waitForTimeout(1000);
  }
  if (cdpResult) {
    logger.info("Renew 模态框 Turnstile CDP 点击已发送，等待验证...");
    await page.waitForTimeout(8000);
  } else {
    logger.warn("Renew 模态框未检测到 Turnstile（可能无需验证）");
  }

  return true;
}

/** 处理 ALTCHA 人机验证 */
async function solveAltcha(page) {
  logger.step("处理 ALTCHA 人机验证...");
  await page.waitForTimeout(2000);

  // 检查是否已自动通过
  if (await page.evaluate(ALTCHA_SOLVED_JS)) {
    logger.success("ALTCHA 已自动通过");
    return true;
  }

  // 展开模态框内 iframe 并获取坐标
  let coords = null;
  try {
    coords = await page.evaluate(ALTCHA_EXPAND_JS);
  } catch {
    /* ignore */
  }
  if (coords) {
    logger.info(`找到模态框内 iframe 坐标: (${coords.cx}, ${coords.cy})`);
  }

  // 最多尝试 3 轮
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await page.evaluate(ALTCHA_SOLVED_JS)) {
      logger.success(`ALTCHA 验证通过（第 ${attempt + 1} 轮）`);
      return true;
    }

    // 策略 1: Playwright 鼠标点击 iframe 坐标
    if (coords) {
      try {
        await page.mouse.click(coords.cx, coords.cy);
        logger.info(`Playwright 点击 ALTCHA (${coords.cx}, ${coords.cy})`);
      } catch (e) {
        logger.warn(`ALTCHA 坐标点击失败: ${e.message}`);
      }
    }

    // 策略 2: SeleniumBase 风格 JS 点击
    await page.evaluate(() => {
      const modal = document.querySelector("div.modal.show");
      if (!modal) return;
      // 点击 iframe
      for (const iframe of modal.querySelectorAll("iframe")) {
        iframe.click();
        iframe.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      // 点击含验证关键词的 label
      for (const label of modal.querySelectorAll("label")) {
        const txt = (label.textContent || "").toLowerCase();
        if (/robot|captcha|verify/i.test(txt)) label.click();
      }
      // 点击未禁用的 checkbox
      for (const cb of modal.querySelectorAll('input[type="checkbox"]')) {
        if (!cb.disabled) {
          cb.click();
          cb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
      }
    });

    // 等待验证结果
    for (let w = 0; w < 6; w++) {
      await page.waitForTimeout(1000);
      if (await page.evaluate(ALTCHA_SOLVED_JS)) {
        logger.success(`ALTCHA 验证通过（第 ${attempt + 1} 轮）`);
        return true;
      }
    }

    logger.warn(`第 ${attempt + 1} 轮未通过，重试...`);
    // 重新获取坐标
    try {
      const newCoords = await page.evaluate(ALTCHA_EXPAND_JS);
      if (newCoords) coords = newCoords;
    } catch {
      /* ignore */
    }
  }

  logger.error("ALTCHA 验证 3 轮均失败");
  return false;
}

/** 点击模态框内的 Renew 提交按钮 */
async function submitRenew(page) {
  logger.step("点击模态框中的 Renew 按钮...");
  try {
    const submit = await page.waitForSelector(
      "div.modal.show button.btn-primary",
      { timeout: 5000 }
    );
    await submit.click();
  } catch {
    // JS 兜底
    await page.evaluate(() => {
      const modal = document.querySelector("div.modal.show");
      if (!modal) return;
      for (const btn of modal.querySelectorAll("button")) {
        if (/renew/i.test(btn.textContent)) btn.click();
      }
    });
  }
  await page.waitForTimeout(3000);
}

/** 检查续期结果并推送通知 */
async function checkRenewResult(page) {
  logger.step("检查续期结果...");
  let alertText = await readAlert(page);
  if (!alertText) {
    await page.waitForTimeout(3000);
    alertText = await readAlert(page);
  }

  if (alertText) {
    logger.info(`页面提示: ${alertText}`);
    const low = alertText.toLowerCase();
    if (/can't renew|unable/i.test(low)) {
      await sendTgMessage("⏳", "未到续期时间", alertText);
    } else if (/renewed|success|extended/i.test(low)) {
      await sendTgMessage("✅", "续期成功", alertText);
    } else {
      await sendTgMessage("ℹ️", "续期操作已执行", alertText);
    }
  } else {
    logger.info("未检测到明确的提示框，可能续期操作未生效");
    await sendTgMessage("ℹ️", "续期操作已执行", "未检测到明确提示");
  }
}

/** 续期主流程 */
async function renewServer(page) {
  logger.step("=".repeat(25));
  logger.step("  开始自动续期流程");
  logger.step("=".repeat(25));

  if (!(await gotoServerDetail(page))) return;
  if (!(await openRenewModal(page))) return;

  const altchaOk = await solveAltcha(page);
  if (!altchaOk) {
    logger.warn("ALTCHA 验证未通过，仍尝试提交 Renew...");
  }

  await submitRenew(page);
  await checkRenewResult(page);
}

// ============================================================
// 单次签到完整流程
// ============================================================
async function doCheckIn() {
  logger.info("#".repeat(25));
  logger.info("   katabump 自动登录续期 (Node.js/Playwright)");
  logger.info("#".repeat(25));

  let browser = null;
  let context = null;
  let chromeProc = null;

  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    context = launched.context;
    chromeProc = launched.chromeProc || null;
    const { page } = launched;

    // 显示出口 IP
    try {
      await page.goto("https://api.ip.sb/ip", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      logger.info(`当前出口 IP: ${await page.textContent("body")}`);
    } catch (e) {
      logger.warn(`获取出口 IP 失败: ${e.message}`);
    }

    // 登录
    if (await login(page)) {
      await renewServer(page);
    } else {
      logger.error("登录失败，终止后续续期操作。");
      await sendTgMessage("❌", "登录失败", "未知");
    }
  } catch (e) {
    logger.error(`签到流程异常: ${e.message}`);
    await sendTgMessage("❌", "签到异常", e.message);
  } finally {
    if (context) {
      try { await context.close(); } catch (e) { /* ignore */ }
    }
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    // 杀掉直接 spawn 的 Chrome 进程，避免重试时 9222 端口冲突
    if (chromeProc) {
      try { chromeProc.kill("SIGKILL"); } catch (e) { /* ignore */ }
    }
    logger.info("浏览器已关闭");
  }
}

// ============================================================
// 带重试的签到执行
// ============================================================
async function doCheckInWithRetry() {
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    logger.info(`----- 第 ${attempt}/${RETRY_MAX} 次签到尝试 -----`);
    try {
      await doCheckIn();
      logger.success(`签到流程完成（第 ${attempt} 次尝试）`);
      return; // 成功则退出
    } catch (e) {
      logger.error(`第 ${attempt} 次签到异常: ${e.message}`);
      if (attempt < RETRY_MAX) {
        logger.info(`等待 ${RETRY_DELAY_MS / 1000}s 后重试...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  logger.error(`已重试 ${RETRY_MAX} 次，全部失败`);
  await sendTgMessage("❌", `签到全部失败（重试${RETRY_MAX}次）`);
}

// ============================================================
// 启动入口
// ============================================================
async function main() {
  logger.info("===== Katabump Auto Renew Service =====");
  logger.info(`环境: Node.js ${process.version}`);
  logger.info(`定时: ${CRON_SCHEDULE} (UTC)`);
  logger.info(`启动即执行: ${RUN_ON_START}`);
  logger.info(`最大重试: ${RETRY_MAX} 次, 间隔 ${RETRY_DELAY_MS / 1000}s`);

  if (!EMAIL || !PASSWORD) {
    logger.error("缺少必填环境变量 KATABUMP_EMAIL 或 KATABUMP_PASSWORD，无法运行！");
    process.exit(1);
  }

  // 启动健康检查 HTTP 服务
  startHealthServer();

  // 启动时立即执行一次
  if (RUN_ON_START) {
    logger.info("启动后立即执行一次签到...");
    await doCheckInWithRetry();
  }

  // 注册定时任务（node-cron）
  if (cron.validate(CRON_SCHEDULE)) {
    cron.schedule(CRON_SCHEDULE, async () => {
      logger.info(`定时任务触发 (${CRON_SCHEDULE} UTC)`);
      await doCheckInWithRetry();
    });
    logger.info(`定时任务已注册: ${CRON_SCHEDULE} (UTC)`);
  } else {
    logger.error(`无效的 CRON 表达式: ${CRON_SCHEDULE}，将仅执行一次后退出`);
  }

  // 保持进程运行（node-cron 自身会保持事件循环）
  logger.info("服务已就绪，等待定时任务触发...");
}

// 全局异常捕获
process.on("unhandledRejection", (reason) => {
  logger.error(`未捕获的 Promise 异常: ${reason}`);
});

process.on("uncaughtException", (err) => {
  logger.error(`未捕获的异常: ${err.message}`);
  // 不退出，保持服务运行
});

// 启动
main().catch((e) => {
  logger.error(`启动失败: ${e.message}`);
  process.exit(1);
});
