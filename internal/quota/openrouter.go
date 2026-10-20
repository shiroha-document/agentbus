package quota

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// OpenRouter: the key's credits (GET /api/v1/credits, documented), told as
// a USD balance, what was bought less what was used.

type openRouterProvider struct{}

var openRouterKeys = keySource{env: []string{"OPENROUTER_API_KEY"}, hosts: []string{"openrouter.ai"}}

func (openRouterProvider) ID() string   { return "openrouter" }
func (openRouterProvider) Detect() bool { return openRouterKeys.find() != "" }

func (openRouterProvider) Read(ctx context.Context) ([]Reading, error) {
	key := openRouterKeys.find()
	if key == "" {
		return nil, errNotLoggedIn
	}
	b, err := doJSON(ctx, "GET", strings.TrimSuffix(openRouterBaseURL, "/")+"/credits", map[string]string{"Authorization": "Bearer " + key}, nil)
	if err != nil {
		return nil, errors.New(sanitize(err.Error(), key))
	}
	bal, err := parseOpenRouter(b)
	if err != nil {
		return nil, err
	}
	return []Reading{{Window: windowBalance, Balance: bal}}, nil
}

// parseOpenRouter reads {"data":{"total_credits":20,"total_usage":3.5}}.
func parseOpenRouter(b []byte) (*Balance, error) {
	var r struct {
		Data struct {
			Credits any `json:"total_credits"`
			Usage   any `json:"total_usage"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	credits, ok := number(r.Data.Credits)
	if !ok {
		return nil, errors.New("no credits in the reply")
	}
	used, _ := number(r.Data.Usage)
	return &Balance{Amount: roundCents(credits - used), Currency: "USD"}, nil
}

func roundCents(v float64) float64 {
	if v < 0 {
		return -roundCents(-v)
	}
	return float64(int64(v*100+0.5)) / 100
}
