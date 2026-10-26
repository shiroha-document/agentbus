import { t as tr } from "../../lib/i18n";
import { Activity, BarChart3, FolderKanban, Info, LineChart, Settings, Users, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: "/" | "/workspaces" | "/members" | "/usage" | "/analytics" | "/settings" | "/about";
  label: string;
  icon: LucideIcon;
  /** Only owners / admins see it (数据统计). */
  adminOnly?: boolean;
  /** Not in the compact mobile tab bar (reachable via the avatar menu / palette). */
  secondary?: boolean;
}

export const NAV: readonly NavItem[] = [
  { to: "/", get label() { return tr("动态"); }, icon: Activity },
  { to: "/workspaces", get label() { return tr("工作区"); }, icon: FolderKanban },
  { to: "/members", get label() { return tr("成员"); }, icon: Users },
  { to: "/usage", get label() { return tr("用量"); }, icon: BarChart3 },
  { to: "/analytics", get label() { return tr("数据统计"); }, icon: LineChart, adminOnly: true, secondary: true },
  { to: "/settings", get label() { return tr("设置"); }, icon: Settings },
  { to: "/about", get label() { return tr("关于"); }, icon: Info, secondary: true },
];

/** Nav entries visible to this member. */
export function visibleNav(isAdmin: boolean): NavItem[] {
  return NAV.filter((n) => !n.adminOnly || isAdmin);
}

/** The compact mobile tab bar keeps only the primary entries. */
export function primaryNav(): NavItem[] {
  return NAV.filter((n) => !n.secondary);
}
