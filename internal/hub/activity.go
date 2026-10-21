package hub

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/quota"
)

// activityTimeout bounds one live-status report; they are best effort.
var activityTimeout = 3 * time.Second

// activity reports a live-status state for thread (contract §3). Errors are
// logged and ignored; after a 404 (a hub older than v0.6) the rest of the
// tick sends none.
func (t *Ticker) activity(ctx context.Context, thread, state, detail, model string) {
	if t.DryRun || t.activityOff {
		return
	}
	actx, cancel := context.WithTimeout(ctx, activityTimeout)
	defer cancel()
	err := t.Client.Activity(actx, ActivityReq{ThreadID: thread, State: state, Detail: detail,
		CLI: label64(t.Cfg.CLI), Model: label64(model)})
	switch {
	case err == nil:
	case IsStatus(err, http.StatusNotFound):
		t.activityOff = true
		t.logf("the hub does not take live status (404); not reporting it this tick")
	default:
		t.logf("%s: activity %s: %v", thread, state, err)
	}
}

// runningDetail is the "running" detail: "<cli> · <model>", or the cli
// alone when the model is unknown.
func runningDetail(cli, model string) string {
	if model == "" {
		return cli
	}
	return cli + " · " + model
}

// failDetail is a failed round's activity detail: one line, no secrets, at
// most 120 characters.
func failDetail(summary string) string {
	s := quota.Scrub(firstNonEmpty(summary, "failed"))
	if r := []rune(s); len(r) > 120 {
		s = string(r[:119]) + "…"
	}
	return s
}

// knownModel is the model this agent's CLI runs, when known: the config's,
// else the newest one a run reported (this tick's first, then usage.jsonl).
func (t *Ticker) knownModel() string {
	if m := strings.TrimSpace(t.Cfg.Model); m != "" {
		return m
	}
	if t.lastModel != "" {
		return t.lastModel
	}
	es, _ := ReadUsage(t.paths().Usage())
	for i := len(es) - 1; i >= 0; i-- {
		if r := es[i].Run; r.CLI == t.Cfg.CLI && r.Model != nil && strings.TrimSpace(*r.Model) != "" {
			return strings.TrimSpace(*r.Model)
		}
	}
	return ""
}

// label64 keeps a cli/model label within the hub's 64-character limit.
func label64(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 64 {
		s = string(r[:64])
	}
	return s
}

// Tick-authored failure notices start with one of these.
const (
	noticeStart   = "agentbus tick 无法启动 "
	noticeTimeout = "⏱ 本轮超时："
	noticeFailed  = "本轮失败："
)

func isTickNotice(body string) bool {
	for _, p := range []string{noticeStart, noticeTimeout, noticeFailed} {
		if strings.HasPrefix(body, p) {
			return true
		}
	}
	return false
}

// noopRedelivery is the rule for skipping the tick's fallback progress post
// after a successful round in which the agent posted nothing itself: every
// delivery is a re-delivery (attempts ≥ 1), every delivered post is in the
// context, and my newest post there is a progress post — not one of the
// tick's failure notices — written (or last collapsed into) no earlier than
// every delivered post. An earlier attempt already answered these messages
// (its ack was lost or its lease ran out), so another fallback post would
// only repeat it. Failure and timeout notices are always posted.
func noopRedelivery(c *Context, ds []Delivery, me string) bool {
	if len(ds) == 0 {
		return false
	}
	var mine *Post
	at := map[string]int64{}
	for i := range c.Posts {
		p := &c.Posts[i]
		at[p.ID] = p.CreatedAt
		if p.AuthorID == me && (mine == nil || p.CreatedAt >= mine.CreatedAt) {
			mine = p
		}
	}
	if mine == nil || mine.Kind != "progress" || isTickNotice(mine.Body) {
		return false
	}
	answered := mine.CreatedAt
	if mine.EditedAt != nil && *mine.EditedAt > answered {
		answered = *mine.EditedAt
	}
	for _, d := range ds {
		pa, ok := at[d.PostID]
		if d.Attempts < 1 || !ok || pa > answered {
			return false
		}
	}
	return true
}
