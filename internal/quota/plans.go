package quota

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Coding plans bought with an API key: Zhipu's GLM Coding Plan (and Z.ai's),
// Kimi Code and MiniMax's Coding / Token Plan. Each vendor tells the key its
// plan's windows at an undocumented endpoint (ported from magpie's
// planquota.go). A key the provider can't find means the plan isn't set up
// here: no reading.

type planProvider struct {
	id   string
	keys keySource
	read func(ctx context.Context, key string) ([]Reading, error)
}

func (p planProvider) ID() string   { return p.id }
func (p planProvider) Detect() bool { return p.keys.find() != "" }

func (p planProvider) Read(ctx context.Context) ([]Reading, error) {
	key := p.keys.find()
	if key == "" {
		return nil, errNotLoggedIn
	}
	rs, err := p.read(ctx, key)
	if err != nil {
		return nil, errors.New(sanitize(unknownErr(err).Error(), key))
	}
	for i := range rs {
		rs[i].Error = sanitize(rs[i].Error, key)
	}
	return rs, nil
}

func planProviders() []Provider {
	return []Provider{
		planProvider{id: "zhipu", keys: keySource{env: []string{"ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY", "BIGMODEL_API_KEY"}, hosts: []string{"open.bigmodel.cn"}},
			read: func(ctx context.Context, key string) ([]Reading, error) { return readZhipu(ctx, zhipuBaseURL, key) }},
		planProvider{id: "zai", keys: keySource{env: []string{"ZAI_API_KEY", "Z_AI_API_KEY"}, hosts: []string{"api.z.ai"}},
			read: func(ctx context.Context, key string) ([]Reading, error) { return readZhipu(ctx, zaiBaseURL, key) }},
		planProvider{id: "kimi-code", keys: keySource{env: []string{"KIMI_CODE_API_KEY"}, hosts: []string{"api.kimi.ai"}, extra: kimiCLIKey("api.kimi.com", "api.kimi.ai")},
			read: func(ctx context.Context, key string) ([]Reading, error) { return readKimi(ctx, kimiGlobalBaseURL, key) }},
		planProvider{id: "kimi-code-cn", keys: keySource{env: []string{"KIMI_CODE_CN_API_KEY"}, hosts: []string{"api.kimi.com"}, extra: kimiCLIKey("api.kimi.com", "api.kimi.com")},
			read: func(ctx context.Context, key string) ([]Reading, error) { return readKimi(ctx, kimiCNBaseURL, key) }},
		planProvider{id: "minimax", keys: keySource{env: []string{"MINIMAX_API_KEY"}, hosts: []string{"api.minimax.io"}},
			read: func(ctx context.Context, key string) ([]Reading, error) { return readMiniMax(ctx, minimaxBaseURL, key) }},
		planProvider{id: "minimax-cn", keys: keySource{env: []string{"MINIMAX_CN_API_KEY"}, hosts: []string{"api.minimaxi.com"}},
			read: func(ctx context.Context, key string) ([]Reading, error) {
				return readMiniMax(ctx, minimaxCNBaseURL, key)
			}},
	}
}

// --- Zhipu / Z.ai ---------------------------------------------------------

func readZhipu(ctx context.Context, base, key string) ([]Reading, error) {
	// Zhipu takes the bare key as the Authorization, no "Bearer"
	b, err := doJSON(ctx, "GET", strings.TrimSuffix(base, "/")+"/api/monitor/usage/quota/limit", map[string]string{"Authorization": key}, nil)
	if err != nil {
		return nil, err
	}
	return parseZhipu(b)
}

// parseZhipu reads
//
//	{"success":true,"data":{"level":"pro","limits":[
//	  {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":12,"nextResetTime":1758800000000},
//	  {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":40,"nextResetTime":…},
//	  {"type":"TIME_LIMIT","unit":5,"number":1,"percentage":3,"nextResetTime":…}]}}
//
// unit 3 is hours, 6 a week; TIME_LIMIT is the month's MCP tool calls.
func parseZhipu(b []byte) ([]Reading, error) {
	var r struct {
		Success *bool  `json:"success"`
		Msg     string `json:"msg"`
		Data    *struct {
			Level  string `json:"level"`
			Limits []struct {
				Type          string   `json:"type"`
				Unit          int      `json:"unit"`
				Number        int      `json:"number"`
				Percentage    *float64 `json:"percentage"`
				NextResetTime int64    `json:"nextResetTime"`
			} `json:"limits"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	if r.Success != nil && !*r.Success || r.Data == nil {
		if r.Msg != "" {
			return nil, errors.New(r.Msg)
		}
		return nil, errBadReply
	}
	plan := strings.ToLower(strings.TrimSpace(r.Data.Level))
	var out []Reading
	for _, l := range r.Data.Limits {
		rd := Reading{Plan: plan}
		if l.Percentage != nil {
			rd.UsedPct = f64(clampPct(*l.Percentage))
		}
		if t, ok := unixAuto(l.NextResetTime); ok {
			rd.ResetsAt = i64(t.UnixMilli())
		}
		switch {
		case strings.EqualFold(l.Type, "TIME_LIMIT"):
			rd.Window = "mcp_" + windowMonthly
		case l.Unit == 3:
			n := l.Number
			if n <= 0 {
				n = 5
			}
			rd.Window = spanWindow(time.Duration(n) * time.Hour)
		case l.Unit == 6:
			rd.Window = "7d"
		default:
			rd.Window = "allowance"
		}
		out = append(out, rd)
	}
	if len(out) == 0 {
		return nil, errors.New("no plan windows")
	}
	return out, nil
}

// --- Kimi Code ------------------------------------------------------------

func readKimi(ctx context.Context, base, key string) ([]Reading, error) {
	b, err := doJSON(ctx, "GET", strings.TrimSuffix(base, "/")+"/usages", map[string]string{"Authorization": "Bearer " + key}, nil)
	if err != nil {
		return nil, err
	}
	return parseKimi(b)
}

// parseKimi reads
//
//	{"usage":{"limit":"100","used":"12","resetTime":"2026-09-30T05:24:18.44Z"},
//	 "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
//	   "detail":{"limit":"100","remaining":"88","resetTime":"…"}}]}
//
// usage is the week's allowance, each of limits a shorter window; numbers
// come as strings or numbers, as used or as what remains.
func parseKimi(b []byte) ([]Reading, error) {
	type row map[string]any
	var r struct {
		Usage  row `json:"usage"`
		Limits []struct {
			Window row `json:"window"`
			Detail row `json:"detail"`
		} `json:"limits"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	window := func(d row, name string) (Reading, bool) {
		limit, ok := number(d["limit"])
		if !ok || limit <= 0 {
			return Reading{}, false
		}
		used, ok := number(d["used"])
		if !ok {
			left, ok := number(d["remaining"])
			if !ok {
				return Reading{}, false
			}
			used = limit - left
		}
		rd := Reading{Window: name, UsedPct: f64(clampPct(used / limit * 100))}
		for _, k := range []string{"resetTime", "resetAt", "reset_at", "reset_time"} {
			if t, ok := parseTime(d[k]); ok {
				rd.ResetsAt = i64(t.UnixMilli())
				break
			}
		}
		return rd, true
	}
	var out []Reading
	for _, l := range r.Limits {
		d := l.Detail
		if d == nil {
			d = l.Window
		}
		n, _ := number(l.Window["duration"])
		unit, _ := l.Window["timeUnit"].(string)
		var span time.Duration
		switch {
		case strings.Contains(unit, "MINUTE"):
			span = time.Duration(n * float64(time.Minute))
		case strings.Contains(unit, "HOUR"):
			span = time.Duration(n * float64(time.Hour))
		case strings.Contains(unit, "DAY"):
			span = time.Duration(n * float64(24*time.Hour))
		}
		if rd, ok := window(d, spanWindow(span)); ok {
			out = append(out, rd)
		}
	}
	if rd, ok := window(r.Usage, "7d"); ok {
		out = append(out, rd)
	}
	if len(out) == 0 {
		return nil, errors.New("no usage in the reply")
	}
	return out, nil
}

// --- MiniMax --------------------------------------------------------------

func readMiniMax(ctx context.Context, base, key string) ([]Reading, error) {
	b, err := doJSON(ctx, "GET", strings.TrimSuffix(base, "/")+"/v1/token_plan/remains", map[string]string{"Authorization": "Bearer " + key}, nil)
	if err != nil {
		return nil, err
	}
	return parseMiniMax(b)
}

// parseMiniMax reads /v1/token_plan/remains:
//
//	{"model_remains":[{"model_name":"general",
//	   "start_time":…,"end_time":…,"current_interval_remaining_percent":100,
//	   "current_interval_status":1,"current_interval_total_count":0,
//	   "weekly_start_time":…,"weekly_end_time":…,"current_weekly_remaining_percent":100,
//	   "current_weekly_status":1,"current_weekly_total_count":0},
//	  {"model_name":"video",…}],
//	 "base_resp":{"status_code":0,"status_msg":"success"}}
//
// Each bucket has a rolling interval and a week, told as what remains.
// Status 3 is unlimited (left out), 2 used up. "general" is what the models
// draw on; another bucket's windows are prefixed with its name. MiniMax
// answers 200 to a key it refuses, with the reason in base_resp.
func parseMiniMax(b []byte) ([]Reading, error) {
	type bucket struct {
		Model      string   `json:"model_name"`
		Start      int64    `json:"start_time"`
		End        int64    `json:"end_time"`
		Left       *float64 `json:"current_interval_remaining_percent"`
		Status     int      `json:"current_interval_status"`
		Total      *float64 `json:"current_interval_total_count"`
		WeekStart  int64    `json:"weekly_start_time"`
		WeekEnd    int64    `json:"weekly_end_time"`
		WeekLeft   *float64 `json:"current_weekly_remaining_percent"`
		WeekStatus int      `json:"current_weekly_status"`
		WeekTotal  *float64 `json:"current_weekly_total_count"`
	}
	var r struct {
		Remains []bucket `json:"model_remains"`
		Base    *struct {
			Code int    `json:"status_code"`
			Msg  string `json:"status_msg"`
		} `json:"base_resp"`
	}
	if err := json.Unmarshal(b, &r); err != nil || r.Base == nil {
		return nil, errBadReply
	}
	if r.Base.Code != 0 {
		if r.Base.Msg != "" {
			return nil, errors.New(r.Base.Msg)
		}
		return nil, errBadReply
	}
	zero := func(f *float64) bool { return f != nil && *f == 0 }
	var out []Reading
	for _, k := range r.Remains {
		name := strings.ToLower(strings.TrimSpace(k.Model))
		if name == "" || k.Status == 3 && k.WeekStatus == 3 && zero(k.Total) && zero(k.WeekTotal) {
			continue
		}
		for _, x := range []struct {
			left       *float64
			status     int
			start, end int64
			week       bool
		}{{k.Left, k.Status, k.Start, k.End, false}, {k.WeekLeft, k.WeekStatus, k.WeekStart, k.WeekEnd, true}} {
			if x.status == 3 || x.left == nil && x.status != 2 {
				continue
			}
			used := 100.0
			if x.status != 2 {
				used = clampPct(100 - *x.left)
			}
			rd := Reading{UsedPct: f64(used)}
			start, sok := unixAuto(x.start)
			end, eok := unixAuto(x.end)
			if eok {
				rd.ResetsAt = i64(end.UnixMilli())
			}
			switch {
			case x.week:
				rd.Window = "7d"
			case sok && eok && end.After(start):
				rd.Window = spanWindow(roundSpan(end.Sub(start)))
			default:
				rd.Window = "allowance"
			}
			if name != "general" {
				rd.Window = normWindowPart(name) + "_" + rd.Window
			}
			out = append(out, rd)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no plan windows")
	}
	return out, nil
}
