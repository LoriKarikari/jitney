set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
results=$root/e2e/results
mkdir -p "$results"
fixture_repo=LoriKarikari/jitney-test
worker_name=jitney

wrangler() { (cd "$root" && varlock run -- env CI=1 pnpm --dir worker exec wrangler "$@" </dev/null); }

cf_script() {
  (cd "$root" && METHOD=$1 SUFFIX=$2 BODY=${3:-} WORKER=$worker_name varlock run -- bash -c '
    args=(-sS -X "$METHOD" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
    [[ -n $BODY ]] && args+=(-d "$BODY")
    curl "${args[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER/$SUFFIX"
  ' </dev/null 2>/dev/null | jq -c .)
}

dispatch() {
  local workflow=$1 correlation=$2 id=""
  shift 2
  gh workflow run "$workflow" -R "$fixture_repo" -f correlation="$correlation" "$@" >/dev/null
  until [[ -n $id ]]; do
    sleep 5
    id=$(gh run list -R "$fixture_repo" --workflow "$workflow" --limit 10 --json databaseId,displayTitle \
      --jq ".[] | select(.displayTitle | endswith(\"$correlation\")) | .databaseId" | head -1)
  done
  echo "$id"
}

start_tail() {
  tail_log=$1
  (cd "$root" && varlock run -- pnpm --dir worker exec wrangler tail "$worker_name" --format json \
    </dev/null >"$tail_log" 2>/dev/null) &
  tail_pid=$!
  sleep 15
}
stop_tail() { pkill -P "$tail_pid" 2>/dev/null; kill "$tail_pid" 2>/dev/null; }

events() { jq -r 'select(.logs) | .logs[].message[0]' "$1" 2>/dev/null | jq -c 'select(type=="object")' 2>/dev/null; }

route_off() {
  original_route=$(cf_script GET subdomain | jq -c '.result')
  echo "route off: $(cf_script POST subdomain '{"enabled":false,"previews_enabled":false}' | jq -c '.result')"
  sleep 30
}
restore_route() { echo "route restored: $(cf_script POST subdomain "$original_route" | jq -c '.result')"; }
