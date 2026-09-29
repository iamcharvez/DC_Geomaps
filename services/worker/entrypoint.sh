#!/bin/sh
set -eu

mkdir -p /data/private/source /data/private/planetiler /data/public /data/work /data/logs
chown -R geomap:geomap /data
exec gosu geomap python3 /app/worker.py

