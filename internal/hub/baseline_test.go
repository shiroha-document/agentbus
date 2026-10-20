package hub

import (
	"context"
	"testing"
	"time"
)

func TestBaseline(t *testing.T) {
	_, tk := tickEnv(t, "ok")
	r, results, err := Baseline(context.Background(), tk.Dir, tk.Cfg, BaselineOptions{Timeout: 20 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || r.ThreadID != nil || r.ErrorSummary == nil || *r.ErrorSummary != "baseline" ||
		r.Input != 3200 || r.CacheRead != 28000 || r.MemberID != "m_1" {
		t.Fatalf("%+v %d", r, len(results))
	}
	t.Setenv("AGENTBUS_FAKE_CLI", "fail")
	if _, _, err := Baseline(context.Background(), tk.Dir, tk.Cfg, BaselineOptions{Runs: 1, Timeout: 20 * time.Second}); err == nil {
		t.Fatal("want error")
	}
}
