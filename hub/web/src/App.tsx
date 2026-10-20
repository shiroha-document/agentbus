import { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as Tooltip from "@radix-ui/react-tooltip";
import { MotionConfig } from "motion/react";
import { LockKeyhole, RotateCw } from "lucide-react";
import { isUnauthorized, onUnauthorized } from "./api";
import { queryClient } from "./queries";
import { router } from "./router";
import { Background } from "./components/layout/Background";
import { Toaster } from "./components/ui/Toast";

function UnauthorizedPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="glass-3 card flex w-full max-w-md flex-col items-center gap-4 rounded-[28px] p-10 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-mint-100 text-mint-700">
          <LockKeyhole size={26} aria-hidden />
        </span>
        <h1 className="text-title-1">需要通过 Cloudflare Access 登录</h1>
        <p className="text-fg-2">登录状态已失效或尚未登录。请重新加载页面，按提示完成 Cloudflare Access 验证。</p>
        <button className="btn btn-primary btn-lg mt-2" onClick={() => window.location.reload()}>
          <RotateCw size={16} aria-hidden />
          重新加载
        </button>
      </div>
    </main>
  );
}

export function App() {
  const [unauth, setUnauth] = useState(isUnauthorized());
  useEffect(() => onUnauthorized(() => setUnauth(true)), []);
  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider delayDuration={250}>
          <Background />
          {unauth ? <UnauthorizedPage /> : <RouterProvider router={router} />}
          <Toaster />
        </Tooltip.Provider>
      </QueryClientProvider>
    </MotionConfig>
  );
}
