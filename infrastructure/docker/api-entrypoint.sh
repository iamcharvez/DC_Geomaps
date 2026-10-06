#!/bin/sh
set -eu

store_path="${INTEGRATION_DATA_PATH:-/data/integration/keys.json}"
store_dir="$(dirname "$store_path")"
mkdir -p "$store_dir"
chown -R node:node "$store_dir"

exec gosu node "$@"
