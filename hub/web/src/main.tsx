import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";

async function boot() {
  // Dev-only mock transport. In production builds VITE_MOCK is undefined, so this
  // branch (and the dynamic import of ./mock) is removed by dead-code elimination.
  if (import.meta.env.VITE_MOCK === "1") {
    const { installMock } = await import("./mock");
    installMock();
  }
  const { App } = await import("./App");
  const el = document.getElementById("root");
  if (!el) return;
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
