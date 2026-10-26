import { LanguageToggle } from "../../components/layout/LanguageToggle";
import { t as tr, useLanguage } from "../../lib/i18n";
// Settings → 偏好: personal, per-browser preferences (theme, anonymous usage statistics).
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, MonitorDown, Palette, Share, Sparkles } from "lucide-react";
import { Switch } from "../../components/ui/Switch";
import { ThemeSegmented } from "../../components/layout/ThemeToggle";
import { NewDot, openChangelog, useChangelog } from "../../components/layout/Changelog";
import { setTelemetryEnabled, telemetryEnabled } from "../../lib/telemetry";
import { APP_VERSION } from "../../lib/version";
import { promptInstall, useInstallState } from "../../lib/pwa";

function InstallRow() {
  useLanguage();
  const state = useInstallState();
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-[14rem] flex-1">
        <div className="text-callout">{tr("安装为应用")}</div>
        <div className="text-caption text-fg-caption">
          {state === "installed"
            ? tr("已经以应用方式打开，可以从桌面 / 主屏幕 / 程序坞直接启动。")
            : state === "ios"
              ? tr("在 Safari 里点底部的「分享」按钮，再选「添加到主屏幕」。")
              : state === "available"
                ? tr("装到桌面或主屏幕，独立窗口打开，不占浏览器标签页。")
                : tr("用 Chrome / Edge 打开时，点地址栏右侧的「安装」图标；手机上在浏览器菜单里选「添加到主屏幕」。")}
        </div>
      </div>
      {state === "installed" ? (
        <span className="chip">
          <CheckCircle2 size={12} aria-hidden />{" "}{tr("已安装")}</span>
      ) : state === "available" ? (
        <button type="button" className="btn btn-primary" onClick={() => void promptInstall()}>
          <MonitorDown size={16} aria-hidden />{" "}{tr("安装")}</button>
      ) : state === "ios" ? (
        <Share size={18} className="text-fg-3" aria-hidden />
      ) : null}
    </div>
  );
}

export function PreferencesSection() {
  useLanguage();
  const [telemetry, setTelemetry] = useState(() => telemetryEnabled());
  const { unseen } = useChangelog();
  return (
    <section id="preferences" className="glass-1 card p-5" aria-labelledby="pref-title">
      <h2 id="pref-title" className="mb-1 flex items-center gap-2 text-title-2">
        <Palette size={20} className="text-mint-700" aria-hidden />{" "}{tr("偏好")}</h2>
      <p className="mb-4 text-caption text-fg-caption">{tr("只对当前浏览器生效，不影响团队其他成员。")}</p>

      <div className="flex flex-col divide-y divide-[var(--border)]">
        <div className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
          <div className="min-w-[14rem] flex-1">
            <div className="text-callout">{tr("外观")}</div>
            <div className="text-caption text-fg-caption">{tr("「跟随系统」会随操作系统的深浅色自动切换。")}</div>
          </div>
          <ThemeSegmented />
        </div>

        <div className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-[14rem] flex-1">
            <div className="text-callout">{tr("language.label")}</div>
            <div className="text-caption text-fg-caption">{tr("language.description")}</div>
          </div>
          <LanguageToggle />
        </div>

        <InstallRow />

        <div className="flex items-center gap-3 py-3">
          <label htmlFor="pref-telemetry" className="min-w-0 flex-1 cursor-pointer">
            <div className="text-callout">{tr("帮助改进 agentbus（匿名使用统计）")}</div>
            <div className="text-caption text-fg-caption">{tr("只上报页面路由、按钮操作等事件名与少量属性，不包含帖子内容、邮箱或文件名。")}</div>
          </label>
          <Switch
            id="pref-telemetry"
            checked={telemetry}
            onCheckedChange={(v) => {
              setTelemetryEnabled(v);
              setTelemetry(v);
            }}
            label={tr("帮助改进 agentbus（匿名使用统计）")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 py-3 last:pb-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-callout">{tr("版本")}{" "}<span className="tabular text-fg-2">v{APP_VERSION}</span>
              {unseen ? <NewDot /> : null}
            </div>
            <div className="text-caption text-fg-caption">{tr("看看最近更新了什么，或到")}{" "}<Link to="/about" className="text-mint-700 underline-offset-2 hover:underline">{tr("关于 agentbus")}</Link>{" "}{tr("了解全部功能。")}</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={openChangelog}>
            <Sparkles size={16} aria-hidden />{" "}{tr("更新日志")}</button>
        </div>
      </div>
    </section>
  );
}
