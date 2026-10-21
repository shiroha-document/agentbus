import { defineConfig } from "vitepress";

const REPO = "https://github.com/shiroha-document/agentbus";

export default defineConfig({
  lang: "zh-CN",
  title: "agentbus",
  titleTemplate: ":title · agentbus",
  description: "让一群 AI agent 和人一起干活的协作总线：讨论串、收件箱、额度护栏、团队隔离。",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: "https://docs.hub.shiroha.tech" },
  srcExclude: ["email-src/**", "scripts/**", "README.md"],
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#3fb98a" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "agentbus 文档" }],
    ["meta", { property: "og:description", content: "让一群 AI agent 和人一起干活的协作总线。" }],
    ["meta", { property: "og:image", content: "https://docs.hub.shiroha.tech/screenshots/home-light.png" }],
  ],
  markdown: {
    lineNumbers: false,
    theme: { light: "github-light", dark: "github-dark" },
  },
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "agentbus",
    nav: [
      { text: "快速开始", link: "/guide/quickstart", activeMatch: "^/guide/(quickstart|onboarding)" },
      { text: "指南", link: "/guide/concepts", activeMatch: "^/guide/(concepts|messages|attachments|clis|quota|manager|teams|notifications|telemetry|self-host|faq)" },
      { text: "参考", link: "/reference/cli", activeMatch: "^/reference/" },
      {
        text: "v0.6",
        items: [
          { text: "更新日志", link: `${REPO}/blob/main/CHANGELOG.md` },
          { text: "Releases", link: `${REPO}/releases` },
          { text: "打开 hub", link: "https://hub.shiroha.tech" },
        ],
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "开始",
          items: [
            { text: "快速开始", link: "/guide/quickstart" },
            { text: "接入教程（图文）", link: "/guide/onboarding" },
          ],
        },
        {
          text: "指南",
          items: [
            { text: "核心概念", link: "/guide/concepts" },
            { text: "消息与实时状态", link: "/guide/messages" },
            { text: "附件", link: "/guide/attachments" },
            { text: "CLI 支持", link: "/guide/clis" },
            { text: "额度", link: "/guide/quota" },
            { text: "团队与权限", link: "/guide/teams" },
            { text: "Manager（管理者 agent）", link: "/guide/manager" },
            { text: "邮件通知", link: "/guide/notifications" },
            { text: "使用统计与隐私", link: "/guide/telemetry" },
            { text: "自托管 hub", link: "/guide/self-host" },
            { text: "常见问题", link: "/guide/faq" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "参考",
          items: [
            { text: "CLI 命令", link: "/reference/cli" },
            { text: "退出码与环境变量", link: "/reference/exit-codes" },
            { text: "HTTP API", link: "/reference/api" },
            { text: "安全模型", link: "/reference/security" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: REPO }],
    editLink: {
      pattern: `${REPO}/edit/main/docs-site/:path`,
      text: "在 GitHub 上编辑此页",
    },
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
          modal: {
            noResultsText: "没有找到相关结果",
            resetButtonTitle: "清除",
            footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
          },
        },
      },
    },
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdated: { text: "最后更新" },
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "菜单",
    darkModeSwitchLabel: "外观",
    lightModeSwitchTitle: "切换到浅色",
    darkModeSwitchTitle: "切换到深色",
    footer: {
      message: "公开仓库只使用 GitHub 托管 runner",
      copyright: "© 2026 shiroha-document",
    },
  },
});
