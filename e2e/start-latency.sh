#!/usr/bin/env bash
# Queued-to-start time of the jitney-test canary. Dispatches it RUNS times in a
# row against get-jitney VERSION and prints the median wait.
# Usage: start-latency.sh LABEL [RUNS] [VERSION]. Writes results/start-latency-LABEL.log.
source "$(dirname "$0")/lib.sh"
label=$1 runs=${2:-5} version=${3:-latest}
log=$results/start-latency-$label.log
: >"$log"

for i in $(seq 1 "$runs"); do
  run=$(dispatch jitney.yml "e2e-latency-$label-$i-$(date +%s)" -f version="$version")
  gh run watch "$run" -R "$fixture_repo" --interval 15 >/dev/null 2>&1
  job=$(gh run view "$run" -R "$fixture_repo" --json jobs --jq '.jobs[] | select(.name=="canary") | .databaseId')
  wait=$(gh run view --job "$job" -R "$fixture_repo" --log 2>/dev/null | grep -o 'wait=[0-9]*' | head -1 | cut -d= -f2)
  echo "run=$i id=$run conclusion=$(gh run view "$run" -R "$fixture_repo" --json conclusion --jq .conclusion) wait=${wait}s" | tee -a "$log"
done
median=$(grep -o 'wait=[0-9]*' "$log" | cut -d= -f2 | sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}')
echo "median=${median}s" | tee -a "$log"
