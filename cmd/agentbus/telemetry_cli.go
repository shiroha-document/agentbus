package main

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
	"github.com/shiroha-document/agentbus/internal/telemetry"
	"github.com/shiroha-document/agentbus/internal/tui"
)

// CLI analytics (contract §5). Events are queued in <config dir>/events.jsonl
// and uploaded best-effort at the end of commands that already built a hub
// client. Only enumerated values, counts and flag NAMES are recorded.

// usedClient is the hub client the current command built (nil: the command
// did not talk to the hub, so nothing is flushed).
var usedClient *hub.Client

// newClient builds a hub client and remembers it for the final flush.
func newClient(cfg *hub.Config, k ed25519.PrivateKey) *hub.Client {
	cl := hub.NewClient(cfg, k, hubVersion())
	usedClient = cl
	return cl
}

// pendingEvents are recorded by commands (setup steps, tick outcome) and
// written to the queue when the command ends, so events from before the first
// join (setup's CLI choice) are kept once the config dir exists.
var pendingEvents []hub.Event

func recordEvent(name string, props map[string]any) {
	pendingEvents = append(pendingEvents, hub.Event{Name: name, At: time.Now().UnixMilli(), Props: props})
}

// initTelemetry points the queue at the config dir. Telemetry is on only once
// this machine has joined (hub.json exists) and the config does not opt out.
func initTelemetry() *hub.Config {
	dir := hub.Dir()
	cfg, err := hub.LoadConfig(dir)
	on := err == nil && (cfg.Telemetry == nil || *cfg.Telemetry)
	telemetry.Init(dir, on, hubVersion())
	if err != nil {
		return nil
	}
	return cfg
}

// commitEvents writes the pending events to the queue.
func commitEvents() {
	initTelemetry()
	writeEvents()
}

func writeEvents() {
	for _, ev := range pendingEvents {
		telemetry.Record(ev)
	}
	pendingEvents = nil
}

// knownFlags are the only flag names cli.command may report; anything else
// (for example a body that starts with "-") is dropped.
var knownFlags = map[string]bool{}

func init() {
	for _, f := range strings.Fields(`assignee attach before binary body body-file branch brief brief-file check cli
		days display-name done dry-run force goal interval join-code json key kind limit machine max-threads method
		mine name no-doctor no-quota no-schedule owner quiet quota-source reason reply repo report runs source status
		template thread tier timeout title trigger-url until usage-path version wake wake-interval workspace yes
		o lang hub hub-home h help`) {
		knownFlags[f] = true
	}
}

// subcommands that cli.command may report as "sub".
var knownSubs = map[string]bool{}

func init() {
	for _, s := range strings.Fields(`show state assign close list members approve reject workspace create update
		install uninstall remove status rotate on off get baseline`) {
		knownSubs[s] = true
	}
}

// flagNames returns the distinct known flag names in argv (before a bare
// "--"), comma-separated, never their values.
func flagNames(argv []string) string {
	seen := map[string]bool{}
	var out []string
	for _, a := range argv {
		if a == "--" {
			break
		}
		if len(a) < 2 || a[0] != '-' {
			continue
		}
		n, _, _ := strings.Cut(strings.TrimLeft(a, "-"), "=")
		if knownFlags[n] && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return strings.Join(out, ",")
}

// recordCommand queues cli.command for a finished command.
func recordCommand(cmd string, argv, rest []string, d time.Duration, code int) {
	defer func() { _ = recover() }()
	sub := ""
	if len(rest) > 0 && knownSubs[rest[0]] {
		sub = rest[0]
	}
	recordEvent("cli.command", map[string]any{"cmd": cmd, "sub": sub, "flags": flagNames(argv), "lang": i18n.Lang(),
		"tty": tui.IsTerminal(os.Stdout)})
	ev := &pendingEvents[len(pendingEvents)-1]
	ms := d.Milliseconds()
	ok := code == exitOK || code == exitNothing
	ev.DurationMS, ev.OK = &ms, &ok
	// the adapter is only known after the config is read
	if cfg := initTelemetry(); cfg != nil {
		ev.Props["adapter"] = cfg.CLI
	}
	writeEvents()
}

// flushTelemetry uploads queued events when the command talked to the hub
// and the hub was reachable.
func flushTelemetry(cmdErr error) {
	cl := usedClient
	usedClient = nil
	if cl == nil || (cmdErr != nil && strings.Contains(cmdErr.Error(), "hub unreachable")) {
		return
	}
	telemetry.Flush(context.Background(), cl)
}

// recordUpdate queues cli.update and writes it at once (the caller may
// re-execute a new binary right after).
func recordUpdate(from, to string) {
	recordEvent("cli.update", map[string]any{"from": strings.TrimPrefix(from, "v"), "to": strings.TrimPrefix(to, "v")})
	commitEvents()
}

// recordTick queues cli.tick from a tick outcome.
func recordTick(out hub.Outcome, cli string) {
	posted, timedOut, failed := 0, 0, 0
	for _, t := range out.Threads {
		if t.AgentPosted || t.TickPosted {
			posted++
		}
		if t.TimedOut {
			timedOut++
		}
		if t.ErrorSummary != "" || (t.Run != nil && t.Run.ExitCode != 0) {
			failed++
		}
	}
	recordEvent("cli.tick", map[string]any{"threads": len(out.Threads), "posted": posted, "timed_out": timedOut,
		"failed": failed, "adapter": cli})
}

// ---- agentbus telemetry status|on|off ----

func cmdTelemetry(c *cli, args []string) error {
	sub := "status"
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	if _, err := parse(newFlags("telemetry "+sub), args); err != nil {
		return err
	}
	dir := hub.Dir()
	switch sub {
	case "status":
		cfg := initTelemetry()
		cfgOn := cfg != nil && (cfg.Telemetry == nil || *cfg.Telemetry)
		res := map[string]any{"enabled": telemetry.Enabled(), "config": cfgOn, "env_off": telemetry.EnvOff(),
			"queued": telemetry.Queued(), "file": telemetry.Path(), "joined": cfg != nil}
		c.emit(res, func() {
			switch {
			case cfg == nil:
				fmt.Fprintln(c.out, i18n.Pick("telemetry: inactive (this machine has not joined a hub yet)",
					"使用统计：未生效（本机还没有加入 hub）"))
			case telemetry.EnvOff():
				fmt.Fprintln(c.out, i18n.Pick("telemetry: off (AGENTBUS_TELEMETRY disables it)", "使用统计：已关闭（被 AGENTBUS_TELEMETRY 关闭）"))
			case cfgOn:
				fmt.Fprintln(c.out, i18n.Pick("telemetry: on", "使用统计：已开启"))
			default:
				fmt.Fprintln(c.out, i18n.Pick("telemetry: off", "使用统计：已关闭"))
			}
			if cfg != nil {
				fmt.Fprintf(c.out, i18n.Pick("queued events: %d (%s)\n", "待上传事件：%d（%s）\n"), telemetry.Queued(), telemetry.Path())
			}
			fmt.Fprintln(c.out, i18n.Pick(
				"only command and flag names, enumerated choices, counts and timings are sent; never bodies, names, paths or tokens",
				"只上报命令名、参数名、枚举选项、计数和耗时；从不上报正文、名字、路径或密钥"))
		})
		return nil
	case "on", "off":
		cfg, err := hub.LoadConfig(dir)
		if err != nil {
			return err
		}
		on := sub == "on"
		cfg.Telemetry = &on
		if err := cfg.Save(dir); err != nil {
			return err
		}
		initTelemetry()
		if !on {
			telemetry.Clear()
		}
		c.emit(map[string]any{"enabled": on && !telemetry.EnvOff(), "config": on}, func() {
			if on {
				fmt.Fprintln(c.out, i18n.Pick("telemetry turned on, thanks", "已开启使用统计，谢谢"))
			} else {
				fmt.Fprintln(c.out, i18n.Pick("telemetry turned off; queued events deleted", "已关闭使用统计，并删除了待上传的事件"))
			}
		})
		return nil
	}
	return &exitError{code: exitUsage, msg: "telemetry status|on|off"}
}
