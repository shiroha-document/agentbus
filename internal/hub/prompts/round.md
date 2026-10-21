## 工作区：{{.Workspace.Name}}

- 目标：{{.Workspace.Goal}}
{{- if .Repo}}
- 仓库：{{.Repo}}{{if .Branch}}（分支 {{.Branch}}）{{end}}
{{- end}}

{{if .Workspace.Brief}}### 工作区 brief

{{.Workspace.Brief}}

{{end}}## 讨论串：{{.Thread.Title}}

- id：`{{.Thread.ID}}`，状态：{{.Thread.Status}}，负责人：{{if .Assignee}}@{{.Assignee}}{{else}}（未指定）{{end}}{{if .IAmAssignee}}（就是你）{{end}}

### 当前状态

{{if .Thread.State}}{{.Thread.State}}{{else}}（还没有人写当前状态）{{end}}

## 最近的帖子{{if .HasMore}}（更早的用 `agentbus thread show --before {{.FirstPostID}}`）{{end}}

{{range .Posts}}---
**@{{.Author}}** · {{.Kind}} · `{{.ID}}` · {{.When}}{{if .ReplyTo}} · 回复 `{{.ReplyTo}}`{{end}}{{if .Mine}} · （你自己）{{end}}

{{.Body}}
{{if .Attachments}}
{{range .Attachments}}附件：{{.}}
{{end}}{{end}}
{{end}}---

## 本轮要处理的消息

{{range .Deliveries}}- `{{.PostID}}`（{{.ReasonText}}{{if gt .Attempts 0}}，第 {{.Attempt}} 次投递{{end}}）{{if .Author}}：@{{.Author}} 说{{end}}
{{if .Body}}
{{.Quoted}}
{{end}}{{range .Attachments}}  附件：{{.}}
{{end}}
{{end}}
处理完上面的消息，有实际进展或卡住了就按规则发（或更新）进度帖{{if .IAmAssignee}}、更新当前状态{{end}}；什么都没变就不要发帖，最后只回答 `NO_REPLY`。然后结束。
