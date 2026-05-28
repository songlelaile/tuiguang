# 主域名子站部署 SOP — tuiguang.shaozhuangai.com

适用场景：
- 主域名 `shaozhuangai.com` 已经有云服务器在跑（且服务器上已有 nginx 在工作）
- 希望把 tuiguang 部署成同台服务器上的一个子站 `tuiguang.shaozhuangai.com`
- 公网可访，HTTPS 加密 + **应用层账号登录(cookie session + 邀请码注册)**

如果你是**全新**云主机、没有主域名，请改看 [standalone-deploy.md](standalone-deploy.md)。

> 历史变更:从 P4 起,nginx 层的 Basic Auth 已下线,改由应用接管登录;首次部署需要通过环境变量引导首个管理员。

---

## 全流程（8 步）

### Step 1 — 主服务器现状核验（先跑这个）

SSH 上主服务器后跑以下命令，把输出贴出来确认环境：

```bash
# OS + nginx + certbot 三件套
lsb_release -a 2>/dev/null
nginx -v 2>&1
ls /etc/nginx/sites-enabled/ 2>/dev/null
which certbot && certbot --version
sudo certbot certificates 2>/dev/null | head -40

# Docker
docker --version
docker compose version

# 端口占用（5180 不能被别的服务占）
sudo ss -ltnp | grep -E ':80\b|:443\b|:5180\b'

# 防火墙
sudo ufw status 2>/dev/null
```

根据输出走以下分支：

- 如果 `certbot` 命令存在且能列出现有证书 → **跳到 Step 4**
- 如果 `certbot` 不存在 → Step 2 装 certbot
- 如果 Docker 没装 → 先 `sudo apt update && sudo apt install -y docker.io docker-compose-plugin && sudo usermod -aG docker $USER && newgrp docker`

### Step 2 — 安装 certbot（若尚未安装）

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
```

### Step 3 — DNS 解析

在 DNSPod / 阿里云 DNS 控制台添加：

| 主机记录 | 类型 | 解析值 | TTL |
|---|---|---|---|
| `tuiguang` | A | `<主服务器公网 IP>` | 600 |

如果服务器有 IPv6 公网地址，再加一条 AAAA 记录指向 IPv6。

等待解析生效（通常几分钟），验证：
```bash
dig +short tuiguang.shaozhuangai.com
# 应该输出服务器公网 IP
```

### Step 4 — 部署 tuiguang 容器

```bash
sudo mkdir -p /opt/tuiguang
sudo chown $USER:$USER /opt/tuiguang
git clone https://github.com/songlelaile/tuiguang.git /opt/tuiguang
cd /opt/tuiguang
git checkout feat/enterprise-deploy   # PR 合并前用这条；合并到 main 后删掉

cp .env.example .env
nano .env       # 修改 UPLOADS_HOST_DIR、APP_BIND_PORT 等
```

`.env` 关键字段建议值：
```dotenv
APP_BIND_PORT=5180
UPLOADS_HOST_DIR=/var/lib/tuiguang/uploads
DATA_HOST_DIR=/var/lib/tuiguang/data
UPLOAD_MAX_MB=100
TZ=Asia/Shanghai

# 首次部署:引导首个管理员账号(只在 users 表为空时生效;创建完后建议清掉密码)
ADMIN_BOOTSTRAP_USERNAME=admin
ADMIN_BOOTSTRAP_PASSWORD=<改成 12 位以上强密码>
# session 有效期(可选,默认 14 天)
SESSION_TTL_DAYS=14
```

准备 uploads + 历史库目录：
```bash
sudo mkdir -p /var/lib/tuiguang/uploads /var/lib/tuiguang/data
sudo chown -R 1000:1000 /var/lib/tuiguang   # 容器内 node 用户 UID 1000
```

> P1 起新增 SQLite 历史库（`/var/lib/tuiguang/data/history.sqlite`），跟 uploads 一样必须挂卷持久化 + 备份。从 P4 起,所有业务表都加了 `user_id` 列,每个账号的数据完全隔离。

启动 app 容器（**注意：不带 `--profile standalone`，所以容器内 nginx 不启**）：
```bash
docker compose up -d --build
docker compose ps
```

预期：只有 `tuiguang-app` 服务在跑、状态 `running (healthy)`。

验证 app 容器自检 + 首个管理员是否创建:
```bash
curl -fsS http://127.0.0.1:5180/api/health
# {"ok":true,"service":"huopan-bi-api"}
docker compose logs app | grep -E '\[auth\]|\[migration\]'
# 应看到:[auth] 已创建首个管理员: admin (id=1)
# 升级老库还应看到:[migration] 旧业务表已迁移,所有历史数据归属 user_id=1
```

### Step 5 — 收尾 bootstrap 凭据

确认能用 admin 账号登录后(下一步会做完整验证),把 `.env` 里的 `ADMIN_BOOTSTRAP_PASSWORD` 留空或注释掉,然后:
```bash
docker compose up -d   # 让进程重新读 env;无密码就不会再尝试 bootstrap
```
密码已经哈希后存进 SQLite,清掉 env 不影响登录;这样后续即使 .env 泄漏也不会暴露明文。

### Step 6 — 配主 nginx（HTTP only，先把站点拉起来）

```bash
sudo cp /opt/tuiguang/deploy/host-nginx-tuiguang.conf.example \
        /etc/nginx/sites-available/tuiguang.shaozhuangai.com
sudo nano /etc/nginx/sites-available/tuiguang.shaozhuangai.com
```

**关键**：编辑器里把"步骤一：HTTP-only 上线"那段的注释 `#` 全部去掉，把"步骤二：HTTPS 完整配置"那段**全部加上 `#` 注释掉**。这样先用 HTTP 跑通，certbot 才能拿到证书。

启用站点 + 检测语法：
```bash
sudo ln -s /etc/nginx/sites-available/tuiguang.shaozhuangai.com \
           /etc/nginx/sites-enabled/tuiguang.shaozhuangai.com
sudo nginx -t
sudo systemctl reload nginx
```

验证 HTTP 通：
```bash
curl -I http://tuiguang.shaozhuangai.com/api/health     # 应 200(免鉴权直通)
curl -I http://tuiguang.shaozhuangai.com/api/product    # 应 401(应用层拦截)
curl -i http://tuiguang.shaozhuangai.com/               # 应 200,返回登录页 index.html
```

### Step 7 — 申请 Let's Encrypt 证书

```bash
sudo certbot --nginx -d tuiguang.shaozhuangai.com
```

按提示：
- 邮箱：填一个真实邮箱（证书快到期会发邮件提醒）
- 同意条款：y
- 是否订阅 EFF newsletter：n（随意）
- 是否自动把 HTTP 重定向到 HTTPS：**选 2（Redirect）**

certbot 会自动改 nginx 配置加 SSL 段并 reload。如果你想要更精细的 HTTPS 配置（HSTS、gzip 等），把 `/etc/nginx/sites-available/tuiguang.shaozhuangai.com` 替换成 `host-nginx-tuiguang.conf.example` 里的"步骤二"段（保留 certbot 写入的证书路径），然后 `nginx -t && systemctl reload nginx`。

### Step 8 — 端到端验证

```bash
curl -fsS https://tuiguang.shaozhuangai.com/api/health        # 200(免鉴权)
curl -I    https://tuiguang.shaozhuangai.com/api/product      # 401(应用层拦截)
curl -I    http://tuiguang.shaozhuangai.com/                  # 301 → https

# 应用层登录拿 session cookie:
curl -c /tmp/sess.txt -X POST https://tuiguang.shaozhuangai.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<你的密码>"}'
# {"user":{"id":1,"username":"admin",...,"role":"admin",...}}

# 带 cookie 访问应该 200
curl -fsS -b /tmp/sess.txt https://tuiguang.shaozhuangai.com/api/auth/me
```

浏览器访问 `https://tuiguang.shaozhuangai.com/`：
- 跳到登录页 → 用 admin / 你设的密码登录
- 登录后看到 BI 主页;升级老库的话,旧数据已归到 admin 这个账号
- 右上角能看到用户名 + admin 角色徽章 + "退出"按钮
- 左侧导航多一个"管理"项(只有 admin 看得到):
  - "邀请码"标签:点"生成邀请码",复制注册链接给同事
  - "用户列表"标签:可禁用/启用账号

新账号开通流程:管理员发邀请码 → 用户打开 `https://tuiguang.shaozhuangai.com/#/register?invite=<码>` → 填用户名/密码 → 自动登录到自己的空数据视图

---

## 升级

```bash
cd /opt/tuiguang
git pull
docker compose up -d --build
docker compose ps
```

主 nginx 配置不需要重启。Let's Encrypt 证书 certbot 自带 systemd timer 自动续签，无需手动。

## 备份 uploads + 历史库

```bash
sudo crontab -e
# 加一行：每天 03:00 备份 uploads + data（含 SQLite 历史库），保留 14 份
0 3 * * * cd /opt/tuiguang && UPLOADS_HOST_DIR=/var/lib/tuiguang/uploads DATA_HOST_DIR=/var/lib/tuiguang/data BACKUP_DIR=/var/backups/tuiguang KEEP=14 /opt/tuiguang/deploy/backup.sh >> /var/log/tuiguang-backup.log 2>&1
```

⚠️ data 目录里是长期累积的历史数据库，丢了不能恢复，务必纳入异地备份。

## 回滚

```bash
cd /opt/tuiguang
git log --oneline -n 10
git checkout <commit-hash>
docker compose up -d --build
```

## 排错速查

| 现象 | 排查 |
|---|---|
| `curl tuiguang.../api/health` 返回 502 | app 容器没跑或没绑 5180：`docker compose ps`、`curl 127.0.0.1:5180/api/health` |
| 浏览器 SSL 报错 | certbot 是否成功执行；`/etc/letsencrypt/live/tuiguang.shaozhuangai.com/` 是否存在 |
| `[startup] DB 初始化失败` "检测到旧版业务数据" | 升级老库时 `ADMIN_BOOTSTRAP_USERNAME/PASSWORD` 没设;设了 env 后 `docker compose up -d` 重启即可 |
| 管理员账号不存在,登录页提示密码错 | `docker compose logs app \| grep '\[auth\]'`;若看到 "users 表为空" 警告,补 env 后重启 |
| 登录后立刻又跳回登录页 | cookie 没设进来;检查 nginx 是不是吃掉了 Set-Cookie(本配置不会),浏览器是否禁用了第三方 cookie(同源不该有这问题) |
| 上传 413 Request Entity Too Large | 主 nginx `client_max_body_size` 没到 100M |
| 上传卡死 → 504 | 主 nginx `proxy_read_timeout` 不够大 |
| certbot 拒绝签发 | DNS 没生效（dig 看）或 80 端口没通到主 nginx（`sudo ss -ltnp \| grep :80`） |
| 时间线总是 incomplete | 5 个槽位还没上齐，或 csv 编码不是 GB18030 |

---

## 简化拓扑回顾

```
公网 :443
  │ TLS (Let's Encrypt)
  ▼
[主服务器 nginx] /etc/nginx/sites-enabled/tuiguang.shaozhuangai.com
  │ proxy_pass http://127.0.0.1:5180  (无 Basic Auth,应用层接管)
  ▼
[docker container: tuiguang-app] port 5174
  │ 应用层:cookie session + bcrypt + 邀请码注册
  │ DB:  /app/data/history.sqlite   (users / sessions / invite_codes / 6 张业务表)
  │ 文件:/app/uploads/source-data/{user_id}/{slot}.{xlsx,csv}
  ▼
volume mount: /var/lib/tuiguang/{uploads,data}
```
