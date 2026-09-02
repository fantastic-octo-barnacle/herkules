#!/usr/bin/env bash
set -euo pipefail

command=${1:-active}
selector=${2:-}
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}

# GitHub appends "inactive" statuses to earlier deployments of an environment; the newest status
# that is not one of those decides whether a deployment is a usable release.
successful_deployment() {
  local id=$1
  local state
  state=$(gh api "repos/$repository/deployments/$id/statuses" \
    --jq '[.[] | select(.state != "inactive")] | first | .state // ""')
  [[ "$state" == "success" ]]
}

production_deployment_ids() {
  gh api --paginate "repos/$repository/deployments?environment=production&per_page=100" --jq '.[].id'
}

deployment_json() {
  local id=$1
  gh api "repos/$repository/deployments/$id" --jq '
    select(.environment == "production")
    | select(.payload.release? != null)
    | {
        id,
        release: .payload.release,
        sourceSha: (.payload.sourceSha // .sha),
        ciCursor: (.payload.ciCursor // 0)
      }'
}

find_active() {
  local id payload
  while read -r id; do
    [[ -n "$id" ]] || continue
    successful_deployment "$id" || continue
    payload=$(deployment_json "$id")
    [[ -n "$payload" ]] || continue
    printf '%s\n' "$payload"
    return 0
  done < <(production_deployment_ids)
  printf '{}\n'
}

find_selected() {
  local id payload
  if [[ "$selector" =~ ^[0-9]+$ ]]; then
    successful_deployment "$selector" || {
      echo "deployment $selector is not successful" >&2
      return 1
    }
    payload=$(deployment_json "$selector")
    [[ -n "$payload" ]] || {
      echo "deployment $selector has no Herkules release payload" >&2
      return 1
    }
    printf '%s\n' "$payload"
    return 0
  fi
  if [[ ! "$selector" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "release must be a deployment ID or full Git SHA" >&2
    return 1
  fi
  while read -r id; do
    [[ -n "$id" ]] || continue
    successful_deployment "$id" || continue
    payload=$(deployment_json "$id")
    [[ -n "$payload" ]] || continue
    if [[ "$(jq -r '.sourceSha' <<<"$payload")" == "${selector,,}" ]]; then
      printf '%s\n' "$payload"
      return 0
    fi
  done < <(production_deployment_ids)
  echo "no successful production release found for $selector" >&2
  return 1
}

find_cursor() {
  local cursor
  cursor=$(gh api --paginate "repos/$repository/deployments?environment=production&per_page=100" \
    --jq '.[] | (.payload.ciCursor? // 0)' | sort -n | tail -n 1)
  printf '{"ciCursor": %s}\n' "${cursor:-0}"
}

case "$command" in
  active) find_active ;;
  cursor) find_cursor ;;
  find) find_selected ;;
  *) echo "usage: deployment-state.sh active | cursor | find <deployment-id|sha>" >&2; exit 2 ;;
esac
