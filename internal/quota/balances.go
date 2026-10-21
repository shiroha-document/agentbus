package quota

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// Prepaid API accounts whose key can ask what money is left: DeepSeek,
// Moonshot (Kimi platform), SiliconFlow, StepFun and AiHubMix. Each is one
// GET with the key and one number (or one per currency) in the reply; the
// endpoints and reply shapes are those magpie's balance.go reads (see
// THIRD_PARTY.md). A balance is a Reading with window "balance" and no
// used_pct.

// balanceProvider reads one prepaid account's balance.
type balanceProvider struct {
	id   string
	keys keySource
	// url is the endpoint, read when the provider is (tests redirect it)
	url *string
	// parse turns a 2xx reply into readings
	parse func(b []byte) ([]Reading, error)
	// refused, when set, words a known refusal in place of "http N"
	refused func(code int) error
}

func (p balanceProvider) ID() string   { return p.id }
func (p balanceProvider) Detect() bool { return p.keys.find() != "" }

func (p balanceProvider) Read(ctx context.Context) ([]Reading, error) {
	key := p.keys.find()
	if key == "" {
		return nil, errNotLoggedIn
	}
	b, err := doJSON(ctx, "GET", *p.url, map[string]string{"Authorization": "Bearer " + key}, nil)
	if err != nil {
		var se statusError
		if p.refused != nil && errors.As(err, &se) {
			if e := p.refused(se.code); e != nil {
				return nil, e
			}
		}
		return nil, errors.New(sanitize(err.Error(), key))
	}
	rs, err := p.parse(b)
	if err != nil {
		return nil, errors.New(sanitize(err.Error(), key))
	}
	return rs, nil
}

func balanceReading(amount float64, currency string) Reading {
	return Reading{Window: windowBalance, Balance: &Balance{Amount: roundCents(amount), Currency: currency}}
}

var errNoBalance = errors.New("no balance in the reply")

func balanceProviders() []Provider {
	return []Provider{
		balanceProvider{id: "deepseek", url: &deepSeekBalanceURL, parse: parseDeepSeek,
			keys: keySource{env: []string{"DEEPSEEK_API_KEY"}, hosts: []string{"api.deepseek.com"}, extra: fromOpenCode("deepseek")}},
		balanceProvider{id: "moonshot", url: &moonshotBalanceURL, parse: parseMoonshot("USD"),
			keys: keySource{env: []string{"MOONSHOT_GLOBAL_API_KEY"}, hosts: []string{"api.moonshot.ai"},
				extra: firstKey(pairKey("MOONSHOT_API_KEY", "MOONSHOT_BASE_URL", "api.moonshot.ai", "api.moonshot.ai"), fromOpenCode("moonshotai"))}},
		balanceProvider{id: "moonshot-cn", url: &moonshotCNBalanceURL, parse: parseMoonshot("CNY"),
			keys: keySource{env: []string{"MOONSHOT_CN_API_KEY"}, hosts: []string{"api.moonshot.cn"},
				extra: firstKey(pairKey("MOONSHOT_API_KEY", "MOONSHOT_BASE_URL", "api.moonshot.ai", "api.moonshot.cn"), fromOpenCode("moonshotai-cn"))}},
		balanceProvider{id: "siliconflow", url: &siliconFlowInfoURL, parse: parseSiliconFlow("CNY"), refused: siliconFlowRefused,
			keys: keySource{env: []string{"SILICONFLOW_API_KEY", "SILICON_FLOW_API_KEY"}, hosts: []string{"api.siliconflow.cn"}, extra: fromOpenCode("siliconflow-cn")}},
		balanceProvider{id: "stepfun", url: &stepFunAccountsURL, parse: parseStepFun("USD"),
			keys: keySource{env: []string{"STEPFUN_GLOBAL_API_KEY"}, hosts: []string{"api.stepfun.ai"},
				extra: pairKey("STEPFUN_API_KEY", "STEPFUN_BASE_URL", "api.stepfun.com", "api.stepfun.ai")}},
		balanceProvider{id: "stepfun-cn", url: &stepFunCNAccountsURL, parse: parseStepFun("CNY"),
			keys: keySource{env: []string{"STEPFUN_CN_API_KEY"}, hosts: []string{"api.stepfun.com"},
				extra: pairKey("STEPFUN_API_KEY", "STEPFUN_BASE_URL", "api.stepfun.com", "api.stepfun.com")}},
		aiHubMixProvider{},
	}
}

// --- DeepSeek -------------------------------------------------------------

// parseDeepSeek reads
//
//	{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00",
//	  "granted_balance":"10.00","topped_up_balance":"100.00"}]}
//
// one reading per currency. DeepSeek lists the currencies in no stable
// order, so the one with money left comes first (then by code) and has
// window "balance"; any other is "balance_<code>", so the hub, which keeps
// one reading per provider and window, keeps them all.
func parseDeepSeek(b []byte) ([]Reading, error) {
	var r struct {
		Infos []struct {
			Currency string `json:"currency"`
			Total    any    `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	type amt struct {
		code  string
		total float64
	}
	var amts []amt
	for _, in := range r.Infos {
		v, ok := number(in.Total)
		if !ok {
			continue
		}
		code := strings.ToUpper(strings.TrimSpace(in.Currency))
		if code == "" || code == "RMB" {
			code = "CNY"
		}
		amts = append(amts, amt{code, v})
	}
	if len(amts) == 0 {
		return nil, errNoBalance
	}
	sort.SliceStable(amts, func(i, j int) bool {
		if (amts[i].total > 0) != (amts[j].total > 0) {
			return amts[i].total > 0
		}
		return amts[i].code < amts[j].code
	})
	out := make([]Reading, 0, len(amts))
	for i, a := range amts {
		rd := balanceReading(a.total, a.code)
		if i > 0 {
			rd.Window = windowBalance + "_" + strings.ToLower(a.code)
		}
		out = append(out, rd)
	}
	return out, nil
}

// --- Moonshot -------------------------------------------------------------

// parseMoonshot reads {"code":0,"data":{"available_balance":49.58},"status":true}.
func parseMoonshot(currency string) func([]byte) ([]Reading, error) {
	return func(b []byte) ([]Reading, error) {
		var r struct {
			Data struct {
				Available any `json:"available_balance"`
			} `json:"data"`
		}
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, errBadReply
		}
		v, ok := number(r.Data.Available)
		if !ok {
			return nil, errNoBalance
		}
		return []Reading{balanceReading(v, currency)}, nil
	}
}

// --- SiliconFlow ----------------------------------------------------------

// errSiliconFlowRetired: SiliconFlow stopped answering /v1/user/info on
// 2026-08-14 (410, or {"code":20092,…}); the balance is on its console now.
var errSiliconFlowRetired = errors.New("SiliconFlow retired its balance query")

func siliconFlowRefused(code int) error {
	if code == 410 {
		return errSiliconFlowRetired
	}
	return nil
}

// parseSiliconFlow reads {"code":20000,"data":{"totalBalance":"88.88"}}.
func parseSiliconFlow(currency string) func([]byte) ([]Reading, error) {
	return func(b []byte) ([]Reading, error) {
		var r struct {
			Code int `json:"code"`
			Data struct {
				Total any `json:"totalBalance"`
			} `json:"data"`
		}
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, errBadReply
		}
		if r.Code == 20092 {
			return nil, errSiliconFlowRetired
		}
		v, ok := number(r.Data.Total)
		if !ok {
			return nil, errNoBalance
		}
		return []Reading{balanceReading(v, currency)}, nil
	}
}

// --- StepFun --------------------------------------------------------------

// parseStepFun reads {"object":"account","type":"prepaid","balance":26.00,…}:
// balance is what is left to spend, vouchers included. A Step Plan key is
// the account's, so it is told the same balance; the plan's own windows
// need a web sign-in and are not read.
func parseStepFun(currency string) func([]byte) ([]Reading, error) {
	return func(b []byte) ([]Reading, error) {
		var r struct {
			Balance any `json:"balance"`
		}
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, errBadReply
		}
		v, ok := number(r.Balance)
		if !ok {
			return nil, errNoBalance
		}
		return []Reading{balanceReading(v, currency)}, nil
	}
}

// --- AiHubMix -------------------------------------------------------------

// AiHubMix tells a key what is left on it (GET /dashboard/billing/remain);
// a key without a limit has nothing of its own to tell (-1), and the
// account's balance is told only to the account's access token, sent bare
// as the Authorization (GET /api/user/self, in units of $1/500000). The
// token is preferred when both are set.
type aiHubMixProvider struct{}

var (
	aiHubMixKeys   = keySource{env: []string{"AIHUBMIX_API_KEY"}, hosts: []string{"aihubmix.com"}, extra: fromOpenCode("aihubmix")}
	aiHubMixTokens = keySource{env: []string{"AIHUBMIX_ACCESS_TOKEN"}}
)

func (aiHubMixProvider) ID() string { return "aihubmix" }
func (aiHubMixProvider) Detect() bool {
	return aiHubMixTokens.find() != "" || aiHubMixKeys.find() != ""
}

func (aiHubMixProvider) Read(ctx context.Context) ([]Reading, error) {
	base := strings.TrimSuffix(aiHubMixBaseURL, "/")
	if tok := aiHubMixTokens.find(); tok != "" {
		b, err := doJSON(ctx, "GET", base+"/api/user/self", map[string]string{"Authorization": tok}, nil)
		if err != nil {
			return nil, errors.New(sanitize(err.Error(), tok))
		}
		rs, err := parseAiHubMixAccount(b)
		if err != nil {
			return nil, errors.New(sanitize(err.Error(), tok))
		}
		return rs, nil
	}
	key := aiHubMixKeys.find()
	if key == "" {
		return nil, errNotLoggedIn
	}
	b, err := doJSON(ctx, "GET", base+"/dashboard/billing/remain", map[string]string{"Authorization": "Bearer " + key}, nil)
	if err != nil {
		return nil, errors.New(sanitize(err.Error(), key))
	}
	return parseAiHubMix(b)
}

// parseAiHubMix reads {"object":"list","total_usage":12.5}: despite the
// name, the dollars left on the key; -1 when the key has no limit.
func parseAiHubMix(b []byte) ([]Reading, error) {
	var r struct {
		Remain any `json:"total_usage"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	v, ok := number(r.Remain)
	if !ok {
		return nil, errNoBalance
	}
	if v < 0 {
		return nil, errors.New("key has no limit; set AIHUBMIX_ACCESS_TOKEN for the account balance")
	}
	return []Reading{balanceReading(v, "USD")}, nil
}

// parseAiHubMixAccount reads {"success":true,"data":{"quota":2500000}}.
func parseAiHubMixAccount(b []byte) ([]Reading, error) {
	var r struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			Quota any `json:"quota"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	if !r.Success {
		if r.Message == "" {
			r.Message = "access token refused"
		}
		return nil, errors.New(r.Message)
	}
	v, ok := number(r.Data.Quota)
	if !ok {
		return nil, errNoBalance
	}
	return []Reading{balanceReading(v/500000, "USD")}, nil
}
