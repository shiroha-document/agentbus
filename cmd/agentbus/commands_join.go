package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/bus"
)

func init() {
	commands["join"] = cmdJoin
	commands["admin"] = cmdAdmin
	commands["members"] = cmdMembers
}

// cmdJoin: self-service onboarding. First call files the request; later calls
// (or --wait) complete it once a human approved.
func cmdJoin(c *cli, args []string) error {
	fs := newFlags("join")
	repo := fs.String("repo", "", "GitHub OWNER/REPO hosting the bus")
	remote := fs.String("remote", "", "ssh remote (default git@github.com:OWNER/REPO.git)")
	branch := fs.String("branch", "agent-bus", "")
	me := fs.String("me", "", "agent name")
	role := fs.String("role", "", "")
	caps := fs.String("cap", "", "comma-separated capabilities")
	chans := fs.String("channel", "", "comma-separated channels")
	wake := fs.String("wake", "poll", "daemon|poll|wait|manual")
	owner := fs.String("owner", "", "human owner GitHub login (gets notified)")
	desc := fs.String("desc", "", "")
	wait := fs.String("wait", "", "block up to this long for approval, e.g. 14m (exit 3 if still pending)")
	interval := fs.String("interval", "20s", "poll interval while waiting")
	noIssue := fs.Bool("no-issue", false, "never open the issue myself, just print the link")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	home := bus.Home()
	if _, err := bus.LoadConfig(home); err == nil {
		b, err := bus.Open(home)
		if err != nil {
			return err
		}
		c.emit(map[string]any{"state": "joined", "me": b.Me()}, func() { fmt.Fprintf(c.out, "already joined as %s\n", b.Me()) })
		return nil
	}
	st, err := bus.LoadJoin(home)
	if err != nil {
		return err
	}
	if st == nil || *me != "" && *me != st.Request.Name {
		if *me == "" {
			return &exitError{code: exitUsage, msg: "join needs --me NAME (and --repo OWNER/REPO or --remote URL)"}
		}
		var gh *bus.GitHub
		if !*noIssue {
			gh = bus.GitHubFromEnv("AGENTBUS_GITHUB_TOKEN")
		}
		st, err = bus.Join(bus.JoinOpts{Home: home, Repo: *repo, Remote: *remote, Branch: *branch, GH: gh,
			Request: bus.JoinRequest{Name: *me, Role: *role, Capabilities: splitList(*caps), Channels: splitList(*chans),
				Wake: *wake, Owner: *owner, Description: *desc}})
		if err != nil {
			return err
		}
		if !c.json {
			printJoinRequest(c, st)
		}
	}
	// try to complete
	deadline := time.Now()
	iv := 20 * time.Second
	if *wait != "" {
		d, err := parseDur(*wait)
		if err != nil {
			return err
		}
		deadline = deadline.Add(d)
		if iv, err = parseDur(*interval); err != nil {
			return err
		}
	}
	gh := bus.GitHubFromEnv("AGENTBUS_GITHUB_TOKEN")
	for {
		b, err := bus.CheckJoin(home, gh)
		if err == nil {
			c.emit(map[string]any{"state": "joined", "me": b.Me(), "remote": b.Cfg.Remote, "branch": b.Cfg.Branch}, func() {
				fmt.Fprintf(c.out, "approved — joined %s as %s. Next: read %s, then `agentbus inbox`.\n", b.Cfg.Remote, b.Me(), DocsURL)
			})
			return nil
		}
		if !errors.Is(err, bus.ErrJoinPending) {
			return err
		}
		if !time.Now().Before(deadline) {
			c.emit(map[string]any{"state": "pending", "me": st.Request.Name, "issue_url": st.IssueURL, "approve_url": st.NewURL}, func() {
				fmt.Fprintln(c.out, "pending approval; re-run `agentbus join --wait 14m` to keep waiting")
			})
			return &exitError{code: exitNothing}
		}
		time.Sleep(min(iv, time.Until(deadline)+time.Second))
	}
}

func printJoinRequest(c *cli, st *bus.JoinState) {
	fp, _ := bus.Fingerprint(st.Request.PublicKey)
	fmt.Fprintf(c.out, "join request for %q (key %s, kept in %s)\n\n", st.Request.Name, fp, st.KeyPath)
	switch {
	case st.IssueURL != "":
		fmt.Fprintf(c.out, "Ask your human to approve:  %s\n  (comment /approve — or /deny <reason>)\n", st.IssueURL)
	case st.NewURL != "":
		fmt.Fprintf(c.out, "Ask your human to open this link and press Submit (that is the approval):\n\n%s\n", st.NewURL)
	default:
		js, _ := json.MarshalIndent(st.Request, "", "  ")
		fmt.Fprintf(c.out, "Ask a bus admin to run:  agentbus admin approve --remote %s --request req.json\nwith req.json =\n%s\n"+
			"and to grant this public key push access to the repo:\n%s\n", st.Remote, js, st.Request.PublicKey)
	}
	fmt.Fprintln(c.out)
}

func cmdMembers(c *cli, _ []string) error {
	b, err := openSynced()
	if err != nil {
		return err
	}
	ms, _ := b.Members()
	c.emit(ms, func() {
		if len(ms) == 0 {
			fmt.Fprintln(c.out, "no membership records (open bus: anyone with push access)")
			return
		}
		for _, m := range ms {
			st := "member"
			if m.Revoked {
				st = "revoked by " + m.RevokedBy
			}
			fmt.Fprintf(c.out, "%-20s %-10s approved by %s %s  %s\n", m.Name, st, m.ApprovedBy, m.ApprovedAt.Format("2006-01-02"), m.KeySHA256)
		}
	})
	return nil
}

// ---- admin side ----

func cmdAdmin(c *cli, args []string) error {
	if len(args) == 0 {
		return &exitError{code: exitUsage, msg: "admin needs: approve | revoke | handle-issue"}
	}
	switch args[0] {
	case "approve":
		return adminApprove(c, args[1:])
	case "revoke":
		return adminRevoke(c, args[1:])
	case "handle-issue":
		return adminHandleIssue(c, args[1:])
	}
	return &exitError{code: exitUsage, msg: "unknown admin subcommand " + args[0]}
}

type adminFlags struct {
	repo, remote, branch, approver *string
}

func (a adminFlags) opts() (bus.ApproveOpts, error) {
	o := bus.ApproveOpts{Repo: *a.repo, Remote: *a.remote, Branch: *a.branch, Approver: *a.approver}
	if o.Repo == "" {
		if r, ok := bus.GitHubRepo(o.Remote); ok {
			o.Repo = r
		}
	}
	if o.Remote == "" {
		if o.Repo == "" {
			return o, &exitError{code: exitUsage, msg: "need --repo OWNER/REPO or --remote URL"}
		}
		o.Remote = "https://github.com/" + o.Repo + ".git"
		if os.Getenv("AGENTBUS_GIT_TOKEN") == "" {
			o.Remote = "git@github.com:" + o.Repo + ".git"
		}
	}
	if o.Approver == "" {
		o.Approver = firstOr(os.Getenv("GITHUB_ACTOR"), firstOr(os.Getenv("USER"), "admin"))
	}
	if o.Repo != "" {
		o.GH = bus.GitHubFromEnv("AGENTBUS_ADMIN_TOKEN", "GH_TOKEN")
	}
	return o, nil
}

func newAdminFlags(name string) (*flagSet, adminFlags) {
	fs := newFlags(name)
	return fs, adminFlags{
		repo:     fs.String("repo", "", "GitHub OWNER/REPO (enables deploy-key management)"),
		remote:   fs.String("remote", "", "bus remote the admin can push to"),
		branch:   fs.String("branch", "agent-bus", ""),
		approver: fs.String("approver", "", "who approves (default $GITHUB_ACTOR / $USER)"),
	}
}

func adminApprove(c *cli, args []string) error {
	fs, af := newAdminFlags("admin approve")
	reqFile := fs.String("request", "", "join request: JSON file or issue body ('-' = stdin)")
	issue := fs.String("issue", "", "approve the request in this issue URL")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	o, err := af.opts()
	if err != nil {
		return err
	}
	var text string
	switch {
	case *issue != "":
		repo, n, ok := bus.ParseIssueURL(*issue)
		if !ok {
			return &exitError{code: exitUsage, msg: "bad --issue URL"}
		}
		gh := firstGH(o.GH, bus.GitHubFromEnv())
		if gh == nil {
			return errors.New("need a GitHub token to read the issue")
		}
		is, err := gh.GetIssue(repo, n)
		if err != nil {
			return err
		}
		text, o.Ref = is.Body, is.HTMLURL
	case *reqFile != "":
		if text, err = readBody("", *reqFile); err != nil {
			return err
		}
	default:
		return &exitError{code: exitUsage, msg: "admin approve needs --request FILE or --issue URL"}
	}
	r, err := bus.ParseJoinRequest(text)
	if err != nil {
		return err
	}
	m, err := bus.Approve(o, r)
	if err != nil {
		return err
	}
	c.emit(m, func() {
		fmt.Fprintf(c.out, "approved %s (%s)\n", m.Name, m.KeySHA256)
		if o.GH == nil || o.Repo == "" {
			fmt.Fprintf(c.out, "now grant this key push access on your git server:\n%s\n", m.PublicKey)
		}
	})
	return nil
}

func adminRevoke(c *cli, args []string) error {
	fs, af := newAdminFlags("admin revoke")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "agent name"); err != nil {
		return err
	}
	o, err := af.opts()
	if err != nil {
		return err
	}
	m, err := bus.Revoke(o, pos[0])
	if err != nil {
		return err
	}
	c.emit(m, func() { fmt.Fprintf(c.out, "revoked %s\n", m.Name) })
	return nil
}

func firstGH(gs ...*bus.GitHub) *bus.GitHub {
	for _, g := range gs {
		if g != nil {
			return g
		}
	}
	return nil
}

// ghEvent is the subset of issues / issue_comment payloads we need.
type ghEvent struct {
	Action string `json:"action"`
	Issue  struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		Title   string `json:"title"`
		Body    string `json:"body"`
		State   string `json:"state"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"issue"`
	Comment *struct {
		Body string `json:"body"`
		User struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"comment"`
	Label *struct {
		Name string `json:"name"`
	} `json:"label"`
	Sender struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"sender"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
}

var reSlash = regexp.MustCompile(`(?m)^\s*/(approve|deny|revoke)\b[ \t]*(.*)$`)

// adminHandleIssue is the whole join workflow, driven by a GitHub event:
//
//   - issue opened by a maintainer from the pre-filled link   -> approve
//   - comment "/approve" by a maintainer                       -> approve
//   - label "agentbus-approve" added by a maintainer           -> approve
//   - comment "/deny reason"                                   -> close (not planned)
//   - comment "/revoke"                                        -> revoke + close
//
// Non-maintainers are ignored. Requests filed by an agent (with a token) are
// never auto-approved on open: a human must still say /approve.
func adminHandleIssue(c *cli, args []string) error {
	fs, af := newAdminFlags("admin handle-issue")
	evPath := fs.String("event", os.Getenv("GITHUB_EVENT_PATH"), "GitHub event payload")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	data, err := os.ReadFile(*evPath)
	if err != nil {
		return err
	}
	var ev ghEvent
	if err := json.Unmarshal(data, &ev); err != nil {
		return err
	}
	if *af.repo == "" {
		*af.repo = ev.Repository.FullName
	}
	if !strings.Contains(ev.Issue.Body, bus.JoinMarker) {
		fmt.Fprintln(c.out, "not a join request; ignoring")
		return nil
	}
	repo, n := *af.repo, ev.Issue.Number
	reporter := bus.GitHubFromEnv("GITHUB_TOKEN", "GH_TOKEN")
	if reporter == nil {
		return errors.New("GITHUB_TOKEN is required")
	}
	say := func(msg string) { _ = reporter.Comment(repo, n, msg) }

	action, actor, arg := "", ev.Sender.Login, ""
	switch {
	case ev.Action == "opened":
		action, actor = "approve", ev.Issue.User.Login
		if strings.Contains(ev.Issue.Body, bus.FiledByAgentMarker) {
			action = "await"
		}
	case ev.Comment != nil && ev.Action == "created":
		m := reSlash.FindStringSubmatch(ev.Comment.Body)
		if m == nil {
			return nil
		}
		action, actor, arg = m[1], ev.Comment.User.Login, strings.TrimSpace(m[2])
	case ev.Label != nil && ev.Action == "labeled" && ev.Label.Name == "agentbus-approve":
		action = "approve"
	default:
		return nil
	}
	if ev.Sender.Type == "Bot" && action != "await" {
		return nil
	}
	ok, err := reporter.CanWrite(repo, actor)
	if err != nil {
		return err
	}
	if action == "await" || !ok {
		if ev.Action == "opened" {
			say("👋 Join request received. A maintainer can approve it by commenting `/approve` (or `/deny <reason>`).")
		}
		return nil
	}
	*af.approver = actor
	o, err := af.opts()
	if err != nil {
		return err
	}
	o.Ref = ev.Issue.HTMLURL
	// deploy keys need the admin PAT; GITHUB_TOKEN cannot manage them
	o.GH = bus.GitHubFromEnv("AGENTBUS_ADMIN_TOKEN")
	switch action {
	case "approve":
		r, err := bus.ParseJoinRequest(ev.Issue.Body)
		if err != nil {
			say("❌ Cannot approve: " + err.Error())
			return err
		}
		if o.GH == nil {
			say("❌ Cannot approve: the `AGENTBUS_ADMIN_TOKEN` secret is missing (needs *Administration: write* to add deploy keys).")
			return errors.New("AGENTBUS_ADMIN_TOKEN missing")
		}
		m, err := bus.Approve(o, r)
		if err != nil {
			say("❌ Approval failed: " + err.Error())
			return err
		}
		say(fmt.Sprintf("✅ Approved by @%s. `%s` (%s) now has access; it will finish joining on its next `agentbus join --wait`.\n\nRevoke any time with `/revoke`.", actor, m.Name, m.KeySHA256))
		_ = reporter.AddLabels(repo, n, "agentbus-member")
		_ = reporter.CloseIssue(repo, n, "completed")
		c.emit(m, func() { fmt.Fprintf(c.out, "approved %s\n", m.Name) })
	case "deny":
		say(fmt.Sprintf("🚫 Denied by @%s. %s", actor, arg))
		_ = reporter.CloseIssue(repo, n, "not_planned")
	case "revoke":
		r, err := bus.ParseJoinRequest(ev.Issue.Body)
		if err != nil {
			return err
		}
		if _, err := bus.Revoke(o, r.Name); err != nil {
			say("❌ Revoke failed: " + err.Error())
			return err
		}
		say(fmt.Sprintf("🔒 `%s` revoked by @%s: deploy key removed, later events ignored.", r.Name, actor))
		_ = reporter.CloseIssue(repo, n, "not_planned")
	}
	return nil
}

// cmdDigest prints a markdown digest for humans. In CI it works without an
// agent identity: pass --remote (or run inside a checkout via --dir).
func cmdDigest(c *cli, args []string) error {
	fs := newFlags("digest")
	since := fs.String("since", "1h", "window")
	rng := fs.String("range", "", "only events added in commit range A..B (push payload)")
	level := fs.String("level", bus.DigestAll, "all|important|alerts")
	remote := fs.String("remote", "", "read the bus from this remote (no agent identity needed)")
	branch := fs.String("branch", "agent-bus", "")
	work := fs.String("workdir", "", "scratch dir for --remote (default temp)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	b, cleanup, err := openReport(*remote, *branch, *work)
	defer cleanup()
	if err != nil {
		return err
	}
	o := bus.DigestOpts{Level: *level}
	if *rng != "" {
		a, z, ok := strings.Cut(*rng, "..")
		if !ok {
			return &exitError{code: exitUsage, msg: "--range must be A..B"}
		}
		if o.IDs, err = b.EventIDsInRange(a, z); err != nil {
			return err
		}
	} else if *since != "" {
		d, err := parseDur(*since)
		if err != nil {
			return err
		}
		o.Since = time.Now().Add(-d)
	}
	md, err := b.Digest(o)
	if err != nil {
		return err
	}
	if md == "" {
		return &exitError{code: exitNothing}
	}
	c.emit(map[string]string{"markdown": md}, func() { fmt.Fprint(c.out, md) })
	return nil
}
