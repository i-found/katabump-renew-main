FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Copy package files and install dependencies (use npm install since no lockfile)
COPY package.json ./
RUN npm install --omit=dev

# 安装 xvfb 虚拟显示器：让 Chrome 以「有头模式」运行，绕过 Cloudflare 对 headless 的检测
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# Copy application code
COPY . .

# Railway injects PORT env var
EXPOSE 3000

# 用 xvfb-run 包裹 node，提供虚拟显示（1920x1080），Chrome 以有头模式运行
CMD ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", "node", "index.js"]
