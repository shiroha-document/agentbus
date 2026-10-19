#!/bin/sh
# Example payload for `agentbus task run ID [--claim] -- ./examples/long-task.sh`.
#
# task run sets AGENTBUS_TASK / AGENTBUS_ATTEMPT, heartbeats on its own, kills
# this process group if the issuer cancels, and turns lines like
#   ::agentbus-progress 40 compiling
# into progress events. Exit 0 = succeeded, non-zero = failed (stdout tail is
# attached to the result).
set -eu
echo "task $AGENTBUS_TASK attempt $AGENTBUS_ATTEMPT"
for step in fetch compile test package; do
  i=$((${i:-0} + 25))
  echo "::agentbus-progress $i $step"
  sleep 5
done
echo "all good"
