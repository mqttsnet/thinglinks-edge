#!/bin/sh
set -eu
mkdir -p /data/runtime /data/evidence /data/nodered
printf '{"name":"thinglinks-serial-lab","version":"0.0.0","private":true}\n' > /data/runtime/package.json
npm install --prefix /data/runtime --ignore-scripts --omit=dev --no-audit --no-fund --registry="${LAB_REGISTRY:-http://registry:2080/}" node-red-contrib-modbus@5.60.2 > /data/evidence/install.log 2>&1
if node /opt/rtu-lab/native-probe.cjs > /data/evidence/native-before.jsonl 2>&1; then
  if [ -f /data/runtime/node_modules/@serialport/bindings-cpp/build/Release/bindings.node ]; then
    printf 'same-source-musl-rebuild-reused\n' > /data/evidence/native-build-mode.txt
  else
    printf 'original-prebuild\n' > /data/evidence/native-build-mode.txt
  fi
else
  npm rebuild --prefix /data/runtime --build-from-source @serialport/bindings-cpp > /data/evidence/native-rebuild.log 2>&1
  printf 'same-source-musl-rebuild\n' > /data/evidence/native-build-mode.txt
fi
node /opt/rtu-lab/native-probe.cjs > /data/evidence/native-after.jsonl 2>&1
ln -sfn /data/runtime/node_modules /data/nodered/node_modules
exec node /opt/rtu-lab/fixture.cjs
