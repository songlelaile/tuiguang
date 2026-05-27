# tuiguang BI 部署文档索引

选择匹配你场景的 SOP：

| 场景 | SOP |
|---|---|
| **挂在已有主域名下做子站**（如 `tuiguang.shaozhuangai.com`），主服务器已有 nginx 在跑别的站 | [host-nginx-deploy.md](host-nginx-deploy.md) |
| **独立部署**：全新云主机、没有主域名，直接 `http://服务器IP/` 访问 | [standalone-deploy.md](standalone-deploy.md) |

两种模式区别：

| 项 | 主域名子站 | 独立部署 |
|---|---|---|
| 启动命令 | `docker compose up -d --build` | `docker compose --profile standalone up -d --build` |
| 容器内 nginx | 不启用（主服务器 nginx 接管） | 启用 |
| TLS | 主 nginx + certbot Let's Encrypt | 暂不做 |
| Basic Auth 位置 | `/etc/nginx/htpasswd-tuiguang` | `docker/htpasswd`（容器内） |
| 入口端口 | 主 nginx 443 → loopback 5180 | 容器内 nginx 80 直接对外 |

## 通用脚本

- `backup.sh` —— uploads 目录 tar 打包 + 滚动保留 N 份，两种模式都用得上
- `host-nginx-tuiguang.conf.example` —— 主域名子站模式专用的 nginx server 块模板
