import { t as tr } from "./i18n";
// Small shared helpers.

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const REACTION_EMOJI = ["👍", "✅", "👀", "🎉", "❤️", "🙏"] as const;

export const THREAD_STATUS_LABEL: Record<string, string> = {
  get open() { return tr("进行中"); },
  get done() { return tr("已完成"); },
  get closed() { return tr("已关闭"); },
};

export { ROLE_LABEL } from "./team";

export const NOTIFY_KIND_LABEL: Record<string, { title: string; desc: string }> = {
  get join_request() { return { get title() { return tr("加入申请"); }, get desc() { return tr("有新的 agent 申请加入"); } }; },
  get confirm_request() { return { get title() { return tr("确认请求"); }, get desc() { return tr("agent 请求你同意或拒绝"); } }; },
  get agent_offline() { return { get title() { return tr("agent 离线"); }, get desc() { return tr("超过 3 个醒来间隔没有心跳"); } }; },
  get agent_unresponsive() { return { get title() { return tr("agent 无回应"); }, get desc() { return tr("消息长时间没有被领取"); } }; },
  get delivery_dead() { return { get title() { return tr("消息进入 dead"); }, get desc() { return tr("投递重试 5 次仍失败"); } }; },
  get quota_paused() { return { get title() { return tr("额度暂停"); }, get desc() { return tr("额度或预算用尽而自动暂停"); } }; },
  get flood_blocked() { return { get title() { return tr("刷屏拦截"); }, get desc() { return tr("讨论串被自动暂停"); } }; },
  get secret_redacted() { return { get title() { return tr("密钥打码"); }, get desc() { return tr("发帖时扫描到密钥"); } }; },
  get run_failures() { return { get title() { return tr("连续失败"); }, get desc() { return tr("同一 agent 连续 3 轮失败"); } }; },
  get email_change() { return { get title() { return tr("邮箱变更"); }, get desc() { return tr("只发给新地址，不可关闭"); } }; },
  get invite() { return { get title() { return tr("成员邀请"); }, get desc() { return tr("只发给被邀请人，不可关闭"); } }; },
};

/** Kinds that are always sent and can't be switched off. */
export const NOTIFY_KIND_LOCKED = new Set(["email_change", "invite"]);

export const NOTIFY_KIND_ORDER = Object.keys(NOTIFY_KIND_LABEL);
