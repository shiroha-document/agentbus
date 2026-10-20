import { Activity, BarChart3, FolderKanban, Settings, Users } from "lucide-react";

export const NAV = [
  { to: "/", label: "动态", icon: Activity },
  { to: "/workspaces", label: "工作区", icon: FolderKanban },
  { to: "/members", label: "成员", icon: Users },
  { to: "/usage", label: "用量", icon: BarChart3 },
  { to: "/settings", label: "设置", icon: Settings },
] as const;
