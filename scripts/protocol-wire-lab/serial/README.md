# Modbus-RTU serial wire lab

This is test infrastructure. It does not change Edge container permissions, enable product RTU support, or prove USB/RS485 electrical compatibility.

## Verified transport

The pinned `node-red-contrib-modbus@5.60.2` client uses `@openp4nr/modbus-serial@8.4.0`, SerialPort 10.5.0 and bindings-cpp 10.8.0. Socat creates two real Linux PTYs in the same container/devpts namespace. The package's `ServerSerial` opens one slave and the formal Node-RED `modbus-read` opens the other. No MockBinding is used.

On the ARM64 `nodered/node-red:5.0.4-24-minimal` image (Node 24.18.1), loading the original native addon succeeded but opening the PTY caused SIGSEGV. Rebuilding the original bindings-cpp 10.8.0 source against the image's musl environment fixed the actual open. JavaScript package versions and published tarballs were not changed. The build artifact and its hash are recorded separately.

## Reproduce the isolated lab

From the Edge repository root:

```sh
node --test scripts/protocol-wire-lab/serial/*.test.cjs
node scripts/protocol-wire-lab/serial/lab.mjs
node scripts/protocol-wire-lab/serial/verify.mjs /absolute/path/from/STATE_FILE
node scripts/protocol-wire-lab/serial/export.mjs /absolute/path/from/STATE_FILE
```

The lab prints an exact state file, captured container IDs and localhost URL. Its containers have a unique `com.mqttsnet.thinglinks-edge.serial-lab` label, a private test network, non-root execution, read-only root filesystem, all capabilities dropped and no privileged/device mappings. The fixture starts socat externally; Node-RED's exec node remains excluded.

The default explicit network is `10.253.240.0/28` because the current host's Docker default pools were exhausted. Inspect existing routes/subnets first and select a free range with `SERIAL_LAB_SUBNET` when running another lab. Do not delete unrelated networks to make room.

`lab.mjs` uses the repository's original offline tarball cache through an owned read-only registry container. The native fallback compiles from the same installed package source using headers in `/usr/local`. `rebuild.mjs STATE_FILE` rebuilds and replaces only the captured, label-verified lab Node-RED container; test data and the registry remain.

The programmatic flow reads FC3 registers 0..1 from unit 1 at 9600/8N1. Register 0 changes from 250 to 375. A Node-RED Function computes `raw * 0.1 + 1`, giving 26 and 38.5. The verification includes corrupted response CRC, wrong unit, truncated response, disconnection and recovery. This programmatic flow is driver evidence, not a substitute for the later Edge/ThingLinks browser acceptance.

Evidence lives under the state directory:

- `verification.json`, `serveronly-verification.json`: measured results.
- `data/evidence/wire.jsonl`, `socat.log`: raw request/response bytes and independent CRC checks.
- `data/evidence/outputs.jsonl`: actual formal Node-RED output and computed values.
- `data/evidence/native-pty-failure.jsonl`, `native-pty-after.jsonl`, `native-build-mode.txt`, `native-rebuild.log`: native baseline, same-source repair and PTY opening.
- `device-fixture/manifest.json`: hashes for the exported helper, socat libraries and native addon.

The bundled ServerSerial implementation rewrites the request CRC before parsing it. Therefore the lab independently validates captured original wire bytes; its happy path must not be used to claim that this server library rejects invalid request CRCs. Fault injection alters only device-response bytes before writing to the real serial port.

## Device-only reuse in the authorized managed test instance

Root performs these actions, after checking the current captured container ID belongs to `ui-cloud-0909`. Do not use an unrelated instance or `line-1`. No ingest token, settings or credentials are read or copied.

1. Copy only the generated `device-fixture` directory to `/data/rtu-lab` in that test container. Prepare an evidence directory writable by `node-red`.
2. Run the explicit helper as `node-red`:

```sh
docker exec --user node-red "$LAB_INSTANCE_ID" node /data/rtu-lab/prepare-managed.cjs ui-cloud-0909
```

The helper checks `TLE_INSTANCE_ID`, resolves the exact Modbus-owned SerialPort binding, verifies every expected package version and the artifact hash, and installs only the compiled same-version native addon at the resolved package's `build/Release/bindings.node`. It never assumes that the top-level binding belongs to Modbus: other drivers can carry a different version. It prints only the public target path/version/hash and a restart-required flag.

3. Stop/start that temporary instance from Edge's page so its Node-RED process loads the rebuilt addon. Redeploying a flow alone does not unload a native module already resident in the process.
4. Start the device-only fixture in the same container:

```sh
docker exec -d --user node-red \
  -e LAB_SERVER_ONLY=1 \
  -e LAB_MODULE_PACKAGE=/data/package.json \
  -e LAB_EVIDENCE_DIR=/data/rtu-lab-evidence \
  -e LAB_SOCAT=/data/rtu-lab/bin/socat \
  -e LAB_LIBRARY_PATH=/data/rtu-lab/lib \
  "$LAB_INSTANCE_ID" node /data/rtu-lab/fixture.cjs
```

Server-only mode starts no additional Node-RED runtime. It opens PTYs and serves the device simulator on container-local port 1881. It never automatically rebuilds or changes an existing instance's dependencies.

5. From Node-RED's page configure the official client:

```json
{
  "clienttype": "serial",
  "serialPort": "/tmp/tle-rtu-collector",
  "serialType": "RTU-BUFFERD",
  "serialBaudrate": 9600,
  "serialDatabits": 8,
  "serialStopbits": 1,
  "serialParity": "none",
  "serialConnectionDelay": 100,
  "unit_id": 1,
  "parallelUnitIdsAllowed": false
}
```

`RTU-BUFFERD` is the actual pinned package's enum spelling. Read FC3/address 0/quantity 2. Wire the first output through the existing register decoder and service/property mapping, then through the real `tl-device` and `tl-uplink`. The simulator does not send data to Manager or Cloud itself.

## Device control endpoints

All paths below are on `http://127.0.0.1:1881` inside the container; no host port needs exposing. Use the test-container CLI to call the device endpoint, while configuring the acquisition flow through the page.

| Request | Meaning |
|---|---|
| `GET /lab/state` | Device raw value, mode, connected/nativeOpened flags and bounded raw-wire log |
| `POST /lab/state {"raw":250,"mode":"none"}` | Produce expected mapped value 26 |
| `POST /lab/state {"raw":375}` | Produce expected mapped value 38.5 |
| `POST /lab/state {"mode":"bad-crc","durationMs":10000}` | Bad device response CRC; revert after 10 seconds |
| `POST /lab/state {"mode":"wrong-unit","durationMs":10000}` | Valid CRC but wrong response station |
| `POST /lab/state {"mode":"truncated","durationMs":10000}` | Truncated serial response |
| `POST /lab/state {"connected":false}` | Close the simulated serial link |
| `POST /lab/state {"connected":true,"mode":"none","raw":375}` | Recreate PTYs and resume |
| `POST /lab/shutdown` | Stop only this lab fixture and its socat process |

Fault windows must not advance the valid collected value or its acquisition time; recovery must produce a new value through the formal node. A silent source does not, by itself, prove device OFFLINE. Do not add a second Modbus client to the same serial port to imitate the TCP control template: RTU bus ownership and write retry semantics need separate work.

## Cleanup

Keep the experiment for the browser handoff, then remove only its captured resources:

```sh
node scripts/protocol-wire-lab/serial/lab.mjs cleanup /absolute/path/from/STATE_FILE
```

This preserves evidence files and does not remove images or pre-existing containers, networks, volumes or instance data. The managed-instance device-only helper is separate; use `/lab/shutdown` and the test instance's normal page lifecycle when its UI acceptance is finished.
