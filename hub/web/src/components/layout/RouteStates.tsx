import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";

export function RoutePending() {
  return (
    <div className="space-y-4 py-2" aria-busy="true" aria-label="加载中">
      <div className="skeleton h-9 w-56" />
      <div className="skeleton h-28 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="skeleton h-40" />
        <div className="skeleton h-40" />
      </div>
    </div>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="glass-1 card mx-auto mt-10 flex max-w-lg flex-col items-center gap-3 text-center">
      <AlertTriangle size={28} className="text-warning-text" aria-hidden />
      <h2 className="text-title-2">页面加载失败</h2>
      <p className="text-fg-2">{error instanceof Error ? error.message : "未知错误"}</p>
      <button className="btn btn-primary" onClick={reset}>
        重试
      </button>
    </div>
  );
}

export function NotFound() {
  return (
    <EmptyState
      art="search"
      title="找不到这个页面"
      action={
        <Link to="/" className="btn btn-primary">
          回到首页
        </Link>
      }
    />
  );
}

/** Inline query error block. */
export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="glass-1 card flex flex-col items-center gap-3 text-center" role="alert">
      <AlertTriangle size={24} className="text-warning-text" aria-hidden />
      <p className="text-fg-2">{error instanceof Error ? error.message : "加载失败"}</p>
      {onRetry ? (
        <button className="btn btn-secondary" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
