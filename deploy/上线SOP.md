# tuiguang 生产上线 SOP（日常升级 / 重新部署）

> 适用：把 `feat/enterprise-deploy` 的新代码部署到已在运行的生产环境
> （首次从零搭建请看 [host-nginx-deploy.md](host-nginx-deploy.md)）
>
> 本文是**实战版**——按这套环境的真实情况写，包含国内访问 GitHub 抖动、宝塔 WAF、
> 代理 DNS 劫持等真实坑位的处理。命令均可直接复制执行。

---

## 0. 环境速查表（本套环境固定信息）

| 项 | 值 |
|---|---|
| 生产服务器 | `root@114.55.254.164`（阿里云杭州，装了宝塔面板 + WAF） |
| 项目路径 | `/opt/tuiguang` |
| 部署分支 | `feat/enterprise-deploy` |
| 代码仓库 | `https://github.com/songlelaile/tuiguang.git` |
| 运行方式 | Docker：`docker compose up -d --build`（主域名子站模式，**不带** `--profile standalone`） |
| 公网入口 | `https://tuiguang.shaozhuangai.com` |
| 流量链路 | 公网 443 → 宿主 nginx(TLS) → `127.0.0.1:5180` → 容器 `tuiguang-app:5174` |
| 容器名 | `tuiguang-app` |
| 数据卷（bind mount，**重建不丢**） | uploads：`/var/lib/tuiguang/uploads`<br>历史库：`/var/lib/tuiguang/data`（`history.sqlite`） |
| 备份目录 | `/var/backups/tuiguang` |
| 登录服务器 | 已配本机 Mac 免密钥（`~/.ssh/id_ed25519`，公钥名 `tuiguang-deploy`）；或用宝塔「终端」网页 shell |

---

## 1. 开发侧：先把代码推上去

在本地（Mac）确认改动并推送到部署分支：

```bash
cd ~/Documents/财务指标监控BI/tuiguang
git status                       # 确认改了什么
git add -A && git commit -m "你的提交说明"
git push origin feat/enterprise-deploy
```

> ⚠️ 生产部署的就是 `origin/feat/enterprise-deploy` 这个分支。没 push 上去的改动不会上线。

---

## 2. 登录服务器

```bash
ssh root@114.55.254.164
cd /opt/tuiguang
```

> 连不上 / 没配免密钥时，可用宝塔面板 →「终端」网页 shell（它本身就在服务器上）。
> 注意：宝塔网页终端的提示符是 `root@iZbp1c2ufmru...`，那是**服务器**；
> 别把"在本机执行"的命令跑到那里去（之前 `ssh-copy-id` 就踩过这个坑）。

---

## 3. 预检（只读，判断"该不该部署"+"是否安全"）

```bash
cd /opt/tuiguang

# 3.1 拉取远端引用（只更新 origin/* 跟踪分支，不动工作树）
git fetch origin

# 3.2 当前版本 vs 目标版本
echo "当前: $(git rev-parse --short HEAD)  $(git log -1 --format=%s)"
echo "目标: $(git rev-parse --short origin/feat/enterprise-deploy)  $(git log -1 --format=%s origin/feat/enterprise-deploy)"
echo "落后: $(git rev-list --count HEAD..origin/feat/enterprise-deploy) 个提交"

# 3.3 待部署的提交清单
git log --oneline HEAD..origin/feat/enterprise-deploy

# 3.4 工作树是否干净（防止 pull 冲突）
git status --porcelain
#   - 空        → 干净，放心
#   - " M 文件" → 已跟踪文件被改过，需先弄清楚（git diff），别盲目覆盖
#   - "?? 文件" → 未跟踪文件，一般无害；只要远端没有同名文件就不挡 ff pull
#     校验是否会碰撞：
#     git cat-file -e origin/feat/enterprise-deploy:<文件名> 2>/dev/null && echo "⚠️会碰撞" || echo "✅安全"

# 3.5 容器是否健康 + 磁盘余量（构建+备份要用）
docker compose ps
df -h /
```

判断：
- **落后 0** → 已是最新，无需部署（重复部署同版本只会无意义重建+短暂停机）。
- **落后 >0 且工作树无冲突** → 继续。

---

## 4. 备份（部署前**必做**）

`backup.sh` 把 uploads + 历史库打成单个 `tar.gz`，滚动保留最近 `KEEP` 份。

```bash
cd /opt/tuiguang
UPLOADS_HOST_DIR=/var/lib/tuiguang/uploads \
DATA_HOST_DIR=/var/lib/tuiguang/data \
BACKUP_DIR=/var/backups/tuiguang KEEP=14 \
bash deploy/backup.sh

ls -lh /var/backups/tuiguang/    # 确认新备份已生成
```

> 历史库压缩比很高（实测 5.4G → 273M），14 份也才几个 G，磁盘压力不大。
> 数据卷是 bind mount，`docker compose up --build` 不会动它；备份是为了防"新版本迁移逻辑出错"这种极端情况。

---

## 5. 拉取目标版本到工作树

### 5.1 正常情况

```bash
git pull --ff-only origin feat/enterprise-deploy
```

### 5.2 ⚠️ 若报 GitHub TLS 错（国内服务器高频出现）

报错形如：
```
fatal: unable to access 'https://github.com/...': GnuTLS recv error (-110): The TLS connection was non-properly terminated.
```

这是阿里云访问 GitHub 的网络抖动，**不是代码问题**。处理：

```bash
# 先重试几次 fetch（抖动通常是瞬时的）
for i in 1 2 3 4 5; do git fetch origin && break || { echo "第 $i 次失败，重试..."; sleep 5; }; done

# 只要 origin/feat/enterprise-deploy 已经指向目标 commit（预检 3.2 能看到目标版本即说明对象已在本地），
# 就用本地对象做快进合并，完全不走 GitHub 网络：
git merge --ff-only origin/feat/enterprise-deploy
```

> 原理：`git pull` = `fetch`(联网) + `merge`。一旦目标对象已 fetch 到本地，
> `merge --ff-only` 纯本地操作，绕开网络。这是本套环境最可靠的拉取方式。

拉完确认：
```bash
echo "新 HEAD: $(git rev-parse --short HEAD)  $(git log -1 --format=%s)"
echo "落后远端: $(git rev-list --count HEAD..origin/feat/enterprise-deploy)（应为 0）"
```

---

## 6. 构建并重启容器

```bash
cd /opt/tuiguang
docker compose up -d --build
docker compose ps
```

要点：
- **依赖没变（`package.json`/`package-lock.json` 未改）时**，Docker 的 `apk add` 和两个 `npm ci`
  层**全部缓存命中**，构建几乎不联网；只重跑 `vite build`(本地) + 拷贝产物。实测约 1–2 分钟。
- `-d --build`：先构建新镜像（容器仍在跑），构建完才重建容器；**停机仅在重建那一下，约 20–40 秒**。
- 想确认依赖是否变过：`git diff <旧commit>..HEAD -- package.json package-lock.json`，有输出才会触发联网装包。

---

## 7. 验证（分层，从内到外）

### 7.1 服务器内：容器 + 应用

```bash
sleep 25                                            # 等健康检查预热(start_period 15s)
docker compose ps                                   # 期望 STATUS = Up ... (healthy)
curl -fsS http://127.0.0.1:5180/api/health          # 期望 {"ok":true,"service":"huopan-bi-api"}
git rev-parse --short HEAD                           # 确认 = 目标 commit

# 启动日志查错（应只看到 listening，无 error/uncaught/fatal）
docker compose logs app --tail 30 | grep -iE "\[auth\]|\[migration\]|listening|error|uncaught|fatal"
```

### 7.2 公网：端到端（从**服务器本机**发，最可靠）

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
curl -s -A "$UA" -o /dev/null -w "health: HTTP %{http_code} TLS=%{ssl_verify_result}\n" https://tuiguang.shaozhuangai.com/api/health
curl -s -A "$UA" -o /dev/null -w "首页:   HTTP %{http_code} %{content_type}\n"        https://tuiguang.shaozhuangai.com/
curl -s -A "$UA" -o /dev/null -w "鉴权:   HTTP %{http_code}（应 401）\n"               https://tuiguang.shaozhuangai.com/api/product
```
期望：health=200（TLS=0）、首页=200 text/html、/api/product=401。

> ⚠️ **不要用本机 Mac 的 curl 判生死**：
> - 本机若开了代理（fake-ip 模式），DNS 会被劫持成 `198.18.x.x`，curl 根本没发到真实服务器 → 假性失败。
> - 宝塔 WAF 可能拦截裸 `curl` UA / 陌生 IP，端口 80 直接回 403。
> 真实用户用浏览器访问不受影响。要从本机测，加浏览器 UA 并确认 `dig tuiguang.shaozhuangai.com` 解析到 `114.55.254.164`。

### 7.3 浏览器终检
用 Chrome 打开 `https://tuiguang.shaozhuangai.com/`，admin 登录，点一下本次新增/改动的功能确认生效。

---

## 8. 回滚（验证不通过时）

### 8.1 回滚代码（最常用）
```bash
cd /opt/tuiguang
git checkout <上一个正常的 commit>      # 部署前预检 3.2 记录的"当前"版本
docker compose up -d --build
sleep 25 && docker compose ps && curl -fsS http://127.0.0.1:5180/api/health
```

### 8.2 回滚数据（仅当怀疑数据被新版本破坏，**极少需要**）
```bash
docker compose down                                  # 停容器，释放对 sqlite 的占用
cd /var/lib/tuiguang
mv data data.bad-$(date +%s)                         # 留存现场，别直接删
mv uploads uploads.bad-$(date +%s)
tar -xzf /var/backups/tuiguang/tuiguang-<时间戳>.tar.gz   # 解出 uploads/ data/
chown -R 1000:1000 /var/lib/tuiguang                 # 容器内 node 用户 UID 1000
cd /opt/tuiguang && docker compose up -d
```

---

## 9. 一键流程（一切正常时，复制整段）

```bash
ssh root@114.55.254.164 'bash -s' <<'DEPLOY'
set -e
cd /opt/tuiguang
echo "=== [1/5] 预检 ==="
git fetch origin
OLD=$(git rev-parse --short HEAD)
BEHIND=$(git rev-list --count HEAD..origin/feat/enterprise-deploy)
echo "当前 $OLD，落后远端 $BEHIND 个提交"
[ "$BEHIND" = 0 ] && { echo "已是最新，无需部署"; exit 0; }
echo "=== [2/5] 备份 ==="
UPLOADS_HOST_DIR=/var/lib/tuiguang/uploads DATA_HOST_DIR=/var/lib/tuiguang/data \
  BACKUP_DIR=/var/backups/tuiguang KEEP=14 bash deploy/backup.sh
echo "=== [3/5] 快进到目标版本（本地对象，绕开 GitHub）==="
git merge --ff-only origin/feat/enterprise-deploy
echo "新版本: $(git rev-parse --short HEAD)  $(git log -1 --format=%s)"
echo "=== [4/5] 构建并重启 ==="
docker compose up -d --build
echo "=== [5/5] 验证 ==="
sleep 25
docker compose ps
curl -fsS http://127.0.0.1:5180/api/health && echo " OK"
echo "回滚锚点(如需): cd /opt/tuiguang && git checkout $OLD && docker compose up -d --build"
DEPLOY
```

---

## 附录：排错速查

| 现象 | 原因 / 处理 |
|---|---|
| `git pull` 报 GnuTLS / TLS 错 | 国内访问 GitHub 抖动。重试 `git fetch`，再 `git merge --ff-only origin/feat/enterprise-deploy`（步骤 5.2） |
| `pull` 报 "untracked working tree files would be overwritten" | 远端新增了和本地未跟踪文件同名的文件。把本地那个改名备份后再拉：`mv 文件 文件.bak && git merge --ff-only origin/feat/enterprise-deploy` |
| 构建卡在 `npm ci` 很久 | 依赖变了触发联网装包，走的是淘宝镜像(npmmirror)，慢但不会失败；耐心等或检查服务器网络 |
| 容器一直 `health: starting` 不转 healthy | `docker compose logs app --tail 50` 看启动报错；常见是端口冲突或数据卷权限（`chown -R 1000:1000 /var/lib/tuiguang`） |
| 本机 curl 公网 000 / 403 | 本机代理 DNS 劫持(198.18.x) 或宝塔 WAF 拦截。改从服务器本机验证 + 浏览器 UA（步骤 7.2） |
| 公网 502 | 容器没起来或没绑 5180：`docker compose ps`、`curl 127.0.0.1:5180/api/health` |
| 登录页提示密码错、但确定没改密码 | 多半是认错库/认错环境。生产 admin 密码存在生产 `history.sqlite`，和本地是两套；浏览器"已登录"可能只是旧 session cookie |
| 上传 413 | 宿主 nginx `client_max_body_size` 没到 500M，与 `.env` 的 `UPLOAD_MAX_MB` 对齐 |

---

## 备注

- **免密钥**：本机 Mac 已能免密 SSH（公钥 `tuiguang-deploy` 在服务器 `~/.ssh/authorized_keys`）。
  不想保留就删服务器该行。
- **bootstrap 密码**：`.env` 里的 `ADMIN_BOOTSTRAP_PASSWORD` 在 users 表非空时**不生效**（只首次建库用）。
  按安全惯例建议首次部署后清掉（留着也不会触发，但避免明文泄漏）。
- **备份上异地**：`data/` 是长期累积、丢了不可恢复的历史库，建议把 `/var/backups/tuiguang` 定期同步到异地（OSS/另一台机）。
