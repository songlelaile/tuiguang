# 独立部署 SOP（无主域名）

适用场景：
- 全新云主机，**没有**现有主域名复用
- 直接通过 `http://服务器IP/` 访问
- 内网或 VPN 可达环境

如果你想挂在已有主域名下做子站（如 `tuiguang.shaozhuangai.com`），改看 [host-nginx-deploy.md](host-nginx-deploy.md)。

访问控制：**内网 + Nginx Basic Auth**（HTTPS 暂不开启，反代层后期可补 certbot）。

---

## 0. 前置条件

服务器（建议 2 vCPU / 4 GB 起步，纯磁盘 ≥ 20 GB）已安装：

- Docker Engine 24+
- Docker Compose Plugin v2（`docker compose version` 能输出版本即可）
- `htpasswd` 命令（来自 `apache2-utils` / `httpd-tools`）；没有也可以用 Docker 临时生成，见步骤 3

---

## 1. 拉代码

```bash
sudo mkdir -p /opt/tuiguang
sudo chown $USER:$USER /opt/tuiguang
git clone https://github.com/songlelaile/tuiguang.git /opt/tuiguang
cd /opt/tuiguang
```

## 2. 配置环境变量

```bash
cp .env.example .env
# 用编辑器打开 .env，按需改 APP_PORT / UPLOADS_HOST_DIR / TZ
nano .env
```

生产环境建议：

```dotenv
APP_PORT=80
UPLOADS_HOST_DIR=/var/lib/tuiguang/uploads
UPLOAD_MAX_MB=100
TZ=Asia/Shanghai
```

```bash
sudo mkdir -p /var/lib/tuiguang/uploads
sudo chown 1000:1000 /var/lib/tuiguang/uploads   # 容器内 node 用户 UID 1000
```

## 3. 生成 Basic Auth 口令文件

```bash
# 方式 A：本机有 htpasswd
htpasswd -cbB docker/htpasswd admin '替换为强密码'
htpasswd -bB  docker/htpasswd viewer '另一个强密码'   # 追加用户（可选）

# 方式 B：没有 htpasswd，用 Docker 临时生成
docker run --rm httpd:2.4-alpine htpasswd -nbB admin '替换为强密码' > docker/htpasswd

chmod 600 docker/htpasswd
```

> 密码建议 12 位以上，含大小写 + 数字 + 符号。`-B` 表示用 bcrypt，不要省略。

## 4. 启动

```bash
docker compose --profile standalone up -d --build
docker compose ps
```

预期输出两个服务都是 `running (healthy)`。

## 5. 验证

```bash
# 健康检查（不需要鉴权，nginx 已放行）
curl -fsS http://127.0.0.1/api/health

# 带鉴权访问首页
curl -u admin:'你的密码' http://127.0.0.1/

# 浏览器访问 http://服务器内网IP/  → 弹 Basic Auth → 看到 BI 首页
```

进入"源数据"页面，上传 5 张生意参谋导出表，下方**时间线**面板会显示对齐状态。

---

## 升级

```bash
cd /opt/tuiguang
git pull
docker compose --profile standalone up -d --build
docker compose ps
```

镜像层缓存生效，`npm ci` 不会重跑。常规更新 1~2 分钟。

## 备份 uploads + 历史库

⚠️ **从 P1 起新增了 SQLite 历史库**（默认 `/var/lib/tuiguang/data/history.sqlite`），
里面是长期累积的所有上传数据。必须跟 uploads 一起备份，丢了等于历史数据丢了。

`deploy/backup.sh` 已经支持同时打包 uploads + data 两个目录。

每天定时跑：

```bash
sudo crontab -e
# 加一行：每天 03:00 备份 uploads + data（含历史库），保留 14 份
0 3 * * * cd /opt/tuiguang && UPLOADS_HOST_DIR=/var/lib/tuiguang/uploads DATA_HOST_DIR=/var/lib/tuiguang/data BACKUP_DIR=/var/backups/tuiguang KEEP=14 /opt/tuiguang/deploy/backup.sh >> /var/log/tuiguang-backup.log 2>&1
```

手动跑一次确认：

```bash
sudo bash deploy/backup.sh
ls -lh /var/backups/tuiguang/
```

## 回滚

```bash
cd /opt/tuiguang
git log --oneline -n 10                 # 找到目标 commit
git checkout <commit-hash>
docker compose --profile standalone up -d --build
```

uploads 卷数据天然保留（在宿主机磁盘上，不受镜像重建影响）。

## 重置上传数据

```bash
# 应用内：到"源数据"页点"清空源数据"按钮
# 或服务器上直接清：
sudo rm -rf /var/lib/tuiguang/uploads/source-data/*
docker compose restart app
```

## 修改上传上限

1. 改 `.env` 里 `UPLOAD_MAX_MB`
2. 改 `docker/nginx.conf` 里 `client_max_body_size`（保持同值）
3. `docker compose up -d`（nginx 会重启加载新配置）

## 排错速查

| 现象 | 排查 |
|---|---|
| 浏览器一直转圈 | `docker compose logs nginx` `docker compose logs app` |
| 弹了 Basic Auth 但密码对的也不通过 | `docker/htpasswd` 没用 `-B`（bcrypt），重新生成 |
| 上传文件 413 | nginx `client_max_body_size` 没改到位 |
| 上传卡死然后 502 | `proxy_read_timeout` 不够大，或者 `UPLOAD_MAX_MB` 小于实际文件 |
| 时间线总是 incomplete | 5 个槽位的文件还没上齐；或者某 csv 编码不是 GB18030 |
| 容器自动重启循环 | `docker compose logs app` 看 ENOENT；可能 uploads 卷权限不对，`chown 1000:1000` |

---

## 端口与防火墙

云安全组只放行 `APP_PORT`（默认 80）的内网来源 IP 段。容器内 `5174` 仅在 docker 网络可达，不会泄露到外面。
