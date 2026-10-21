// Package i18n picks Chinese or English for human-facing CLI text.
//
// The language comes from AGENTBUS_LANG (zh | en), else LC_ALL / LC_MESSAGES /
// LANG (zh* → Chinese), else on Windows the user default UI language, else
// English. Machine output (--json) is never translated.
package i18n

import (
	"os"
	"strings"
	"sync"
)

var (
	once   sync.Once
	zh     bool
	forced *bool
)

// IsZh reports whether human-facing text should be Chinese.
func IsZh() bool {
	if forced != nil {
		return *forced
	}
	once.Do(func() { zh = detect(os.Getenv) })
	return zh
}

// Lang returns "zh" or "en".
func Lang() string {
	if IsZh() {
		return "zh"
	}
	return "en"
}

// Pick returns zh when the language is Chinese, else en.
func Pick(en, zhText string) string {
	if IsZh() {
		return zhText
	}
	return en
}

// Set forces the language (tests, or after the user chose one); "" restores detection.
func Set(lang string) {
	switch strings.ToLower(lang) {
	case "zh":
		v := true
		forced = &v
	case "en":
		v := false
		forced = &v
	default:
		forced = nil
	}
}

func detect(getenv func(string) string) bool {
	if v := strings.ToLower(strings.TrimSpace(getenv("AGENTBUS_LANG"))); v != "" {
		return strings.HasPrefix(v, "zh")
	}
	for _, k := range []string{"LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"} {
		if v := strings.ToLower(getenv(k)); v != "" && v != "c" && v != "posix" && !strings.HasPrefix(v, "c.") {
			return strings.HasPrefix(v, "zh")
		}
	}
	return platformZh()
}
