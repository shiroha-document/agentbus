// Package telemetry queues CLI analytics events (contract docs/design/v06-contract.md §5).
//
// Skeleton created by the integrator so every package can call Record; the
// Go-1 workstream implements the on-disk queue, opt-out and flushing.
package telemetry

import "github.com/shiroha-document/agentbus/internal/hub"

// Record queues one event. Never blocks on the network and never fails.
func Record(ev hub.Event) {
	_ = ev
}
