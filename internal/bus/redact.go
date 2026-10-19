package bus

import (
	"regexp"
)

// Redaction runs on every body, progress tail and text attachment before it is
// committed. It is a safety net, not a guarantee: agents must still not send
// secrets on purpose.
var redactors = []*regexp.Regexp{
	regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9_\-]{16,}`),
	regexp.MustCompile(`\bsk_[a-z]+_[A-Za-z0-9]{16,}`),
	regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{20,}`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}`),
	regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9\-]{10,}`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`), // JWT
}

var (
	reAuthHeader = regexp.MustCompile(`(?i)(authorization|x-api-key|cookie)(\s*[:=]\s*)("?)[^\s"]+(\s+[^\s"]+)?`)
	reURLPass    = regexp.MustCompile(`(://[^/\s:@]+:)[^@\s/]+@`)
	reKV         = regexp.MustCompile(`(?i)\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[=:]\s*)("?)[^\s"]{6,}`)
)

// Redact masks well-known credential shapes.
func Redact(s string) string {
	for _, re := range redactors {
		s = re.ReplaceAllString(s, "[REDACTED]")
	}
	s = reAuthHeader.ReplaceAllString(s, "$1$2$3[REDACTED]")
	s = reURLPass.ReplaceAllString(s, "$1[REDACTED]@")
	s = reKV.ReplaceAllString(s, "$1$2$3[REDACTED]")
	return s
}
