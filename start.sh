#!/bin/bash
# 启动脚本：拉起 Xvfb 虚拟显示后运行 Node 服务
# 相比 xvfb-run，显式启动 Xvfb 更可控，避免 Railway 环境下容器卡在 Starting Container

# 确保 X11 套接字目录存在（部分精简镜像缺失）
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

# 清理可能残留的 Xvfb 锁文件，防止 :99 被占用导致启动失败
rm -f /tmp/.X99-lock 2>/dev/null || true

# 后台启动 Xvfb，固定 display :99，关闭 TCP 监听
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp > /dev/null 2>&1 &
XVFB_PID=$!

# 等待 Xvfb 就绪（最多 10s），通过套接字文件判断是否已启动
for i in $(seq 1 10); do
  if [ -e /tmp/.X11-unix/X99 ]; then
    break
  fi
  # 若进程已退出则直接继续（随后 node 会以 headless 回退运行）
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[start.sh] 警告: Xvfb 进程提前退出，将以无显示模式回退运行"
    break
  fi
  sleep 1
done

export DISPLAY=:99
echo "[start.sh] Xvfb 已启动 (PID=$XVFB_PID), DISPLAY=:99"

# 运行 Node 服务（exec 保证信号正确传递，便于容器优雅停止）
exec node index.js
