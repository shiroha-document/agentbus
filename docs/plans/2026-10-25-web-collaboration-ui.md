# 网页中英与协作可见性实现计划

> 给执行代理：使用 sea-data-ai-coding:subagent-driven-development，逐任务实现、规格审查、代码质量审查。不得并发修改产品代码。

**目标：** 按已确认设计交付网页中英、类别头像、紧凑状态、投递回执与成员模型。
**架构：** 复用 React/Radix/Lucide 和现有 UI tokens。语言在浏览器持久化；历史帖子、投递、模型数据保持现有协议，worker 只增加按页查询与有来源时间的成员模型字段。
**技术栈：** React、TypeScript、Vite、Hono、D1、Vitest，Node 22、pnpm 10.34.7。
**GAT Flow：** 使用当前 GAT CLI 支持的 goals 与 Harness Session；先查询命令版本，若已无 flows 则以当前 gat:test 的 goal 索引和报告承接。
**GAT 测试授权：** 前置任务完成后立即测试（用户已要求弄好发布，方案原有验证要求）。
**自动修复授权：** 是，限定本次 code owner 变更，发现问题后修复并重跑受影响范围。

设计：docs/design/bilingual-collaboration.md。中文/英文教程 PR #2 与 CLI PR #1 已独立交付。

### D1 [开发]：头像类别与状态 banner
**depends_on：** []
**文件：** hub/web/src/components/ui/Avatar.tsx、components/post/Cards.tsx、components/PostItem.tsx、pages/Thread.tsx；必要时新增 components/thread/StatePanel.tsx、lib/state.ts；测试 lib/__tests__/collaboration-ui.test.tsx。
- [ ] 写并运行失败测试：头像 human/agent/unknown 类型、有图/无图；state 默认折叠且不在常规聊天头像内、顶部只有一个当前状态，正文保留旧 post.body。
- [ ] 实现人类圆形、agent 圆角方形且有机器人标识、图片失败回退与 URL 改变恢复。16px 保留形状可辨。未知类别保持中性。所有 Avatar 调用继续类型兼容。
- [ ] state 独立紧凑 banner，保留 post-id、时间和 revisions；点击/键盘展开该条保留正文。顶部当前状态在桌面与移动消息前仅一份，摘要折叠、编辑沿用 API；不冒用 thread.updated_at。
- [ ] 运行 npx -y pnpm@10.34.7 --filter web test、--filter web typecheck 和 --filter web build；审查规格和质量后提交独立 PR。

### D2 [开发]：统一中英语言
**depends_on：** [D1]
**文件：** hub/web/src/lib/i18n.ts、components/layout/LanguageToggle.tsx、main.tsx、layout/Layout.tsx、pages/Welcome.tsx、pages/settings/PreferencesSection.tsx、lib/format.ts、lib/posts.ts、lib/team.ts；其余系统文案所在页面/组件/api.ts 按统一字典转换。
- [ ] 失败测试验证浏览器 zh 开头/其他语言选择、存储不可用/无效值、设置持久化与订阅更新、英文安装提示词和 /en/guide/onboarding 链接。
- [ ] 实现带类型的文案字典，覆盖页面/表单/toast/错误码/空态/辅助阅读标签；语言切换同步 html lang；Intl 时间数字格式跟随偏好，成员正文和未知错误保持原文。
- [ ] 运行完整 web test/typecheck/build；扫描英文系统文案和代码常量以识别未翻译输出。审查后提交 PR。

### D3 [开发]：按已加载页面查看投递回执
**depends_on：** [D2]
**文件：** hub/worker/src/live.ts、routes/web.ts、hub/web/src/api.ts、queries.ts、pages/Thread.tsx、components/live/ReceiptTicks.tsx、lib/live.ts；worker/web 相关 Vitest 测试。
- [ ] 失败测试覆盖批量最多 100 个 ID、跨团队/跨串 ID 不泄露、无参数维持最近 30 条、pending/received/working/done/dead。
- [ ] 对所有已加载有投递的消息显示紧凑计数，点击/键盘/触屏打开接收者列表，注明 received=领取投递。分批查询历史页，详情打开刷新；复用 2s/15s/后台暂停策略。无投递记录不推断未读。
- [ ] 运行 worker/web test、递归 typecheck 和 web build，审查后提交 PR。

### D4 [开发]：成员上报与历史模型
**depends_on：** [D3]
**文件：** hub/worker/src/routes/web.ts、members.ts、hub/web/src/types.ts、pages/Members.tsx、pages/MemberDetail.tsx、components/post/Badges.tsx；相关 worker/web 测试。
- [ ] 失败测试覆盖新鲜活动、过期活动、最近 run、无模型、模型切换和跨团队查询。
- [ ] 只对本团队成员查询新鲜活动 model，否则 last_run model；带来源标签和时间，无值显示尚未上报。历史消息仅用 post.model/usage.model，不用成员当前模型回填。
- [ ] 运行 worker/web test、递归 typecheck、build、wrangler production dry-run；规格与质量审查后提交 PR。

### T5 [GAT 测试]：网页全需求
**depends_on：** [D1, D2, D3, D4]
**范围：** 上述五项网页需求，在本地 mock 完成桌面/手机、深浅色、无鼠标、空态/失败/持久化验证；真实投递及模型上报仅在已授权测试环境验证。
**执行：** 查询 gat --help / gat goals --help，遵从当前 gat:test skill；若 flows 可用则恢复同一 Flow，遵从 next_action；正式执行前按实际 CLI 完成其 Review/Coverage 指令，不虚构旧流程的门禁。
**完成条件：** goal 索引/覆盖报告与独立 review 给出终态；不可用前置条件精确列出，不宣称上线已通过。
- [ ] 保留稳定入口与操作最终态截图、DOM/读回证据，生成 goal 范围覆盖报告，交独立 reviewer。

### D6 [开发]：发布准备与 Windows 补验
**depends_on：** []
**文件：** .github/workflows/ci.yml（如需要在 CLI PR 中补 Windows runtime job），review 下发布说明与状态记录。
- [ ] 在 Windows PS 5.1/7 测试下载后执行和 irm|iex 路径，用临时安装目录/测试 release，不注册真实身份/定时任务；结果回 CLI 子串，保持 pioneer 为唯一负责人。
- [ ] 实时核对 #1/#2 head 和 CI。教程独立合并会触发 Pages 部署；发布确认精确列出 PR/head/自动部署/验证路径。网页 PR 验收完成后才进入发布确认范围。
- [ ] agentbus confirm 批准后的下一轮再合并/发布；发布后核对 /en/ 与中文章节、healthz/版本和相关 CI 最终态。

依赖：D1→D2→D3→D4→T5；D6 独立，CLI Windows 补验不阻塞教程准备。网页发布依赖 T5 与对应 confirm，教程发布依赖其现有验证和 confirm；CLI release 依赖 Windows 实测与 confirm。当前轮次不得把尚未实现的 D2-D4 写成完成。
