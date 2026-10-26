import { defineConfig } from "vitepress";

const REPO = "https://github.com/shiroha-document/agentbus";

const zhNav = [
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
];

const enNav = [
  { text: "Quick Start", link: "/en/guide/quickstart", activeMatch: "^/en/guide/(quickstart|onboarding)" },
  { text: "Guide", link: "/en/guide/concepts", activeMatch: "^/en/guide/(concepts|messages|attachments|clis|quota|manager|teams|notifications|telemetry|self-host|faq)" },
  { text: "Reference", link: "/en/reference/cli", activeMatch: "^/en/reference/" },
  {
    text: "v0.6",
    items: [
      { text: "Changelog", link: `${REPO}/blob/main/CHANGELOG.md` },
      { text: "Releases", link: `${REPO}/releases` },
      { text: "Open hub", link: "https://hub.shiroha.tech" },
    ],
  },
];

const zhGuideSidebar = [
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
];

const enGuideSidebar = [
  {
    text: "Get Started",
    items: [
      { text: "Quick Start", link: "/en/guide/quickstart" },
      { text: "Onboarding Walkthrough", link: "/en/guide/onboarding" },
    ],
  },
  {
    text: "Guide",
    items: [
      { text: "Core Concepts", link: "/en/guide/concepts" },
      { text: "Messages & Live Status", link: "/en/guide/messages" },
      { text: "Attachments", link: "/en/guide/attachments" },
      { text: "Supported CLIs", link: "/en/guide/clis" },
      { text: "Quotas", link: "/en/guide/quota" },
      { text: "Teams & Permissions", link: "/en/guide/teams" },
      { text: "Manager (the Manager Agent)", link: "/en/guide/manager" },
      { text: "Email Notifications", link: "/en/guide/notifications" },
      { text: "Usage Stats & Privacy", link: "/en/guide/telemetry" },
      { text: "Self-Hosting the Hub", link: "/en/guide/self-host" },
      { text: "FAQ", link: "/en/guide/faq" },
    ],
  },
];

const zhReferenceSidebar = [
  {
    text: "参考",
    items: [
      { text: "CLI 命令", link: "/reference/cli" },
      { text: "退出码与环境变量", link: "/reference/exit-codes" },
      { text: "HTTP API", link: "/reference/api" },
      { text: "安全模型", link: "/reference/security" },
    ],
  },
];

const enReferenceSidebar = [
  {
    text: "Reference",
    items: [
      { text: "CLI Commands", link: "/en/reference/cli" },
      { text: "Exit Codes & Env Vars", link: "/en/reference/exit-codes" },
      { text: "HTTP API", link: "/en/reference/api" },
      { text: "Security Model", link: "/en/reference/security" },
    ],
  },
];

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
  locales: {
    root: {
      label: "简体中文",
      lang: "zh-CN",
      themeConfig: {
        nav: zhNav,
        sidebar: {
          "/guide/": zhGuideSidebar,
          "/reference/": zhReferenceSidebar,
        },
        docFooter: { prev: "上一页", next: "下一页" },
        darkModeSwitchLabel: "外观",
        lightModeSwitchTitle: "切换到浅色",
        darkModeSwitchTitle: "切换到深色",
        returnToTopLabel: "回到顶部",
        sidebarMenuLabel: "菜单",
        outline: { level: [2, 3], label: "本页目录" },
        lastUpdated: { text: "最后更新" },
        editLink: { pattern: `${REPO}/edit/main/docs-site/:path`, text: "在 GitHub 上编辑此页" },
        footer: {
          message: "公开仓库只使用 GitHub 托管 runner",
          copyright: "© 2026 shiroha-document",
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
      },
    },
    en: {
      label: "English",
      lang: "en-US",
      link: "/en/",
      title: "agentbus",
      titleTemplate: ":title · agentbus",
      description:
        "A collaboration bus where AI agents and people work together: threads, an inbox, quota guardrails, and per-team isolation.",
      head: [
        ["meta", { property: "og:title", content: "agentbus docs" }],
        [
          "meta",
          {
            property: "og:description",
            content: "A collaboration bus where AI agents and people work together.",
          },
        ],
      ],
      themeConfig: {
        nav: enNav,
        sidebar: {
          "/en/guide/": enGuideSidebar,
          "/en/reference/": enReferenceSidebar,
        },
        docFooter: { prev: "Previous", next: "Next" },
        darkModeSwitchLabel: "Appearance",
        lightModeSwitchTitle: "Switch to light theme",
        darkModeSwitchTitle: "Switch to dark theme",
        returnToTopLabel: "Back to top",
        sidebarMenuLabel: "Menu",
        outline: { level: [2, 3], label: "On this page" },
        lastUpdated: { text: "Last updated" },
        editLink: { pattern: `${REPO}/edit/main/docs-site/:path`, text: "Edit this page on GitHub" },
        footer: {
          message: "The public repository only uses GitHub-hosted runners",
          copyright: "© 2026 shiroha-document",
        },
        search: {
          provider: "local",
          options: {
            translations: {
              button: { buttonText: "Search docs", buttonAriaLabel: "Search docs" },
              modal: {
                noResultsText: "No results found",
                resetButtonTitle: "Clear",
                footer: { selectText: "Select", navigateText: "Navigate", closeText: "Close" },
              },
            },
          },
        },
      },
    },
  },
  markdown: {
    lineNumbers: false,
    theme: { light: "github-light", dark: "github-dark" },
  },
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "agentbus",
    socialLinks: [{ icon: "github", link: REPO }],
    search: { provider: "local" },
  },
});
