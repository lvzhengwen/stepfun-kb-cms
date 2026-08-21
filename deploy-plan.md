# StepFun 知识库管理后台 · Lighthouse 部署方案

> 目标实例：`lhins-oxos7gju`（Hermes Agent-bQFX）
> 地域：北京 ap-beijing-7 ｜ 公网 IP：82.157.30.126 ｜ 配置：2C2G / 50GB SSD / 4Mbps
> 应用端口：4040（`server.js`，由 `.env` 的 `PORT` 控制）

---

## 一、部署架构

```
浏览器
   │  HTTP / HTTPS（80 / 443）
   ▼
Nginx 反向代理
   │  proxy_pass http://127.0.0.1:4040
   │  WebSocket 升级透传（Upgrade / Connection）
   ▼
Node.js 应用（PM2 守护，127.0.0.1:4040）
   ├─ Express 静态服务 public/（前端 SPA）
   ├─ REST API   /api/vector-stores|files|image|tts
   ├─ SSE 流式   /api/chat|vision|video
   ├─ WebSocket  /api/realtime（实时语音）
   └─ 出站请求 → wss://api.stepfun.com / https://api.stepfun.com
```

要点：**应用只监听本机回环地址**，由 Nginx 统一对外，WebSocket 与 SSE 都走同一入口。

---

## 二、部署前须知（本项目特有约束）

| 约束 | 说明 | 对策 |
|------|------|------|
| `node-fetch@2` | 项目用 v2（CommonJS），v3 是 ESM 会 `require` 报错 | `npm install` 前锁死 v2 |
| WebSocket 代理 | Realtime 语音走 `/api/realtime` WS | Nginx 必须配 `Upgrade`/`Connection` 头 |
| SSE 流式 | chat/vision/video 是流式透传 | Nginx `proxy_buffering off` + 拉长超时 |
| 大文件上传 | 视频 base64 原始 ≤128MB，body 上限 200MB | `client_max_body_size 200m` |
| API Key | `.env` 含 `STEP_API_KEY`，敏感 | 不进 git、`chmod 600`、不落日志 |
| 运行时数据 | `data/file-mapping.json` 是文件 ID 映射 | 迁移/备份必须带上 |
| 内存 | 2G 内存处理 base64 大视频偏紧 | 加 2G swap 兜底 |
| 带宽 | 4Mbps 上传视频较慢 | 建议前端压缩后再传 |

---

## 三、部署步骤

### Step 1 · 环境准备（TAT 远程执行）

```bash
# Node.js 22 LTS（与本地 v22 一致，避免版本差异）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2 进程守护
sudo npm install -g pm2

# Nginx
sudo apt-get install -y nginx
```

### Step 2 · 上传代码

本地打包（排除 node_modules / .env / logs / data）：

```bash
# Windows Git Bash 下执行
cd /d/aiwork/IDE/workbuddy
tar -czf stepfun-kb-cms.tar.gz \
  --exclude=node_modules --exclude=.env --exclude=logs --exclude=data \
  stepfun_kb_cms
```

上传并解压：

```bash
scp stepfun-kb-cms.tar.gz root@82.157.30.126:/opt/
ssh root@82.157.30.126 "mkdir -p /opt/stepfun-kb-cms && tar -xzf /opt/stepfun-kb-cms.tar.gz -C /opt/stepfun-kb-cms"
```

### Step 3 · 安装依赖

```bash
cd /opt/stepfun-kb-cms
npm install --omit=dev
# 确认 node-fetch 是 v2（务必，v3 会崩）
node -e "console.log(require('node-fetch/package.json').version)"
```

### Step 4 · 配置环境变量

```bash
sudo tee /opt/stepfun-kb-cms/.env > /dev/null <<'EOF'
STEP_API_KEY=<你的 StepFun API Key>
PORT=4040
EOF
sudo chmod 600 /opt/stepfun-kb-cms/.env
```

### Step 5 · PM2 启动 + 守护

```bash
cd /opt/stepfun-kb-cms
pm2 start server.js --name stepfun-kb-cms
pm2 save
pm2 startup systemd   # 按提示执行输出的 sudo 命令，实现开机自启
```

### Step 6 · Nginx 反向代理

新建 `/etc/nginx/sites-available/stepfun-kb-cms`：

```nginx
server {
    listen 80;
    server_name 82.157.30.126;   # 换成你的域名则填域名

    client_max_body_size 200m;    # 视频/图片 base64 上传

    location / {
        proxy_pass http://127.0.0.1:4040;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket（Realtime 语音必需）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # SSE 流式 + 长连接
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

启用并重载：

```bash
sudo ln -s /etc/nginx/sites-available/stepfun-kb-cms /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Step 7 · 防火墙放行端口

当前实例只开放 22 + ICMP，需新增（在 Lighthouse 控制台「防火墙」或由我代配）：

| 协议 | 端口 | 用途 |
|------|------|------|
| TCP  | 80   | HTTP |
| TCP  | 443  | HTTPS（配置证书后） |

### Step 8 · 验证

```bash
curl http://82.157.30.126/api/health
# 期望返回 {"status":"ok","timestamp":...}
```

浏览器打开 `http://82.157.30.126/` 进入管理后台。

---

## 四、可选增强

- **HTTPS**：绑定域名后用 certbot 签发免费证书（Let's Encrypt）
- **域名**：DNS 解析 A 记录指向 82.157.30.126，Nginx `server_name` 填域名
- **日志**：PM2 日志轮转（`pm2 install pm2-logrotate`）
- **备份**：定期备份 `data/` 目录与 `.env`
