// 共享的小工具,避免 5 处复制粘贴的"解析错误响应体"逻辑
//
// 之前的模式:
//   if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
// 出现在 AdminView createInvite/deleteInvite/updateUserStatus + Sources upload/clear
// 改一处就要改 5 处,容易漏

export async function readApiError(res: Response): Promise<string> {
  const fallback = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    return body?.error || fallback;
  } catch {
    return fallback;
  }
}

// 习惯用法:
//   if (!res.ok) throw new Error(await readApiError(res));
