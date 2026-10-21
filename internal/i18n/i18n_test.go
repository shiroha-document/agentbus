package i18n

import "testing"

func TestDetect(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want bool
	}{
		{map[string]string{"AGENTBUS_LANG": "zh"}, true},
		{map[string]string{"AGENTBUS_LANG": "en", "LANG": "zh_CN.UTF-8"}, false},
		{map[string]string{"LANG": "zh_CN.UTF-8"}, true},
		{map[string]string{"LC_ALL": "en_US.UTF-8", "LANG": "zh_CN.UTF-8"}, false},
		{map[string]string{"LC_ALL": "C", "LANG": "zh_TW.UTF-8"}, true},
		{map[string]string{"LANG": "en_US.UTF-8"}, false},
	}
	for i, c := range cases {
		if got := detect(func(k string) string { return c.env[k] }); got != c.want {
			t.Errorf("case %d: got %v want %v", i, got, c.want)
		}
	}
	Set("zh")
	if Pick("a", "甲") != "甲" || Lang() != "zh" {
		t.Fatal("Set zh")
	}
	Set("en")
	if Pick("a", "甲") != "a" {
		t.Fatal("Set en")
	}
	Set("")
}
