# Acquisition template extension guide

Recipes are pure flow builders. They do not install packages, contact devices, write databases, or deploy flows.

## Responsibilities

| Location | Responsibility |
|---|---|
| `../../protocols/catalog.ts` | Protocol identity, fixed driver version/integrity, required runtime node types |
| `types.ts` | Declarative recipe and parameter contracts |
| `parameters.ts` | Bounded, typed input validation; no coercion of empty numeric values |
| `service-mapping.ts` | Default/per-point service resolution, composite property identities and private native read aliases |
| `builtin/common.ts` | Shared point schemas, device registration and ThingLinks uplink wiring |
| `transform.ts` | Tested data conversion; parameters are serialized as data, never interpolated as code |
| `presence-flow.ts` / `presence-observation.ts` | Shared ordered observation transport and version-specific native connection classification; no protocol driver |
| `presence-http-transport.ts` | HTTP-push receipt via the same authenticated Manager ingress; no direct MQTT publishing |
| `../../edge/presence-observers/` | Persistent observer generations/sequences, aggregation and collector leases |
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
| `../../protocols/diagnostics/` | Persistent, instance-gated one-shot diagnostics; native node flow composition, result validation and owned-flow cleanup |

The Modbus console helpers live under `apps/web-console/src/views/flows/protocols/modbus/`: point import and read-value decoding are pure functions, the read-session controller handles asynchronous task state, and Vue panels present connection and result guidance. Diagnostics use a separate lifecycle service rather than adding device I/O to recipes. A trial requires an approved, actually loaded driver but no Cloud identity; it creates one temporary TCP connection and only FC3/FC4 requests. Device connection limits still apply.

The remaining protocol panels share bounded CSV/TSV parsing and schema-driven point import under `apps/web-console/src/views/flows/protocols/shared/`. Connection guidance uses the selected instance's recorded protocol/port mappings and `adminRoot`; it does not invent a reachable host or bypass device-ingress authentication. Import previews are local format checks, not device reads. Full address validation remains in recipes. Text identity fields may opt into `preserveWhitespace` so OPC UA string identifiers are not changed by form normalization or import; ordinary text retains trimming. A conditionally visible field is required only when its condition matches, while supplied values still receive normal type and bounds checks.

Diagnostic intent and cleanup state are persisted before adding a single Node-RED flow. A one-use lease gates its read; restart recovery only cleans up, never replays the request. The shared instance gate blocks conflicting writes and snapshot capture, and cleanup checks private node ownership and external references before deleting its own tab. Node-RED does not offer atomic compare-and-delete for a single flow; direct administration bypassing Edge is outside this serialization guarantee. Retaining instance data with unfinished diagnostics is rejected; purging settles diagnostics only after the runtime and data are confirmed absent.

## Adding a protocol

1. Select a published driver and inspect its integrity-matched node configuration schema. Register exact requirements in the protocol catalogue. Update the dedicated protocol dependency lock and regenerate its complete offline seed; do not add a runtime dependency to Manager just to advertise the driver.
2. Add a recipe under `builtin/`. Declare labels, defaults, bounds, a point table, prerequisites and a revision. Require the actual ThingLinks device identification and resolve each point's service. Keep credentials out of shared parameters; configure them within the target instance.
3. Build standard Node-RED nodes with explicit references. Route only successful values through device registration and the Manager uplink ingress. Most templates use `tl-uplink`; HTTP push uses standard HTTP Request to the same ingress so it can check the actual acceptance response before acknowledging the device. Add any new config-node reference fields to `../merge.ts`, so append can copy them without editing string literals or executable source.
4. Register the recipe in `catalog.ts`. Cover valid configuration, invalid/empty parameters, multi-point decoding and flow references with focused tests. Execute generated Function code in tests using representative raw data, including error and precision boundaries.
5. Run isolated installation and recipe verification on each supported target architecture. Record node loading, simulator acquisition, actual hardware and deployed ThingLinks acceptance separately. Only validated recipes become executable entries; extension candidates remain explicitly unavailable.

## Operational boundaries

- Builtin examples are disabled. Rendering requires valid parameters. Deployment preflight requires loaded core nodes and exact approved driver/platform versions; a configured custom copy retains these requirements.
- The console defaults to adding a flow. Legacy direct/custom API calls without `mode` keep their historical replacement semantics. Explicit replacements remain visible actions.
- Append uses Node-RED API v2 revisions to reject concurrent editor changes. It retains existing flows and remaps known references; unknown config-reference schemas produce an actionable error.
- TCP/UDP listener templates require configured instance port mappings. HTTP receive paths are beneath the instance HTTP-node root and require a reachable, appropriately protected device ingress. Templates do not change network or authentication policy.
- HTTP push returns 202 only after Manager has accepted every point in that sample across all mapped services; missing or partial acceptance returns 503. This is local acceptance, not Cloud delivery. MQTT publication likewise does not prove ThingLinks model matching or persistence.
- Numbers outside JavaScript's safe integer range are rejected. For large counters/identifiers, devices must emit strings and the mapping must preserve text. Invalid values are never replaced with zero.
- Polling, timestamp semantics, scaling and byte order must match the device contract. The existing Manager assigns event time on ingest; it does not reconstruct original device sampling timestamps.
- Local device declarations do not automatically register cloud subdevices. Product version, service and property mappings must already exist in ThingLinks.

## Multiple Cloud services from one acquisition

A template contains up to 300 mapped points in total and up to 32 services. Each point's optional `serviceCode` overrides the template default; a blank default is valid only when every point resolves to a service. Targets are identified by `[serviceCode, property]`: the same property name in two services is valid, while duplicate targets in one service are rejected. Saved point addresses and Cloud codes remain human-readable.

S7 and OPC UA compile private `raw_0`, `raw_1`, ... aliases. A repeated physical source with the same declared native type is read once and may feed several service/property conversions. An OPC UA NodeId must keep one native data type across its mappings. Do not use a Cloud property as the native alias: two services may both contain `temperature`.

The decoder emits one message per real input sample. Single-service samples retain the original scalar property object; multi-service samples carry `msg._tleServices` until the shared presence Function places `services: [{ serviceCode, values }]` in its version-1 internal envelope instead of `values`. All groups use one observer generation/sequence and one Manager request. This envelope is removed at Manager ingress; routing metadata never becomes Cloud properties. Do not split groups into separate uplink calls with the same sequence, or later groups would be treated as stale. Multi-service `tl-uplink` configuration leaves its fixed `serviceId` blank so the published node respects each message's selected service, including scalar OPC UA notifications.

## Presence lifecycle

Every configured collector has its own observer ID. Bootstrap challenge/activation uses a fixed predecessor revision; samples and negative observations share a persistent generation and increasing sequence. Only validated current samples establish online presence. A healthy peer preserves the device online state; all known sources must be unavailable to request offline. See [field presence](../../../../../../docs/guides/field-device-presence.md).

Configuration nodes created exclusively for a template carry its tab's `z` reference. They are copied and maintained with that flow; shared references for optional controls point to the same scoped configuration. Do not invent per-device protocol drivers or treat arbitrary red status labels, decode failures, or Manager errors as a physical disconnection.

Collector renewal is independent of device silence. Keep UDP/HTTP-push silence policies explicitly opt-in. Negative observations are retried at a bounded interval because the published platform node does not expose an acceptance flag on its output. S7 changes mode periodically sends a full real sample to recover an unacknowledged delivery gap.

## Command lifecycle

The bridge accepts only `deviceIdentification + serviceCode + cmd` bindings declared by a live, authenticated instance consumer. Copies of the same device control flow do not silently compete: multiple active consumers make the target ambiguous. A lease is delivered once. Device writes are never replayed by the bridge; failed receipt delivery is retried independently. Transport uncertainty is represented as `unknown`, not a confirmed device rejection.

Modbus builtin templates currently support acquisition only: control generation is disabled because the existing component can execute a delayed write after reconnection. Saved snapshots are retained; their control flows require explicit operator changes and redeployment. S7 acknowledges through the output node's completion event after the driver write promise resolves. The OPC UA controlled recipe configures existing `@tier0/opcua-client` nodes for protocol I/O and certificates. Template Functions only shape messages and validate responses. They check the Manager lease before handing off a write, but the component's relative queue/request timeouts do not enforce that absolute deadline. TCP and UDP control templates require the explicitly documented JSON acknowledgement contract. HTTP control requires a configured endpoint and an explicit execution acknowledgement.

Do not replace `ProtocolMid` with `number`, or use ordinary `JSON.stringify` to serialize an envelope with a large message ID. Actual Cloud Snowflake IDs exceed JavaScript's safe integer range. Internal large IDs are decimal strings; `serializeEnvelope` writes the original unquoted integer token required by the Cloud protocol.
