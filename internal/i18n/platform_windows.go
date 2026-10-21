//go:build windows

package i18n

import "golang.org/x/sys/windows"

// platformZh checks the user's preferred UI languages (zh-CN, zh-TW, …).
func platformZh() bool {
	langs, err := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME)
	if err != nil || len(langs) == 0 {
		return false
	}
	return len(langs[0]) >= 2 && (langs[0][:2] == "zh" || langs[0][:2] == "ZH")
}
