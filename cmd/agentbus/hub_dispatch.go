package main

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"
	"os/signal"
	"regexp"
	"strings"

	"github.com/shiroha-document/agentbus/internal/hub"
)

// v3 (hub) commands. Names that also exist in v1 (join, thread, status, ack,
// whoami) live in hubCommands and are chosen per invocation by useHub; the
// rest are registered directly.
var hubCommands map[string]func(*cli, []string) error

func init() {
	hubCommands = map[string]func(*cli, []string) error{
		"join": cmdHubJoin, "thread": cmdHubThread, "status": cmdHubStatus,
		"ack": cmdHubAck, "whoami": cmdHubState,
	}
	for name, h := range map[string]func(*cli, []string) error{
		"state": cmdHubState, "tick": cmdTick, "post": cmdPost, "confirm": cmdConfirm,
		"quota": cmdQuota, "usage": cmdUsage, "keys": cmdKeys, "pause": cmdPause,
		"resume": cmdResume, "manage": cmdManage, "doctor": cmdDoctor, "setup": cmdSetup,
		"schedule": cmdSchedule,
	} {
		commands[name] = h
	}
}

// hubURLFlag is the global `--hub URL` (also accepted after the command).
var hubURLFlag string

// extractHubFlags removes `--hub URL` and `--hub-home DIR` (either position,
// before a bare "--") from args. --hub-home sets AGENTBUS_HUB_HOME so child
// processes (the coding CLI started by tick) see the same config dir.
func extractHubFlags(args []string) ([]string, string, error) {
	var out []string
	hubURL := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			out = append(out, args[i:]...)
			break
		}
		name, val, hasVal := strings.Cut(a, "=")
		if name != "--hub" && name != "--hub-home" && name != "-hub" && name != "-hub-home" {
			out = append(out, a)
			continue
		}
		if !hasVal {
			if i+1 >= len(args) {
				return nil, "", fmt.Errorf("%s needs a value", name)
			}
			i++
			val = args[i]
		}
		if strings.HasSuffix(name, "hub-home") {
			os.Setenv("AGENTBUS_HUB_HOME", val)
		} else {
			hubURL = val
		}
	}
	hubURLFlag = hubURL
	return out, hubURL, nil
}

// v1Join flags never exist on the v3 join.
var v1JoinFlags = map[string]bool{"repo": true, "remote": true, "me": true, "wait": true, "no-issue": true,
	"interval": true, "cap": true, "channel": true, "branch": true, "role": true, "desc": true}

// useHub decides whether a colliding command runs its v3 version: when a
// hub URL is given (`--hub URL`, or `join https://…`) or a hub config exists.
// join with v1-only flags always runs v1.
func useHub(cmd string, rest []string, hubURL string) bool {
	if cmd == "join" {
		for _, a := range rest {
			if a == "--" {
				break
			}
			n := strings.TrimLeft(strings.SplitN(a, "=", 2)[0], "-")
			if strings.HasPrefix(a, "-") && v1JoinFlags[n] {
				return false
			}
		}
		for _, a := range rest {
			if isHubURL(a) {
				return true
			}
		}
	}
	return hubURL != "" || hub.Exists(hub.Dir())
}

func isHubURL(s string) bool {
	return strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "http://")
}

var nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,31}$`)

// hubVersion is sent in X-Agentbus-Version and join's client_version. Source
// builds report their release line ("0.4.0-dev" -> "0.4.0") so a hub with
// min_client_version 0.4.0 accepts them.
func hubVersion() string { return strings.TrimSuffix(currentVersion(), "-dev") }

// hubEnv is a loaded config dir.
type hubEnv struct {
	dir string
	cfg *hub.Config
	key ed25519.PrivateKey
	cl  *hub.Client
}

func loadHub() (*hubEnv, error) {
	dir := hub.Dir()
	cfg, err := hub.LoadConfig(dir)
	if err != nil {
		return nil, err
	}
	if hubURLFlag != "" && strings.TrimRight(hubURLFlag, "/") != cfg.HubURL {
		return nil, fmt.Errorf("this machine is joined to %s, not %s (use --hub-home DIR for another identity)", cfg.HubURL, hubURLFlag)
	}
	k, err := hub.LoadKey(hub.Paths{Dir: dir}.Key())
	if err != nil {
		return nil, fmt.Errorf("loading key: %w", err)
	}
	return &hubEnv{dir: dir, cfg: cfg, key: k, cl: hub.NewClient(cfg, k, hubVersion())}, nil
}

func (e *hubEnv) paths() hub.Paths { return hub.Paths{Dir: e.dir} }

// cmdContext is cancelled on Ctrl-C.
func cmdContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt)
}

// threadArg returns the explicit thread or $AGENTBUS_THREAD.
func threadArg(explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if t := strings.TrimSpace(os.Getenv("AGENTBUS_THREAD")); t != "" {
		return t, nil
	}
	return "", &exitError{code: exitUsage, msg: "missing thread: pass --thread T (inside a tick round $AGENTBUS_THREAD is set)"}
}
