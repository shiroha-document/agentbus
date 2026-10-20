package hub

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSignatureVector(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "hub", "testdata", "sig-vector.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		SeedHex       string `json:"seed_hex"`
		PublicKeyB64  string `json:"public_key_b64"`
		Method        string `json:"method"`
		PathWithQuery string `json:"path_with_query"`
		Timestamp     string `json:"timestamp"`
		Nonce         string `json:"nonce"`
		Body          string `json:"body"`
		SigningString string `json:"signing_string"`
		SignatureB64  string `json:"signature_b64"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	seed, err := hex.DecodeString(v.SeedHex)
	if err != nil {
		t.Fatal(err)
	}
	k := ed25519.NewKeyFromSeed(seed)
	if got := PublicKeyB64(k); got != v.PublicKeyB64 {
		t.Fatalf("public key %s, want %s", got, v.PublicKeyB64)
	}
	if got := SigningString(v.Method, v.PathWithQuery, v.Timestamp, v.Nonce, []byte(v.Body)); got != v.SigningString {
		t.Fatalf("signing string\n%q\nwant\n%q", got, v.SigningString)
	}
	if got := Sign(k, v.Method, v.PathWithQuery, v.Timestamp, v.Nonce, []byte(v.Body)); got != v.SignatureB64 {
		t.Fatalf("signature %s, want %s", got, v.SignatureB64)
	}
	// key file round trip
	p := filepath.Join(t.TempDir(), "key.seed")
	if err := SaveKey(p, k); err != nil {
		t.Fatal(err)
	}
	k2, err := LoadKey(p)
	if err != nil || !k2.Equal(k) {
		t.Fatalf("LoadKey: %v", err)
	}
	if st, _ := os.Stat(p); !isWindows() && st.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", st.Mode())
	}
}

func TestNonce(t *testing.T) {
	n := NewNonce()
	if len(n) != 32 || strings.Trim(n, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") != "" {
		t.Fatal(n)
	}
	id := NewID("r", time.UnixMilli(1792500000000))
	if !strings.HasPrefix(id, "r_") || len(id) != 28 {
		t.Fatal(id)
	}
}

func TestClientSignsAndErrors(t *testing.T) {
	k, _ := GenerateKey()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		body := readAll(r)
		sig := r.Header.Get("X-Agentbus-Signature")
		ss := SigningString(r.Method, r.URL.RequestURI(), r.Header.Get("X-Agentbus-Timestamp"), r.Header.Get("X-Agentbus-Nonce"), body)
		if !verify(k.Public().(ed25519.PublicKey), ss, sig) {
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("X-Agentbus-Version") != "9.9.9" || r.Header.Get("X-Agentbus-Member") != "m_1" {
			w.WriteHeader(400)
			return
		}
		switch r.URL.Path {
		case "/api/v1/agent/state":
			w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
			_, _ = w.Write([]byte(`{"member":{"id":"m_1","status":"active"},"pending":2}`))
		case "/api/v1/agent/heartbeat": // 503 twice, then OK
			if n < 3 {
				w.WriteHeader(503)
				return
			}
			_, _ = w.Write([]byte(`{"lease_until":42}`))
		case "/api/v1/agent/claim":
			w.WriteHeader(503)
		case "/api/v1/agent/context":
			w.WriteHeader(426)
			_, _ = w.Write([]byte(`{"error":{"code":"client_too_old","message":"min 1.0.0","upgrade":"agentbus self-update"}}`))
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"no such thread"}}`))
		}
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, MemberID: "m_1", Key: k, Version: "9.9.9", Backoff: func(int) time.Duration { return time.Millisecond }}
	ctx := context.Background()
	s, err := c.State(ctx)
	if err != nil || s.Pending != 2 || s.Member.ID != "m_1" {
		t.Fatalf("%+v %v", s, err)
	}
	if c.LastDate.IsZero() {
		t.Fatal("Date header not recorded")
	}
	calls.Store(0)
	lu, err := c.Heartbeat(ctx, "t_1")
	if err != nil || lu != 42 || calls.Load() != 3 {
		t.Fatalf("heartbeat retry: %v %d calls=%d", err, lu, calls.Load())
	}
	calls.Store(0)
	if _, err := c.Claim(ctx, 1); !IsStatus(err, 503) || calls.Load() != 1 {
		t.Fatalf("claim must not retry: %v calls=%d", err, calls.Load())
	}
	_, err = c.Context(ctx, "t_x")
	if !IsTooOld(err) || !strings.Contains(err.Error(), "agentbus self-update") {
		t.Fatalf("426: %v", err)
	}
	_, err = c.Posts(ctx, "t_x", "", 0)
	if !IsStatus(err, 404) || !strings.Contains(err.Error(), "no such thread") {
		t.Fatalf("404: %v", err)
	}
}
