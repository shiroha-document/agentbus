import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALL_LINE,
  TEAM_HEADER,
  TEAM_KEY,
  applyTeamParamFromLocation,
  clearStoredTeam,
  consumeTeamParam,
  deleteConfirmMatches,
  getStoredTeam,
  inviteStatus,
  isAdminRole,
  isOwnerRole,
  isTeamId,
  joinCodeStatus,
  joinSnippet,
  roleLabel,
  setStoredTeam,
  teamHeaders,
  teamInitial,
  type KV,
} from "../team";
import { api, onNotMember, setTransport, type Transport } from "../../api";

function memKV(init: Record<string, string> = {}): KV & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const A = "o_01jshirohalab0000000000000";
const B = "o_01jsideproject000000000000";

describe("team storage", () => {
  it("validates team ids", () => {
    expect(isTeamId(A)).toBe(true);
    expect(isTeamId("o_")).toBe(false);
    expect(isTeamId("O_ABC")).toBe(false);
    expect(isTeamId("o_abc;drop")).toBe(false);
    expect(isTeamId(null)).toBe(false);
    expect(isTeamId(42)).toBe(false);
  });

  it("stores, reads and clears the selected team", () => {
    const kv = memKV();
    expect(getStoredTeam(kv)).toBeNull();
    setStoredTeam(A, kv);
    expect(kv.data.get(TEAM_KEY)).toBe(A);
    expect(getStoredTeam(kv)).toBe(A);
    clearStoredTeam(kv);
    expect(getStoredTeam(kv)).toBeNull();
    expect(kv.data.has(TEAM_KEY)).toBe(false);
  });

  it("ignores garbage in storage and refuses to store invalid ids", () => {
    expect(getStoredTeam(memKV({ [TEAM_KEY]: "nope" }))).toBeNull();
    const kv = memKV({ [TEAM_KEY]: A });
    setStoredTeam("bad id", kv);
    expect(kv.data.has(TEAM_KEY)).toBe(false);
  });

  it("survives a throwing or missing storage", () => {
    const boom: KV = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(getStoredTeam(boom)).toBeNull();
    expect(() => setStoredTeam(A, boom)).not.toThrow();
    expect(getStoredTeam(null)).toBeNull();
  });

  it("builds the team header only for a valid id", () => {
    expect(teamHeaders(A)).toEqual({ [TEAM_HEADER]: A });
    expect(TEAM_HEADER).toBe("X-Agentbus-Team");
    expect(teamHeaders(null)).toEqual({});
    expect(teamHeaders("x")).toEqual({});
  });
});

describe("?team= param", () => {
  it("returns cleaned=null when there is no team param", () => {
    expect(consumeTeamParam("https://hub.test/threads/t_1?x=1#p")).toEqual({ team: null, cleaned: null });
  });

  it("extracts the team and keeps other params and the hash", () => {
    expect(consumeTeamParam(`https://hub.test/threads/t_1?team=${A}&post=p_9#p_9`)).toEqual({
      team: A,
      cleaned: "/threads/t_1?post=p_9#p_9",
    });
    expect(consumeTeamParam(`/settings?team=${A}`)).toEqual({ team: A, cleaned: "/settings" });
  });

  it("strips an invalid team param without selecting it", () => {
    expect(consumeTeamParam("https://hub.test/?team=evil&a=b")).toEqual({ team: null, cleaned: "/?a=b" });
    expect(consumeTeamParam("https://hub.test/?team=")).toEqual({ team: null, cleaned: "/" });
  });

  it("applies the param to storage and rewrites history once", () => {
    const kv = memKV({ [TEAM_KEY]: B });
    const replaceState = vi.fn();
    const team = applyTeamParamFromLocation({ href: `https://hub.test/threads/t_1?team=${A}` }, { replaceState, state: { k: 1 } }, kv);
    expect(team).toBe(A);
    expect(getStoredTeam(kv)).toBe(A);
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/threads/t_1");
  });

  it("leaves storage and history alone without a param; keeps the old team on an invalid one", () => {
    const kv = memKV({ [TEAM_KEY]: B });
    const replaceState = vi.fn();
    expect(applyTeamParamFromLocation({ href: "https://hub.test/usage" }, { replaceState, state: null }, kv)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    expect(applyTeamParamFromLocation({ href: "https://hub.test/usage?team=bad" }, { replaceState, state: null }, kv)).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/usage");
    expect(getStoredTeam(kv)).toBe(B);
  });
});

describe("api team header + not_member", () => {
  const kv = memKV();
  afterEach(() => {
    setTransport(null);
    kv.data.clear();
    vi.unstubAllGlobals();
  });

  it("sends X-Agentbus-Team from storage, and nothing when unset", async () => {
    vi.stubGlobal("localStorage", kv);
    const seen: Record<string, string>[] = [];
    const t: Transport = async (_m, _p, _b, headers) => {
      seen.push(headers);
      return { status: 200, data: { members: [] } };
    };
    setTransport(t);
    await api.members();
    setStoredTeam(A);
    await api.members();
    expect(seen).toEqual([{}, { [TEAM_HEADER]: A }]);
  });

  it("clears a stale team on 403 not_member and broadcasts once for concurrent failures", async () => {
    vi.stubGlobal("localStorage", kv);
    setStoredTeam(A);
    setTransport(async () => ({ status: 403, data: { error: { code: "not_member", message: "不是该团队成员" } } }));
    const fn = vi.fn();
    const off = onNotMember(fn);
    const results = await Promise.allSettled([api.members(), api.workspaces(), api.settings()]);
    off();
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(getStoredTeam()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast for other 403s", async () => {
    vi.stubGlobal("localStorage", kv);
    setStoredTeam(A);
    setTransport(async () => ({ status: 403, data: { error: { code: "forbidden", message: "需要管理员" } } }));
    const fn = vi.fn();
    const off = onNotMember(fn);
    await expect(api.settings()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    off();
    expect(fn).not.toHaveBeenCalled();
    expect(getStoredTeam()).toBe(A);
  });
});

describe("roles", () => {
  it("labels and classifies roles", () => {
    expect(roleLabel("owner")).toBe("所有者");
    expect(roleLabel("admin")).toBe("管理员");
    expect(roleLabel("manager")).toBe("Manager");
    expect(roleLabel(null)).toBe("");
    expect(roleLabel("weird")).toBe("weird");
    expect(isAdminRole("owner")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("manager")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isOwnerRole("owner")).toBe(true);
    expect(isOwnerRole("admin")).toBe(false);
  });

  it("derives team tile initials", () => {
    expect(teamInitial("Shiroha Lab")).toBe("SL");
    expect(teamInitial("side-project")).toBe("SP");
    expect(teamInitial("mint")).toBe("M");
    expect(teamInitial("白羽实验室")).toBe("白");
    expect(teamInitial("  ")).toBe("?");
  });
});

describe("invites & join codes", () => {
  const now = 1_800_000_000_000;
  it("computes invite status with accepted > revoked > expired > pending", () => {
    expect(inviteStatus({ accepted_at: null, revoked_at: null, expires_at: now + 1 }, now)).toBe("pending");
    expect(inviteStatus({ accepted_at: null, revoked_at: null, expires_at: now }, now)).toBe("expired");
    expect(inviteStatus({ accepted_at: null, revoked_at: now - 5, expires_at: now - 1 }, now)).toBe("revoked");
    expect(inviteStatus({ accepted_at: now - 9, revoked_at: now - 5, expires_at: now - 1 }, now)).toBe("accepted");
  });

  it("computes join code status", () => {
    expect(joinCodeStatus({ revoked_at: null, expires_at: null }, now)).toBe("active");
    expect(joinCodeStatus({ revoked_at: null, expires_at: now + 1 }, now)).toBe("active");
    expect(joinCodeStatus({ revoked_at: null, expires_at: now - 1 }, now)).toBe("expired");
    expect(joinCodeStatus({ revoked_at: now - 1, expires_at: now - 1 }, now)).toBe("revoked");
  });

  it("builds the setup snippet without a trailing slash", () => {
    const s = joinSnippet("https://hub.example.com/", "abj_0123456789abcdefghijklmnop");
    expect(s.split("\n")).toEqual([INSTALL_LINE, "agentbus setup --hub https://hub.example.com --join-code abj_0123456789abcdefghijklmnop"]);
  });

  it("matches the delete confirmation exactly (trimmed)", () => {
    expect(deleteConfirmMatches("Shiroha Lab", " Shiroha Lab ")).toBe(true);
    expect(deleteConfirmMatches("Shiroha Lab", "shiroha lab")).toBe(false);
    expect(deleteConfirmMatches("Shiroha Lab", "Shiroha")).toBe(false);
    expect(deleteConfirmMatches("", "")).toBe(false);
  });
});
