# Acquisition template extension guide

Recipes are pure flow builders. They do not install packages, contact devices, write databases, or deploy flows.

## Responsibilities

| Location | Responsibility |
|---|---|
| `../../protocols/catalog.ts` | Protocol identity, fixed driver version/integrity, required runtime node types |
| `types.ts` | Declarative recipe and parameter contracts |
| `parameters.ts` | Bounded, typed input validation; no coercion of empty numeric values |
| `builtin/common.ts` | Shared point schemas, device registration and ThingLinks uplink wiring |
| `transform.ts` | Tested data conversion; parameters are serialized as data, never interpolated as code |
| `framing.ts` | Bounded TCP stream reassembly per connection |
| `builtin/*.ts` | One protocol's connection configuration, parameters and flow builder |
| `catalog.ts` | Metadata, disabled examples, validated configured flows |
| `model-mapping.ts` | Server-side mapping checks against an explicitly selected cached Cloud model |
| `control-flow.ts` | Optional command-path composition and protocol prerequisites |
| `control-codec.ts` | Strict inverse conversion and write request encoding |
| `control-runtime.ts` | Instance-authenticated command leases and execution-result reporting |
| `control-opcua-managed.ts` | Message shaping, target/Good-status correlation and deadline notices around existing tier0 nodes; no protocol executor |
| `../../cloud/commands/` | Persistent routing, model validation, deduplication, delivery leases and receipts |
| `../../cloud/mid.ts` | Lossless signed-Long message identity and canonical comparison |
| `../deployment.ts` | Loaded dependency checks, revision-aware append/replace deployment |
| `../merge.ts` | Explicit reference schemas and safe graph copying |
| `../repo.ts` | Custom templates and trusted builtin-derived metadata |

## Adding a protocol

1. Select a published driver and inspect its integrity-matched node configuration schema. Register exact requirements in the protocol catalogue. Update the dedicated protocol dependency lock and regenerate its complete offline seed; do not add a runtime dependency to Manager just to advertise the driver.
2. Add a recipe under `builtin/`. Declare labels, defaults, bounds, a point table, prerequisites and a revision. Require the actual ThingLinks device identification and service code. Keep credentials out of shared parameters; configure them within the target instance.
3. Build standard Node-RED nodes with explicit references. Route only successful values through device registration and `tl-uplink`. Add any new config-node reference fields to `../merge.ts`, so append can copy them without editing string literals or executable source.
4. Register the recipe in `catalog.ts`. Cover valid configuration, invalid/empty parameters, multi-point decoding and flow references with focused tests. Execute generated Function code in tests using representative raw data, including error and precision boundaries.
5. Run isolated installation and recipe verification on each supported target architecture. Record node loading, simulator acquisition, actual hardware and deployed ThingLinks acceptance separately. Only validated recipes become executable entries; extension candidates remain explicitly unavailable.

## Operational boundaries

- Builtin examples are disabled. Rendering requires valid parameters. Deployment preflight requires loaded core nodes and exact approved driver/platform versions; a configured custom copy retains these requirements.
- The console defaults to adding a flow. Legacy direct/custom API calls without `mode` keep their historical replacement semantics. Explicit replacements remain visible actions.
- Append uses Node-RED API v2 revisions to reject concurrent editor changes. It retains existing flows and remaps known references; unknown config-reference schemas produce an actionable error.
- TCP/UDP listener templates require configured instance port mappings. HTTP receive paths are beneath the instance HTTP-node root and require a reachable, appropriately protected device ingress. Templates do not change network or authentication policy.
- HTTP push acknowledgement describes parsing and asynchronous processing, not cloud delivery. MQTT publication likewise does not prove ThingLinks model matching or persistence.
- Numbers outside JavaScript's safe integer range are rejected. For large counters/identifiers, devices must emit strings and the mapping must preserve text. Invalid values are never replaced with zero.
- Polling, timestamp semantics, scaling and byte order must match the device contract. The existing Manager assigns event time on ingest; it does not reconstruct original device sampling timestamps.
- Local device declarations do not automatically register cloud subdevices. Product version, service and property mappings must already exist in ThingLinks.

## Command lifecycle

The bridge accepts only `deviceIdentification + serviceCode + cmd` bindings declared by a live, authenticated instance consumer. Copies of the same device control flow do not silently compete: multiple active consumers make the target ambiguous. A lease is delivered once. Device writes are never replayed by the bridge; failed receipt delivery is retried independently. Transport uncertainty is represented as `unknown`, not a confirmed device rejection.

Modbus builtin templates currently support acquisition only: control generation is disabled because the existing component can execute a delayed write after reconnection. Saved snapshots are retained; their control flows require explicit operator changes and redeployment. S7 acknowledges through the output node's completion event after the driver write promise resolves. The OPC UA controlled recipe configures existing `@tier0/opcua-client` nodes for protocol I/O and certificates. Template Functions only shape messages and validate responses. They check the Manager lease before handing off a write, but the component's relative queue/request timeouts do not enforce that absolute deadline. TCP and UDP control templates require the explicitly documented JSON acknowledgement contract. HTTP control requires a configured endpoint and an explicit execution acknowledgement.

Do not replace `ProtocolMid` with `number`, or use ordinary `JSON.stringify` to serialize an envelope with a large message ID. Actual Cloud Snowflake IDs exceed JavaScript's safe integer range. Internal large IDs are decimal strings; `serializeEnvelope` writes the original unquoted integer token required by the Cloud protocol.
