#!/bin/bash
set -e
DEV=/dev/disk/by-id/google-pgdata
MNT=/mnt/disks/pgdata
mkdir -p $MNT
blkid $DEV >/dev/null 2>&1 || mkfs.ext4 -F $DEV
mountpoint -q $MNT || mount -o discard,defaults $DEV $MNT
mkdir -p $MNT/data $MNT/certs
if [ ! -f $MNT/certs/server.key ]; then
  docker run --rm -v $MNT/certs:/certs postgres:16 bash -c "openssl req -new -x509 -days 3650 -nodes -subj '/CN=idswyft-postgres' -out /certs/server.crt -keyout /certs/server.key && chmod 600 /certs/server.key && chown 999:999 /certs/server.key /certs/server.crt"
fi
docker rm -f pg 2>/dev/null || true
docker run -d --name pg --restart always -p 0.0.0.0:5432:5432 \
  -e POSTGRES_USER=idswyft -e POSTGRES_PASSWORD=${DB_PASSWORD} -e POSTGRES_DB=idswyft \
  -v $MNT/data:/var/lib/postgresql/data -v $MNT/certs:/certs:ro \
  postgres:16 -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key
