#!/usr/bin/env bash
# Registers this container as a self-hosted runner and runs it.
#
# Two modes:
#   GITHUB_PAT   (recommended) fine-grained PAT; a fresh registration token is
#                fetched on every start and the runner is --ephemeral: one job,
#                then the container exits and compose restarts it clean.
#   RUNNER_TOKEN one-time registration token copied from the GitHub UI (valid
#                1h). The runner is persistent; survives `restart`, but after
#                `compose down` you need a new token.
set -euo pipefail

: "${RUNNER_SCOPE:?set RUNNER_SCOPE to an org (myorg) or a repo (owner/repo)}"
API=${GITHUB_API:-https://api.github.com}
LABELS=${RUNNER_LABELS:-agentbus}
NAME=${RUNNER_NAME:-agentbus-$(hostname)}
GROUP=${RUNNER_GROUP:-}
URL=https://github.com/$RUNNER_SCOPE
if [[ $RUNNER_SCOPE == */* ]]; then path=repos/$RUNNER_SCOPE; else path=orgs/$RUNNER_SCOPE; fi

api_token() { # $1 = registration-token | remove-token
	curl -fsS -X POST \
		-H "Authorization: Bearer $GITHUB_PAT" \
		-H "Accept: application/vnd.github+json" \
		-H "X-GitHub-Api-Version: 2022-11-28" \
		"$API/$path/actions/runners/$1" | jq -er .token
}

cd /home/runner
extra=()
if [[ -n ${GITHUB_PAT:-} ]]; then
	rm -f .runner .credentials .credentials_rsaparams
	if ! tok=$(api_token registration-token); then
		echo "entrypoint: cannot get a registration token for $RUNNER_SCOPE." >&2
		echo "  The PAT needs 'Self-hosted runners: Read and write' (org) or 'Administration: Read and write' (repo)." >&2
		sleep 60 # avoid a hot restart loop
		exit 1
	fi
	extra+=(--ephemeral)
elif [[ -n ${RUNNER_TOKEN:-} ]]; then
	tok=$RUNNER_TOKEN
else
	echo "entrypoint: set GITHUB_PAT or RUNNER_TOKEN in .env" >&2
	exit 1
fi
[[ -n $GROUP ]] && extra+=(--runnergroup "$GROUP")

if [[ ! -f .runner ]]; then
	./config.sh --unattended --replace --disableupdate \
		--url "$URL" --token "$tok" --name "$NAME" --labels "$LABELS" \
		--work _work "${extra[@]}"
fi
unset tok RUNNER_TOKEN

cleanup() {
	# best effort: an ephemeral runner that never got a job would linger offline
	if [[ -n ${GITHUB_PAT:-} && -f .runner ]]; then
		rt=$(api_token remove-token) && ./config.sh remove --token "$rt" || true
	fi
}
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; cleanup; exit 0' TERM INT

# the PAT must not be visible to jobs
env -u GITHUB_PAT ./run.sh &
pid=$!
wait "$pid"
