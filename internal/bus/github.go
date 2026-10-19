package bus

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

// GitHub is a tiny REST client for the few calls onboarding needs.
type GitHub struct {
	Token string
	API   string // default https://api.github.com
	HTTP  *http.Client
}

// GitHubFromEnv picks a token from the given env vars (default
// AGENTBUS_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, then `gh auth token`).
// With an explicit list there is no gh fallback, so a missing admin token is
// detected instead of silently using a weaker one. Nil if none is available.
func GitHubFromEnv(envs ...string) *GitHub {
	fallback := len(envs) == 0
	if fallback {
		envs = []string{"AGENTBUS_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"}
	}
	tok := ""
	for _, k := range envs {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			tok = v
			break
		}
	}
	if tok == "" && fallback {
		if out, err := exec.Command("gh", "auth", "token").Output(); err == nil {
			tok = strings.TrimSpace(string(out))
		}
	}
	if tok == "" {
		return nil
	}
	return &GitHub{Token: tok}
}

// HTTPError is a non-2xx GitHub response.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("github api: HTTP %d: %s", e.Status, oneLine(e.Body, 300))
}

func (g *GitHub) do(method, path string, in, out any) error {
	api := g.API
	if api == "" {
		api = firstNonEmpty(os.Getenv("AGENTBUS_GITHUB_API"), "https://api.github.com")
	}
	var body io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, strings.TrimRight(api, "/")+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if g.Token != "" {
		req.Header.Set("Authorization", "Bearer "+g.Token)
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c := g.HTTP
	if c == nil {
		c = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return &HTTPError{Status: resp.StatusCode, Body: Redact(string(data))}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Issue is the subset of a GitHub issue we use.
type Issue struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
	State   string `json:"state"`
}

// CreateIssue opens an issue.
func (g *GitHub) CreateIssue(repo, title, body string, labels []string) (*Issue, error) {
	var is Issue
	err := g.do("POST", "/repos/"+repo+"/issues", map[string]any{"title": title, "body": body, "labels": labels}, &is)
	if err != nil {
		var he *HTTPError
		// labels may not exist / be settable by the caller: retry without
		if errors.As(err, &he) && he.Status == 422 && len(labels) > 0 {
			return g.CreateIssue(repo, title, body, nil)
		}
		return nil, err
	}
	return &is, nil
}

// DeployKey is a repo deploy key.
type DeployKey struct {
	ID       int64  `json:"id"`
	Key      string `json:"key"`
	Title    string `json:"title"`
	ReadOnly bool   `json:"read_only"`
}

// AddDeployKey adds a write-enabled deploy key; if the same key is already on
// the repo it returns the existing one.
func (g *GitHub) AddDeployKey(repo, title, pub string) (*DeployKey, error) {
	var k DeployKey
	err := g.do("POST", "/repos/"+repo+"/keys", map[string]any{"title": title, "key": pub, "read_only": false}, &k)
	if err == nil {
		return &k, nil
	}
	var he *HTTPError
	if errors.As(err, &he) && he.Status == 422 {
		if ex, _ := g.FindDeployKey(repo, pub); ex != nil {
			if ex.ReadOnly {
				return nil, fmt.Errorf("key is already a READ-ONLY deploy key on %s; delete it and approve again", repo)
			}
			return ex, nil
		}
		return nil, fmt.Errorf("%w (is this key already used on another repository?)", err)
	}
	return nil, err
}

// FindDeployKey looks a key up by its "type base64" part.
func (g *GitHub) FindDeployKey(repo, pub string) (*DeployKey, error) {
	want := keyCore(pub)
	for page := 1; page <= 10; page++ {
		var ks []DeployKey
		if err := g.do("GET", fmt.Sprintf("/repos/%s/keys?per_page=100&page=%d", repo, page), nil, &ks); err != nil {
			return nil, err
		}
		for i := range ks {
			if keyCore(ks[i].Key) == want {
				return &ks[i], nil
			}
		}
		if len(ks) < 100 {
			break
		}
	}
	return nil, nil
}

// DeleteDeployKey removes a deploy key.
func (g *GitHub) DeleteDeployKey(repo string, id int64) error {
	err := g.do("DELETE", fmt.Sprintf("/repos/%s/keys/%d", repo, id), nil, nil)
	var he *HTTPError
	if errors.As(err, &he) && he.Status == 404 {
		return nil
	}
	return err
}

func keyCore(pub string) string {
	f := strings.Fields(pub)
	if len(f) < 2 {
		return pub
	}
	return f[0] + " " + f[1]
}

// Comment posts an issue comment.
func (g *GitHub) Comment(repo string, n int, body string) error {
	return g.do("POST", fmt.Sprintf("/repos/%s/issues/%d/comments", repo, n), map[string]any{"body": body}, nil)
}

// CloseIssue closes an issue with reason completed|not_planned.
func (g *GitHub) CloseIssue(repo string, n int, reason string) error {
	return g.do("PATCH", fmt.Sprintf("/repos/%s/issues/%d", repo, n), map[string]any{"state": "closed", "state_reason": reason}, nil)
}

// AddLabels adds labels to an issue (best effort).
func (g *GitHub) AddLabels(repo string, n int, labels ...string) error {
	return g.do("POST", fmt.Sprintf("/repos/%s/issues/%d/labels", repo, n), map[string]any{"labels": labels}, nil)
}

// CanWrite reports whether user has write/maintain/admin on repo.
func (g *GitHub) CanWrite(repo, user string) (bool, error) {
	var p struct {
		Permission string `json:"permission"`
		RoleName   string `json:"role_name"`
	}
	if err := g.do("GET", "/repos/"+repo+"/collaborators/"+url.PathEscape(user)+"/permission", nil, &p); err != nil {
		var he *HTTPError
		if errors.As(err, &he) && he.Status == 404 {
			return false, nil
		}
		return false, err
	}
	switch p.Permission {
	case "admin", "write", "maintain":
		return true, nil
	}
	return p.RoleName == "admin" || p.RoleName == "maintain" || p.RoleName == "write", nil
}

// IssueFull carries what the approval flow reads.
type IssueFull struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
	State   string `json:"state"`
	Title   string `json:"title"`
	Body    string `json:"body"`
	User    struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"user"`
}

// GetIssue fetches an issue.
func (g *GitHub) GetIssue(repo string, n int) (*IssueFull, error) {
	var is IssueFull
	return &is, g.do("GET", fmt.Sprintf("/repos/%s/issues/%d", repo, n), nil, &is)
}

// ParseIssueURL splits https://github.com/O/R/issues/N.
func ParseIssueURL(s string) (repo string, n int, ok bool) {
	u, err := url.Parse(s)
	if err != nil || u.Host != "github.com" {
		return "", 0, false
	}
	p := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(p) != 4 || p[2] != "issues" {
		return "", 0, false
	}
	if _, err := fmt.Sscanf(p[3], "%d", &n); err != nil {
		return "", 0, false
	}
	return p[0] + "/" + p[1], n, true
}
