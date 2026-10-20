package hub

import (
	"bytes"
	"embed"
	"fmt"
	"strings"
	"text/template"
	"time"
)

//go:embed prompts/*.md
var promptFS embed.FS

var promptTmpl = template.Must(template.New("").ParseFS(promptFS, "prompts/*.md"))

// PromptInput is everything a round prompt is built from.
type PromptInput struct {
	Ctx         *Context
	Deliveries  []Delivery // the deliveries claimed for this round
	Round       string     // AGENTBUS_ROUND
	Exe         string     // path of this agentbus binary
	WorkdirNote string     // set when no repo mapping was found
	MemberID    string
}

type promptPost struct {
	ID, Author, Kind, When, ReplyTo, Body string
	Mine                                  bool
}

type promptDelivery struct {
	PostID, ReasonText, Author, Body, Quoted string
	Attempts, Attempt                        int
}

type promptData struct {
	Me                      Member
	RoleName                string
	Workspace               Workspace
	Thread                  Thread
	Repo, Branch            string
	Assignee                string
	IAmAssignee             bool
	Posts                   []promptPost
	HasMore                 bool
	FirstPostID             string
	Deliveries              []promptDelivery
	Round, Exe, WorkdirNote string
}

var reasonText = map[string]string{
	"mention": "你被 @ 了",
	"assign":  "你是负责人",
	"reply":   "有人回复了你",
	"event":   "系统事件",
}

// BuildPrompt renders common.md (+ manager.md for managers) + round.md.
func BuildPrompt(in PromptInput) (string, error) {
	c := in.Ctx
	names := map[string]string{}
	for _, m := range c.Members {
		names[m.ID] = m.Name
	}
	names[c.Me.ID] = c.Me.Name
	me := c.Me
	if me.ID == "" {
		me.ID = in.MemberID
	}
	name := func(id string) string {
		if n := names[id]; n != "" {
			return n
		}
		return id
	}
	d := promptData{
		Me: me, Workspace: c.Workspace, Thread: c.Thread, HasMore: c.HasMore,
		Round: in.Round, Exe: in.Exe, WorkdirNote: in.WorkdirNote,
		RoleName: map[string]string{"manager": "Manager", "admin": "管理员"}[me.Role],
	}
	if d.RoleName == "" {
		d.RoleName = "agent"
	}
	if c.Workspace.Repo != nil {
		d.Repo = *c.Workspace.Repo
	}
	if c.Workspace.Branch != nil {
		d.Branch = *c.Workspace.Branch
	}
	if a := c.Thread.AssigneeID; a != nil && *a != "" {
		d.Assignee = name(*a)
		d.IAmAssignee = *a == me.ID
	}
	byID := map[string]Post{}
	for i, p := range c.Posts {
		byID[p.ID] = p
		if i == 0 {
			d.FirstPostID = p.ID
		}
		pp := promptPost{ID: p.ID, Author: name(p.AuthorID), Kind: p.Kind, Body: strings.TrimSpace(p.Body),
			When: time.UnixMilli(p.CreatedAt).Local().Format("01-02 15:04"), Mine: p.AuthorID == me.ID}
		if p.ReplyTo != nil {
			pp.ReplyTo = *p.ReplyTo
		}
		d.Posts = append(d.Posts, pp)
	}
	for _, dl := range in.Deliveries {
		pd := promptDelivery{PostID: dl.PostID, ReasonText: firstNonEmpty(reasonText[dl.Reason], dl.Reason),
			Attempts: dl.Attempts, Attempt: dl.Attempts + 1}
		if p, ok := byID[dl.PostID]; ok {
			pd.Author = name(p.AuthorID)
			pd.Body = strings.TrimSpace(p.Body)
			pd.Quoted = quote(pd.Body)
		} else {
			pd.Body = "（这条帖子不在上面的最近列表里，用 `agentbus thread show` 往前翻）"
			pd.Quoted = pd.Body
		}
		d.Deliveries = append(d.Deliveries, pd)
	}
	var b bytes.Buffer
	if err := promptTmpl.ExecuteTemplate(&b, "common.md", d); err != nil {
		return "", err
	}
	if me.Role == "manager" {
		b.WriteString("\n")
		if err := promptTmpl.ExecuteTemplate(&b, "manager.md", d); err != nil {
			return "", err
		}
	}
	b.WriteString("\n")
	if err := promptTmpl.ExecuteTemplate(&b, "round.md", d); err != nil {
		return "", err
	}
	return b.String(), nil
}

func quote(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = "> " + l
	}
	return strings.Join(lines, "\n")
}

// ---- usage footer ----

// UsageFooter renders the small usage line appended to progress posts, e.g.
// `本轮 31.2k 输入（缓存 28k）/ 0.9k 输出 · 约 $0.04 · 2m13s`.
func UsageFooter(u *UsageView, d time.Duration) string {
	var parts []string
	if u != nil && u.Known {
		in := fmt.Sprintf("本轮 %s 输入", FmtTokens(u.TotalInput))
		if u.Cached > 0 {
			in += fmt.Sprintf("（缓存 %s）", FmtTokens(u.Cached))
		} else {
			in += " "
		}
		in += fmt.Sprintf("/ %s 输出", FmtTokens(u.Output))
		parts = append(parts, in)
		if u.Cost != nil {
			parts = append(parts, "约 "+FmtUSD(*u.Cost))
		}
	} else {
		parts = append(parts, "本轮用量未知")
	}
	parts = append(parts, FmtDuration(d))
	return strings.Join(parts, " · ")
}

// UsageView is the footer's input.
type UsageView struct {
	Known      bool
	TotalInput int64
	Cached     int64
	Output     int64
	Cost       *float64
}

// FmtTokens: 42, 0.9k, 31.2k, 1.2M.
func FmtTokens(n int64) string {
	switch {
	case n < 100:
		return fmt.Sprintf("%d", n)
	case n < 1_000_000:
		return trimZero(fmt.Sprintf("%.1f", float64(n)/1000)) + "k"
	}
	return trimZero(fmt.Sprintf("%.1f", float64(n)/1_000_000)) + "M"
}

func trimZero(s string) string { return strings.TrimSuffix(s, ".0") }

// FmtUSD: $0.04, <$0.01.
func FmtUSD(f float64) string {
	if f > 0 && f < 0.005 {
		return "<$0.01"
	}
	return fmt.Sprintf("$%.2f", f)
}

// FmtDuration: 45s, 2m13s, 1h02m.
func FmtDuration(d time.Duration) string {
	s := int64(d.Round(time.Second) / time.Second)
	switch {
	case s < 60:
		return fmt.Sprintf("%ds", s)
	case s < 3600:
		return fmt.Sprintf("%dm%02ds", s/60, s%60)
	}
	return fmt.Sprintf("%dh%02dm", s/3600, (s%3600)/60)
}
