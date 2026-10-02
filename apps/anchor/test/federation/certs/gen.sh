#!/usr/bin/env bash
# Generates the federation test CA and per-name leaf certs into ./out (gitignored). ECDSA P-256 only:
# Bun failed to verify an ed25519 CA. Idempotent: delete ./out to regenerate.
set -euo pipefail
cd "$(dirname "$0")"
out=out
[ -f "$out/ca.crt" ] && [ -f "$out/expired.test.crt" ] && exit 0
mkdir -p "$out"
cd "$out"

openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj '/CN=Novarum Federation Test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -out ca.crt

leaf() { # name san-name days [signer: ca|self] ; expired is made with `openssl ca` below
  local name=$1 san=$2 signer=${3:-ca}
  openssl ecparam -name prime256v1 -genkey -noout -out "$name.key"
  openssl req -new -key "$name.key" -subj "/CN=$san" -out "$name.csr"
  printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' "$san" >"$name.ext"
  if [ "$signer" = self ]; then
    openssl x509 -req -in "$name.csr" -signkey "$name.key" -sha256 -days 365 -extfile "$name.ext" -out "$name.crt" 2>/dev/null
  else
    openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 365 -extfile "$name.ext" -out "$name.crt" 2>/dev/null
  fi
  rm -f "$name.csr" "$name.ext"
}

for n in b.test evil.test evil2.test p.test q.test; do leaf $n $n; done
leaf wrongcert.test not-wrongcert.test      # valid chain, but for another name
leaf selfsigned.test selfsigned.test self   # not signed by the CA

# expired.test: signed by the CA with a validity window entirely in the past (needs `openssl ca`)
mkdir -p ca.db
: >ca.db/index.txt
echo 01 >ca.db/serial
cat >ca.cnf <<CNF
[ca]
default_ca = c
[c]
database = ca.db/index.txt
new_certs_dir = ca.db
serial = ca.db/serial
default_md = sha256
policy = p
unique_subject = no
copy_extensions = none
[p]
commonName = supplied
[ext]
subjectAltName = DNS:expired.test
basicConstraints = CA:FALSE
CNF
openssl ecparam -name prime256v1 -genkey -noout -out expired.test.key
openssl req -new -key expired.test.key -subj '/CN=expired.test' -out expired.test.csr
openssl ca -batch -config ca.cnf -cert ca.crt -keyfile ca.key -in expired.test.csr -out expired.test.crt \
  -startdate 20200101000000Z -enddate 20200102000000Z -extensions ext -notext 2>/dev/null
rm -rf ca.db ca.cnf expired.test.csr ca.srl
chmod 644 *.key *.crt
