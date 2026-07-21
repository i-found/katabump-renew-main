FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Copy package files and install dependencies (use npm install since no lockfile)
COPY package.json ./
RUN npm install --omit=dev

# 安装 xvfb 虚拟显示器：让 Chrome 以「有头模式」运行，绕过 Cloudflare 对 headless 的检测
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# 安装真 Google Chrome（playwright 的 chrome channel）：真内核指纹比内置 Chromium 更难被 Cloudflare 识别
RUN npx playwright install --with-deps chrome

# Copy application code
COPY . .

# 修正 Windows 换行符并赋予启动脚本可执行权限
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

# Railway injects PORT env var
EXPOSE 3000

# 通过 start.sh 先拉起 Xvfb 虚拟显示，再运行 node（Chrome 以有头模式运行，绕过 Cloudflare headless 检测）
CMD ["./start.sh"]
