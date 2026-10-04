#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

start_tail "$results/deploy-during-job.tail.jsonl"
trap stop_tail EXIT
run=$(dispatch long-job.yml "e2e-deploy-$(date +%s)" -f seconds=900)
until [[ -n $(gh run view "$run" -R "$fixture_repo" --json jobs --jq '.jobs[0] | select(.status=="in_progress") | .startedAt') ]]; do
  sleep 5
done
sleep 300
# Setting a secret deploys a new Worker version.
echo "$(date -u +%FT%TZ) deploying a new Worker version"
printf '%s' "$run" | wrangler secret put JITNEY_E2E_DEPLOY --name "$worker_name" 2>&1 | grep -E "Success|rror"
gh run watch "$run" -R "$fixture_repo" --interval 30 >/dev/null 2>&1
wrangler secret delete JITNEY_E2E_DEPLOY --name "$worker_name" 2>&1 | grep -E "Success|rror"

conclusion=$(gh run view "$run" -R "$fixture_repo" --json conclusion --jq .conclusion)
job=$(gh run view "$run" -R "$fixture_repo" --json jobs --jq '.jobs[0].databaseId')
versions=$(events "$results/deploy-during-job.tail.jsonl" |
  jq -r --argjson id "$job" 'select(.workflowJobId==$id) | .deploymentId // empty' | sort -u | wc -l)

result=PASS
[[ $conclusion == success && $versions -ge 2 ]] || result=FAIL
{
  echo "result=$result"
  echo "run $run job $job: conclusion=$conclusion worker_versions_seen=$versions"
} | tee "$results/deploy-during-job.result"
[[ $result == PASS ]]
