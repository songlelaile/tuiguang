// 共享的小工具,避免 5 处复制粘贴的"解析错误响应体"逻辑
//
// 之前的模式:
//   if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
// 出现在 AdminView createInvite/deleteInvite/updateUserStatus + Sources upload/clear
// 改一处就要改 5 处,容易漏

export async function readApiError(res: Response): Promise<string> {
  // 先用 text() 读一次 body,再尝试 JSON.parse。
  // body 为空时(后端进程挂掉 / vite·nginx 返回空 500)直接 res.json() 会抛
  // "Failed to execute 'json' ...: Unexpected end of JSON input",这里改成可读中文。
  let text = "";
  try {
    text = await res.text();
  } catch {
    // 读取 body 本身失败(连接被掐断),走兜底
  }
  if (text) {
    try {
      const body = JSON.parse(text);
      if (body?.error) return body.error;
    } catch {
      // 非 JSON(可能是反代/网关的 HTML 错误页),走兜底
    }
  }
  // 空 body 或无法解析:多半是后端进程未启动 / 已崩溃时,代理回的空 5xx
  if (res.status >= 500) {
    return `后端服务异常或未启动(HTTP ${res.status}),请稍后重试或刷新页面;若持续报错请重启服务`;
  }
  return `HTTP ${res.status}`;
}

// 习惯用法:
//   if (!res.ok) throw new Error(await readApiError(res));
