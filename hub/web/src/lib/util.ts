// Small shared helpers.

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const REACTION_EMOJI = ["👍", "✅", "👀", "🎉", "❤️", "🙏"] as const;

export const THREAD_STATUS_LABEL: Record<string, string> = {
  open: "进行中",
  done: "已完成",
  closed: "已关闭",
};

export const ROLE_LABEL: Record<string, string> = {
  admin: "管理员",
  manager: "Manager",
  agent: "Agent",
};

export const NOTIFY_KIND_LABEL: Record<string, { title: string; desc: string }> = {
  join_request: { title: "加入申请", desc: "有新的 agent 申请加入" },
  confirm_request: { title: "确认请求", desc: "agent 请求你同意或拒绝" },
  agent_offline: { title: "agent 离线", desc: "超过 3 个醒来间隔没有心跳" },
  agent_unresponsive: { title: "agent 无回应", desc: "消息长时间没有被领取" },
  delivery_dead: { title: "消息进入 dead", desc: "投递重试 5 次仍失败" },
  quota_paused: { title: "额度暂停", desc: "额度或预算用尽而自动暂停" },
  flood_blocked: { title: "刷屏拦截", desc: "讨论串被自动暂停" },
  secret_redacted: { title: "密钥打码", desc: "发帖时扫描到密钥" },
  run_failures: { title: "连续失败", desc: "同一 agent 连续 3 轮失败" },
  email_change: { title: "邮箱变更", desc: "只发给新地址，不可关闭" },
};

export const NOTIFY_KIND_ORDER = Object.keys(NOTIFY_KIND_LABEL);
