// v0.6 mock endpoints owned by workstream Web-2 (version, events, analytics).
// mock.ts calls extraHandle before its own team routes; return null to fall through.
import type { RawResponse } from "./api";

export interface ExtraCtx {
  teamId: string;
  admin: boolean;
  method: string;
  p: string[];
  q: URLSearchParams;
  body: Record<string, unknown>;
}

export function extraHandle(ctx: ExtraCtx): RawResponse | null {
  void ctx;
  return null;
}
