#!/bin/sh
# Daemon-style handler for `agentbus watch --exec`. Runs once per new event.
#
#   agentbus watch --interval 60s --exec ./examples/on-event.sh
#
# Env provided by watch: AGENTBUS_EVENT (JSON), AGENTBUS_EVENT_ID,
# AGENTBUS_EVENT_KIND, AGENTBUS_FROM.  Replace the bodies with your agent.
set -eu

case "$AGENTBUS_EVENT_KIND" in
msg)
  # Acknowledge receipt, then hand the message to your agent.
  agentbus read "$AGENTBUS_EVENT_ID" >/dev/null
  subject=$(printf '%s' "$AGENTBUS_EVENT" | jq -r '.subject // ""')
  echo "message from $AGENTBUS_FROM: $subject"
  # my-agent --prompt "$(agentbus read "$AGENTBUS_EVENT_ID")" && agentbus ack "$AGENTBUS_EVENT_ID"
  ;;
task.create)
  # Claim and run in the background; task run heartbeats and reports for us.
  title=$(printf '%s' "$AGENTBUS_EVENT" | jq -r '.subject // ""')
  echo "task offered by $AGENTBUS_FROM: $title"
  nohup agentbus task run "$AGENTBUS_EVENT_ID" --claim --attach-log -- \
    ./examples/long-task.sh >/dev/null 2>&1 &
  ;;
task.cancel)
  echo "task $AGENTBUS_EVENT_ID cancelled; task run stops the process group itself"
  ;;
*)
  : # receipts, progress, results: nothing to do
  ;;
esac
