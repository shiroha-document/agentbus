package quota

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// httpClient is used for every request; tests swap it (or the base URLs
// below) to point at an httptest server.
var httpClient = &http.Client{Timeout: 15 * time.Second}

// Endpoints, as vars so tests can redirect them.
var (
	claudeUsageURL      = "https://api.anthropic.com/api/oauth/usage"
	openRouterBaseURL   = "https://openrouter.ai/api/v1"
	zhipuBaseURL        = "https://open.bigmodel.cn"
	zaiBaseURL          = "https://api.z.ai"
	kimiCNBaseURL       = "https://api.kimi.com/coding/v1"
	kimiGlobalBaseURL   = "https://api.kimi.ai/coding/v1"
	minimaxBaseURL      = "https://api.minimax.io"
	minimaxCNBaseURL    = "https://api.minimaxi.com"
	geminiCodeAssistURL = "https://cloudcode-pa.googleapis.com"

	deepSeekBalanceURL   = "https://api.deepseek.com/user/balance"
	moonshotBalanceURL   = "https://api.moonshot.ai/v1/users/me/balance"
	moonshotCNBalanceURL = "https://api.moonshot.cn/v1/users/me/balance"
	siliconFlowInfoURL   = "https://api.siliconflow.cn/v1/user/info"
	stepFunAccountsURL   = "https://api.stepfun.ai/v1/accounts"
	stepFunCNAccountsURL = "https://api.stepfun.com/v1/accounts"
	aiHubMixBaseURL      = "https://aihubmix.com"
	ollamaBalanceURL     = "https://ollama.com/api/balance"
	openCodeGoUsageURL   = "https://opencode.ai/zen/go/v1/usage"
	commandCodeBaseURL   = "https://api.commandcode.ai"
	copilotUserURL       = "https://api.github.com/copilot_internal/user"
	clineBaseURL         = "https://api.cline.bot/api/v1"
)

const userAgent = "agentbus-quota/1"

// maxBody caps how much of a reply is read.
const maxBody = 4 << 20

// statusError is a non-2xx reply. Its text is only the status code: reply
// bodies may echo request details and never reach an Error string.
type statusError struct{ code int }

func (e statusError) Error() string { return fmt.Sprintf("http %d", e.code) }

var (
	errUnsupported = errors.New("unsupported")
	errBadReply    = errors.New("unexpected reply")
)

// doJSON sends a request and returns the body of a 2xx reply. Errors are
// already reduced to short, secret-free messages.
func doJSON(ctx context.Context, method, url string, headers map[string]string, body []byte) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return nil, errors.New("bad request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, transportError(ctx, err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, statusError{res.StatusCode}
	}
	if err != nil {
		return nil, transportError(ctx, err)
	}
	return b, nil
}

// transportError names a failed round trip without its URL (net/http puts
// the whole URL, query included, in the error text).
func transportError(ctx context.Context, err error) error {
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
		return errors.New("timeout")
	}
	return errors.New("network error")
}

func isTimeout(err error) bool {
	var t interface{ Timeout() bool }
	return errors.As(err, &t) && t.Timeout()
}

var (
	reURL    = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*)://(?:[^/\s"'?#@]*@)?([^/\s"'?#@]+)[^\s"']*`)
	reBearer = regexp.MustCompile(`(?i)\b(bearer|basic|token)\s+[^\s"',;]+`)
	reKV     = regexp.MustCompile(`(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|key|secret|password|authorization)\s*[=:]\s*"?[^\s"',;&]+`)
	reJWT    = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*`)
	reSK     = regexp.MustCompile(`\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{6,}`)
	reOpaque = regexp.MustCompile(`[A-Za-z0-9_\-+/=.]{32,}`)
)

// sanitize makes s safe to put in a Reading's Error: URLs are cut to their
// scheme and host, anything token-like is replaced, the extra secrets given
// are removed verbatim, and the result is kept short.
func sanitize(s string, secrets ...string) string {
	for _, sec := range secrets {
		if len(sec) >= 4 {
			s = strings.ReplaceAll(s, sec, "[redacted]")
		}
	}
	s = reURL.ReplaceAllString(s, "$1://$2")
	s = reBearer.ReplaceAllString(s, "$1 [redacted]")
	s = reKV.ReplaceAllString(s, "$1=[redacted]")
	s = reJWT.ReplaceAllString(s, "[redacted]")
	s = reSK.ReplaceAllString(s, "[redacted]")
	s = reOpaque.ReplaceAllStringFunc(s, func(m string) string {
		if strings.Contains(m, "://") {
			return m
		}
		return "[redacted]"
	})
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 200 {
		s = string(r[:200]) + "…"
	}
	return s
}

// Scrub is sanitize for other packages: s on one short line with URLs cut
// to their host and anything token-like (and the given secrets) replaced.
func Scrub(s string, secrets ...string) string { return sanitize(s, secrets...) }

// unknownErr is the Error of an undocumented source that could not be
// read: "unknown", with the (already safe) reason after it.
func unknownErr(err error) error {
	if err == nil {
		return errors.New("unknown")
	}
	return fmt.Errorf("unknown: %s", err.Error())
}
