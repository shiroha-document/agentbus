import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { DEFAULT_EMAIL_ASSET_BASE, KIND_LABELS, renderEmail, resolveLink, type EmailItem } from "../src/email";

const env = { PUBLIC_URL: "https://hub.example.com" } as Env;
const team = { id: "tm_1", name: "星河研发组" };

const sample = (n: number, link = "/threads/t_x"): EmailItem[] =>
  Array.from({ length: n }, (_, i) => ({ title: `标题 ${i + 1}`, text: `第一行 ${i + 1}\n第二行`, link }));

const imgs = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];
const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);

describe("renderEmail: every kind", () => {
  const kinds = [...Object.keys(KIND_LABELS), "some_future_kind"];
  for (const kind of kinds) {
    for (const n of [1, 3]) {
      it(`${kind} × ${n}`, () => {
        const r = renderEmail(env, kind, sample(n), { team });
        expect(r.subject.startsWith("[agentbus · 星河研发组] ")).toBe(true);
        expect(r.html).toMatch(/^<!doctype html>/);
        expect(r.html).toContain('name="color-scheme"');
        expect(r.html).toContain("prefers-color-scheme:dark");
        expect(r.html).not.toContain("<svg");
        expect(r.html).not.toMatch(/<script/i);
        for (let i = 1; i <= n; i++) {
          expect(r.html).toContain(`标题 ${i}`);
          expect(r.text).toContain(`标题 ${i}`);
        }
        const name = KIND_LABELS[kind] ? kind : "generic";
        expect(r.html).toContain(`${DEFAULT_EMAIL_ASSET_BASE}/hero-${name}.png`);
        expect(r.html).toContain(`${DEFAULT_EMAIL_ASSET_BASE}/icon-${name}.png`);
        expect(r.html).toContain(`${DEFAULT_EMAIL_ASSET_BASE}/logo.png`);
        // never leak the raw machine id of an unknown kind into the headline / subject
        if (!KIND_LABELS[kind]) expect(r.html + r.subject).not.toContain("some_future_kind");
      });
    }
  }

  it("renders with no items and no PUBLIC_URL without throwing", () => {
    const r = renderEmail({} as Env, "agent_offline", []);
    expect(r.subject).toBe("[agentbus] agent 离线");
    expect(r.html).not.toContain('href=""');
  });
});

describe("images", () => {
  it("every <img> has non-empty alt, width and height and a background colour", () => {
    for (const kind of [...Object.keys(KIND_LABELS), "x_unknown"]) {
      for (const n of [1, 2]) {
        const list = imgs(renderEmail(env, kind, sample(n), { team }).html);
        expect(list.length).toBeGreaterThanOrEqual(2 + n);
        for (const tag of list) {
          expect(tag).toMatch(/\salt="[^"]+"/);
          expect(tag).toMatch(/\swidth="\d+"/);
          expect(tag).toMatch(/\sheight="\d+"/);
          expect(tag).toMatch(/background-color:#[0-9a-f]{6}/i);
        }
      }
    }
  });

  it("alt text is Chinese", () => {
    const list = imgs(renderEmail(env, "confirm_request", sample(1)).html);
    for (const tag of list) expect(/alt="([^"]*)"/.exec(tag)![1]).toMatch(/[一-鿿]/);
  });

  it("EMAIL_ASSET_BASE overrides the image host (trailing slash tolerated)", () => {
    const r = renderEmail({ ...env, EMAIL_ASSET_BASE: "https://cdn.example.com/mail/" } as Env, "delivery_dead", sample(1));
    const srcs = imgs(r.html).map((t) => /src="([^"]*)"/.exec(t)![1]);
    expect(srcs).toContain("https://cdn.example.com/mail/hero-delivery_dead.png");
    expect(srcs).toContain("https://cdn.example.com/mail/icon-delivery_dead.png");
    expect(srcs.every((s) => s.startsWith("https://cdn.example.com/mail/"))).toBe(true);
    expect(r.html).not.toContain(DEFAULT_EMAIL_ASSET_BASE);
  });
});

describe("escaping", () => {
  it("escapes <script> in titles, text and team name", () => {
    const r = renderEmail(env, "confirm_request", [{ title: "<script>alert(1)</script>", text: "<img src=x onerror=alert(2)> & \"q\"", link: "/threads/t" }], {
      team: { id: "tm_1", name: "<b>evil</b>" },
    });
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).not.toContain("<b>evil</b>");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.html).toContain("&lt;img src=x onerror=alert(2)&gt; &amp; &quot;q&quot;");
    expect(r.html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    // plain text stays raw (it is not HTML)
    expect(r.text).toContain("<script>alert(1)</script>");
  });

  it("quotes in links cannot break out of the href attribute", () => {
    const r = renderEmail(env, "agent_unresponsive", [{ title: "t", link: '/threads/t"><script>x</script>' }]);
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).toContain("/threads/t&quot;&gt;&lt;script&gt;");
    for (const h of hrefs(r.html)) expect(h).not.toContain('"');
  });

  it("drops javascript: and protocol-relative links", () => {
    for (const link of ["javascript:alert(1)", "//evil.example.com/x", "data:text/html,hi"]) {
      const r = renderEmail(env, "flood_blocked", [{ title: "t", link }]);
      expect(r.html).not.toContain("javascript:");
      expect(r.html).not.toContain("evil.example.com");
      expect(r.html).not.toContain("data:text/html");
      expect(r.text).not.toContain(link);
    }
  });

  it("subject is a single line", () => {
    const r = renderEmail(env, "test", [{ title: "line1\nline2\r\n\tline3" }]);
    expect(r.subject).toBe("[agentbus] line1 line2 line3");
  });
});

describe("team chip and ?team= links", () => {
  it("shows the team chip and appends team to hub links", () => {
    const r = renderEmail(env, "agent_offline", [{ title: "t", link: "/members/m_1" }], { team });
    expect(r.html).toContain('class="eb-chip"');
    expect(r.html).toContain("星河研发组");
    const hs = hrefs(r.html);
    expect(hs).toContain("https://hub.example.com/members/m_1?team=tm_1");
    expect(hs).toContain("https://hub.example.com/settings?team=tm_1");
    expect(hs).toContain("https://hub.example.com/?team=tm_1");
    expect(r.text).toContain("https://hub.example.com/members/m_1?team=tm_1");
    expect(r.text).toContain("通知设置：https://hub.example.com/settings?team=tm_1");
  });

  it("no team → no chip, no team param, plain [agentbus] subject", () => {
    const r = renderEmail(env, "agent_offline", [{ title: "t", link: "/members/m_1" }]);
    expect(r.html).not.toContain('class="eb-chip"');
    expect(r.html).not.toContain("team=");
    expect(r.text).not.toContain("team=");
    expect(r.subject).toBe("[agentbus] t");
    expect(hrefs(r.html)).toContain("https://hub.example.com/members/m_1");
  });

  it("preserves existing query strings and hashes", () => {
    const ctx = { team };
    expect(resolveLink(env, "/threads/t_1?post=p_9", ctx)).toBe("https://hub.example.com/threads/t_1?post=p_9&team=tm_1");
    expect(resolveLink(env, "/threads/t_1#p_9", ctx)).toBe("https://hub.example.com/threads/t_1?team=tm_1#p_9");
    expect(resolveLink(env, "/threads/t_1?a=1#p_9", ctx)).toBe("https://hub.example.com/threads/t_1?a=1&team=tm_1#p_9");
    expect(resolveLink(env, "/x?team=other", ctx)).toBe("https://hub.example.com/x?team=other");
    // absolute links into the hub get the team param as well
    expect(resolveLink(env, "https://hub.example.com/invite/inv_1", ctx)).toBe("https://hub.example.com/invite/inv_1?team=tm_1");
    expect(resolveLink({ PUBLIC_URL: "https://hub.example.com/" } as Env, "/a", ctx)).toBe("https://hub.example.com/a?team=tm_1");
  });

  it("team ids are URL-encoded", () => {
    expect(resolveLink(env, "/a", { team: { id: "a b&c", name: "x" } })).toBe("https://hub.example.com/a?team=a%20b%26c");
  });

  it("rendered html uses &amp; between query params", () => {
    const r = renderEmail(env, "confirm_request", [{ title: "t", link: "/threads/t_1?post=p_9#p_9" }], { team });
    expect(r.html).toContain('href="https://hub.example.com/threads/t_1?post=p_9&amp;team=tm_1#p_9"');
  });

  it("external absolute links are left untouched", () => {
    const ext = "https://docs.example.com/guide?x=1#y";
    expect(resolveLink(env, ext, { team })).toBe(ext);
    const r = renderEmail(env, "some_future_kind", [{ title: "t", link: ext }], { team });
    expect(hrefs(r.html)).toContain("https://docs.example.com/guide?x=1#y");
    expect(r.text).toContain(ext);
    // a lookalike host is not "the hub"
    expect(resolveLink(env, "https://hub.example.com.evil.example.com/x", { team })).toBe("https://hub.example.com.evil.example.com/x");
  });
});

describe("subjects", () => {
  it("single item → [agentbus] <title>", () => {
    expect(renderEmail(env, "join_request", [{ title: "代码审查助手申请加入" }]).subject).toBe("[agentbus] 代码审查助手申请加入");
  });
  it("merged → [agentbus] <label>（N 条）", () => {
    expect(renderEmail(env, "delivery_dead", sample(3)).subject).toBe("[agentbus] 消息投递失败（3 条）");
  });
  it("with team → [agentbus · team] …", () => {
    expect(renderEmail(env, "join_request", [{ title: "x 申请加入" }], { team }).subject).toBe("[agentbus · 星河研发组] x 申请加入");
    expect(renderEmail(env, "run_failures", sample(2), { team }).subject).toBe("[agentbus · 星河研发组] agent 连续运行失败（2 条）");
  });
  it("unknown kind, merged → generic label", () => {
    expect(renderEmail(env, "brand_new", sample(2)).subject).toBe("[agentbus] 新通知（2 条）");
  });
});

describe("plain text part", () => {
  it("single item: headline, lead, body lines, CTA link, footer", () => {
    const r = renderEmail(env, "confirm_request", [{ title: "builder 请求确认", text: "第一行\n第二行", link: "/threads/t_1" }], { team });
    const t = r.text;
    expect(t.startsWith("agentbus · 星河研发组\n")).toBe(true);
    expect(t).toContain("有 agent 在等你确认");
    expect(t).toContain("builder 请求确认\n第一行\n第二行\n去确认：https://hub.example.com/threads/t_1?team=tm_1");
    expect(t).toContain("打开 hub：https://hub.example.com/?team=tm_1");
    expect(t).toContain("通知设置：https://hub.example.com/settings?team=tm_1");
    expect(t).toContain("星河研发组");
    expect(t).not.toMatch(/<[a-z]/i);
  });

  it("merged: numbered items with indented body", () => {
    const t = renderEmail(env, "agent_offline", sample(2, "/members/m_1")).text;
    expect(t).toContain("1. 标题 1\n   第一行 1\n   第二行\n   查看成员：https://hub.example.com/members/m_1");
    expect(t).toContain("2. 标题 2");
  });

  it("email_change keeps the token link; invite omits notification settings", () => {
    const confirm = "https://hub.example.com/api/v1/web/settings/email/confirm?token=tok_123";
    const ec = renderEmail(env, "email_change", [{ title: "确认 agentbus 通知邮箱", text: "30 分钟内有效", link: confirm }]);
    expect(ec.text).toContain(`确认邮箱：${confirm}`);
    expect(ec.html).toContain("按钮点不开");
    expect(ec.html).toContain(`>${confirm}</a>`);

    const inv = renderEmail(env, "invite", [{ title: "alice 邀请你", link: "https://hub.example.com/invite/inv_1" }], { team });
    expect(inv.html).toContain("邀请你加入「星河研发组」");
    expect(inv.text).toContain("加入团队：https://hub.example.com/invite/inv_1?team=tm_1");
    expect(inv.text).not.toContain("通知设置");
    expect(inv.html).not.toContain("通知设置");
  });
});

describe("structure", () => {
  it("has a hidden preheader with the first item's text", () => {
    const r = renderEmail(env, "agent_offline", [{ title: "t", text: "已经 47 分钟没有任何请求" }]);
    expect(r.html).toMatch(/<div style="display:none;[^"]*">已经 47 分钟没有任何请求/);
  });

  it("single item → one primary CTA; merged → per-item buttons", () => {
    const one = renderEmail(env, "join_request", sample(1, "/members/m"));
    expect(one.html.match(/class="eb-btn"/g)?.length).toBe(1);
    expect(one.html).not.toContain('class="eb-btn2"');
    const many = renderEmail(env, "join_request", sample(3, "/members/m"));
    expect(many.html).not.toContain('class="eb-btn"');
    expect(many.html.match(/class="eb-btn2"/g)?.length).toBe(3);
    expect(many.html).toContain("共 3 条");
  });

  it("uses severity accents", () => {
    expect(renderEmail(env, "join_request", sample(1)).html).toContain("eb-hero-info");
    expect(renderEmail(env, "confirm_request", sample(1)).html).toContain("eb-hero-warn");
    expect(renderEmail(env, "secret_redacted", sample(1)).html).toContain("eb-hero-danger");
  });

  it("keeps body text whitespace (pre-wrap)", () => {
    expect(renderEmail(env, "run_failures", sample(1)).html).toContain("white-space:pre-wrap");
  });
});
