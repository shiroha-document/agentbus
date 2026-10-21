#!/usr/bin/env bash
# One-shot Cloudflare Access setup for the agentbus hub (staging + production).
#
# Needs a short-lived Cloudflare API token with:
#   Account: Access: Apps and Policies Edit, Access: Service Tokens Edit, Access: Organizations Read
# Put it in a 0600 file and pass the path; it is never printed:
#   umask 077; pbpaste > /tmp/cf-setup.token
#   ACCESS_TEAM=<team> ADMIN_EMAIL_FILE=/tmp/admin_email hub/scripts/setup-access.sh /tmp/cf-setup.token
#
# What it does (idempotent; re-running updates instead of duplicating):
#   1. per env: self-hosted Access app on the hub domain (admin email only, 24h session),
#      plus a Bypass app for /api/v1/agent/* and /healthz (agents authenticate with ed25519)
#   2. staging only: a service token "agentbus-e2e" allowed on the staging app (for Playwright)
#   3. Worker secrets ACCESS_TEAM / ACCESS_AUD (and E2E_SERVICE_TOKEN_ID on staging) via wrangler
#   4. optional: GitHub secrets CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (if GH_PAT_FILE is set)
set -euo pipefail

TOKEN_FILE=${1:?usage: setup-access.sh TOKEN_FILE}
: "${ACCESS_TEAM:?set ACCESS_TEAM (Zero Trust team name = <team>.cloudflareaccess.com, see Zero Trust → Settings)}"
: "${ADMIN_EMAIL_FILE:?set ADMIN_EMAIL_FILE (file containing the admin email)}"
ACCOUNT=${CLOUDFLARE_ACCOUNT_ID:-9ef7b5b2b8b7edd222d26495c6c71cc9}
REPO=${GH_REPO:-shiroha-document/agentbus}
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access"
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORKER="$HERE/worker"
ADMIN_EMAIL=$(tr -d '\n\r ' <"$ADMIN_EMAIL_FILE")
umask 077
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

cf() { # cf METHOD PATH [JSON]
  local m=$1 p=$2 d=${3:-}
  local args=(-sS -X "$m" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H "Content-Type: application/json")
  [ -n "$d" ] && args+=(--data "$d")
  local r
  r=$(curl "${args[@]}" "$API$p")
  if [ "$(jq -r '.success' <<<"$r")" != "true" ]; then
    echo "Cloudflare API $m $p failed: $(jq -c '.errors' <<<"$r")" >&2
    exit 1
  fi
  jq '.result' <<<"$r"
}

find_app() { cf GET "/apps?per_page=100" | jq -r --arg n "$1" '.[] | select(.name == $n) | .id' | head -1; }

upsert_app() { # name domain json -> prints app json
  local id
  id=$(find_app "$1")
  if [ -n "$id" ]; then cf PUT "/apps/$id" "$3"; else cf POST "/apps" "$3"; fi
}

put_secret() { # env name value
  printf '%s' "$3" | (cd "$WORKER" && npx wrangler secret put "$2" --env "$1" >/dev/null)
  echo "  secret $2 set on $1"
}

# verify the team domain exists
curl -fsS "https://$ACCESS_TEAM.cloudflareaccess.com/cdn-cgi/access/certs" >/dev/null ||
  { echo "team $ACCESS_TEAM.cloudflareaccess.com not reachable; enable Zero Trust and pick the team name first" >&2; exit 1; }

# service token for e2e (staging)
ST_NAME=agentbus-e2e
st_id=$(cf GET "/service_tokens?per_page=100" | jq -r --arg n "$ST_NAME" '.[] | select(.name == $n) | .id' | head -1)
if [ -z "$st_id" ]; then
  cf POST "/service_tokens" "$(jq -nc --arg n "$ST_NAME" '{name: $n, duration: "8760h"}')" >"$OUT/st.json"
  st_id=$(jq -r '.id' "$OUT/st.json")
  echo "created service token $ST_NAME"
else
  echo "service token $ST_NAME exists (secret is only shown at creation; delete it in the dashboard to rotate)"
fi
st_client_id=$(cf GET "/service_tokens/$st_id" | jq -r '.client_id')

for env in staging production; do
  host=hub.shiroha.tech
  [ "$env" = staging ] && host=staging-hub.shiroha.tech
  echo "== $env ($host)"

  include=$(jq -nc --arg e "$ADMIN_EMAIL" '[{email: {email: $e}}]')
  policies=$(jq -nc --argjson inc "$include" '[{name: "admin", decision: "allow", include: $inc, precedence: 1}]')
  if [ "$env" = staging ]; then
    policies=$(jq -c --arg t "$st_id" '. + [{name: "e2e service token", decision: "non_identity", include: [{service_token: {token_id: $t}}], precedence: 2}]' <<<"$policies")
  fi
  app=$(upsert_app "agentbus hub $env" "$host" "$(jq -nc --arg n "agentbus hub $env" --arg d "$host" --argjson p "$policies" '{
      name: $n, type: "self_hosted", domain: $d,
      destinations: [{type: "public", uri: $d}],
      session_duration: "24h", app_launcher_visible: true,
      auto_redirect_to_identity: false, enable_binding_cookie: false,
      http_only_cookie_attribute: true, same_site_cookie_attribute: "lax",
      policies: $p }')")
  aud=$(jq -r '.aud' <<<"$app")
  echo "  app ok (aud ${aud:0:8}…)"

  upsert_app "agentbus hub $env agent api" "$host" "$(jq -nc --arg n "agentbus hub $env agent api" --arg d "$host" '{
      name: $n, type: "self_hosted", domain: ($d + "/api/v1/agent"),
      destinations: [{type: "public", uri: ($d + "/api/v1/agent")}, {type: "public", uri: ($d + "/healthz")}],
      session_duration: "24h", app_launcher_visible: false,
      policies: [{name: "bypass (ed25519 signatures)", decision: "bypass", include: [{everyone: {}}], precedence: 1}] }')" >/dev/null
  echo "  bypass app for /api/v1/agent + /healthz ok"

  put_secret "$env" ACCESS_TEAM "$ACCESS_TEAM"
  put_secret "$env" ACCESS_AUD "$aud"
  if [ "$env" = staging ]; then put_secret staging E2E_SERVICE_TOKEN_ID "$st_client_id"; fi
done

if [ -f "$OUT/st.json" ] && [ -n "${GH_PAT_FILE:-}" ]; then
  GH_TOKEN=$(cat "$GH_PAT_FILE") gh secret set CF_ACCESS_CLIENT_ID -R "$REPO" --body "$(jq -r '.client_id' "$OUT/st.json")"
  jq -r '.client_secret' "$OUT/st.json" | GH_TOKEN=$(cat "$GH_PAT_FILE") gh secret set CF_ACCESS_CLIENT_SECRET -R "$REPO"
  echo "GitHub secrets CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET set (repo)"
elif [ -f "$OUT/st.json" ]; then
  keep=/tmp/agentbus-secrets/e2e-service-token.json
  mkdir -p "$(dirname "$keep")"
  jq '{client_id, client_secret}' "$OUT/st.json" >"$keep"
  echo "service token credentials saved to $keep (0600); set them as GitHub secrets, then delete the file"
fi
echo "done. Revoke the setup token now."
