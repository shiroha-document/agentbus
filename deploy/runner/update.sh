#!/bin/sh
# Keep the self-hosted runner current. Safe to run from cron at any time:
#
#   15 4 * * * $HOME/src/agentbus/deploy/runner/update.sh >> $HOME/.agentbus/runner-update.log 2>&1
#
# 1. fast-forwards the public agentbus checkout (runner kit + docs);
# 2. rebuilds the image with --pull when the kit changed, or when the image is
#    older than 7 days. GitHub refuses runner versions that fall too far
#    behind, and the container runs with --disableupdate, so the weekly
#    rebuild is what keeps the runner registered;
# 3. updates the agentbus CLI itself.
#
# The ephemeral runner finishes its current job before compose replaces it
# (stop_grace_period), so an update never kills a job half-way through.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
cd "$here"
[ -f .env ] || { echo "update.sh: $here/.env missing; follow docs/ONBOARDING.md §3 first" >&2; exit 1; }

before=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" pull --ff-only --quiet
after=$(git -C "$repo" rev-parse HEAD)

rebuild=
if [ "$before" != "$after" ] && ! git -C "$repo" diff --quiet "$before" "$after" -- deploy/runner; then
	rebuild="runner kit changed"
fi
created=$(docker image inspect -f '{{.Created}}' agentbus-runner:local 2>/dev/null || true)
if [ -z "$created" ]; then
	rebuild="no image yet"
else
	# portable "older than 7 days" check: compare YYYY-MM-DD strings
	cutoff=$(date -u -d '7 days ago' +%F 2>/dev/null || date -u -v-7d +%F)
	[ "$(printf %.10s "$created")" \< "$cutoff" ] && rebuild="image older than 7 days"
fi

if [ -n "$rebuild" ]; then
	echo "$(date -u +%FT%TZ) rebuilding runner: $rebuild"
	docker compose build --pull --quiet
	docker compose up -d
	docker image prune -f >/dev/null
else
	echo "$(date -u +%FT%TZ) runner up to date ($after)"
fi

if command -v agentbus >/dev/null 2>&1; then
	agentbus self-update || echo "update.sh: agentbus self-update failed (will retry next run)" >&2
fi
