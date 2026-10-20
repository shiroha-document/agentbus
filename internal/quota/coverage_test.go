package quota

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// coverageRows reads COVERAGE.md's table: magpie id -> native status.
func coverageRows(t *testing.T) map[string]string {
	t.Helper()
	f, err := os.Open("COVERAGE.md")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rows := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "|") {
			continue
		}
		cells := strings.Split(strings.Trim(line, "|"), "|")
		if len(cells) < 4 {
			t.Fatalf("short table row: %s", line)
		}
		id, status := strings.TrimSpace(cells[0]), strings.TrimSpace(cells[2])
		if id == "magpie id" || strings.HasPrefix(id, "---") {
			continue
		}
		if _, dup := rows[id]; dup {
			t.Errorf("COVERAGE.md lists %q twice", id)
		}
		switch status {
		case "已支持", "未支持", "不适用":
		default:
			t.Errorf("COVERAGE.md: %q has status %q", id, status)
		}
		rows[id] = status
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return rows
}

func magpieProviderIDs(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "magpie_providers.txt"))
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, l := range strings.Split(string(b), "\n") {
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "#") {
			ids = append(ids, l)
		}
	}
	return ids
}

func TestCoverageListsEveryMagpieProvider(t *testing.T) {
	rows := coverageRows(t)
	ids := magpieProviderIDs(t)
	if len(ids) == 0 {
		t.Fatal("magpie_providers.txt is empty")
	}
	for _, id := range ids {
		if _, ok := rows[id]; !ok {
			t.Errorf("magpie provider %q is missing from COVERAGE.md", id)
		}
	}
}

func TestCoverageMatchesRegistry(t *testing.T) {
	rows := coverageRows(t)
	native := map[string]bool{}
	for _, p := range builtinProviders() {
		id := p.ID()
		if id == "cursor" {
			// reports "unsupported": detected, not read
			if rows[id] != "未支持" {
				t.Errorf("cursor is %q in COVERAGE.md, want 未支持", rows[id])
			}
			continue
		}
		native[id] = true
		if rows[id] != "已支持" {
			t.Errorf("native provider %q is %q in COVERAGE.md, want 已支持", id, rows[id])
		}
	}
	for id, status := range rows {
		if status == "已支持" && !native[id] {
			t.Errorf("COVERAGE.md marks %q 已支持 but there is no native reader", id)
		}
	}
}
