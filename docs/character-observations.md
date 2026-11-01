# Local crafting observations (draft host extension)

This isolated implementation adds `events:observations` and
`a2.on("observations", handler)`. It is additive to the API 2 host and also
works for API 1 manifests that declare the permission; the event has no
separate API-version minimum. Older hosts will
not send this event; consumers must feature-detect the schema below and keep
manual fallback available. It adds no file, network, process, raw-packet or
arbitrary decoder capability. No plugin catalog change or installation is
part of this patch.

The host sends an initial `plugin_hello.observations` snapshot and subsequent
changes only to enabled plugins declaring `events:observations`. The frame
also checks the permission before forwarding either. `events:character`
alone does not grant it. Both standalone and docked frames use this path.

## Schema v1

```js
{
  schema: "a2-character-observation/v1",
  source: "local-capture",
  status: "ready", // "waiting" or "stale" otherwise
  sessionRevision: 2, // process-local, resets with the meter run
  character: {
    entityId: 3888, name: "Tester", serverId: 1304,
    identityBasis: "self-profile", identityVerified: true
  }, // null until the current live stream supplies its own self profile
  observedAt: 0, // Unix ms: last accepted self profile, null until known
  stale: false,
  proficiency: {
    status: "verified", complete: true, observedAt: 0,
    commonLevel: 100, // null if any of the five levels differ
    commonLevelBasis: "all-five-self-profile-slots-equal",
    professionMapping: "unverified",
    skills: [ { id: 1, level: 100, verified: true } /* IDs 1..5 */ ],
    decoder: "self-profile-crafting-v1", reason: null
  },
  inventory: { status: "unknown", complete: false, items: [], reason: "..." },
  wallet: { status: "unknown", value: null, reason: "..." }
}
```

Only the locked server-to-client live capture flow enables publication.
Replay/debug processors are disabled by default. State resets on a different
processor/stream, authoritative character change, capture byte gap, stale
connection or observed game closure. Thirty seconds without packets makes
the snapshot stale. The timestamps describe observations, not an assurance
that an unchanged level was freshly transmitted. Consumers should also
enforce a bounded self-profile age, match name/server/entity to their current
character and reject older revisions within the same host run. Initial and
live character events are delivered before the corresponding observations.

## Decoding boundary

The proof source is the locally corroborated
`products/market-mvp/capture/proficiency-decoder.mjs` and its synthetic tests.
The native parser reuses the host's authoritative self-identity validation,
requires one complete leading `33 36` profile, mask `0x28c1815f / 0x37`,
five 13-byte rows at name-end + 59, IDs 1..5, levels 1..100, and eight zero
opaque bytes per row. Unseen layouts clear proficiency rather than retaining
an earlier value. Combat level, configured names, loot-voted ownership,
other-player spawns and manual assumptions cannot supply these levels.

A gap rotates the live observation session while retaining eligibility to
read the first recovered self profile from the same TCP-order result. A
recognized leading self frame that fails validation clears previous levels
without accepting its identity or renewing the last accepted profile time.
Non-self traffic leaves that accepted profile unchanged.

The profession-ID mapping is not proven. A consumer may use `commonLevel`
for every profession only after independently validating all five unique
verified rows agree. It must never map unequal raw slot IDs to profession
names or assume level 100. Explicit manual overrides remain possible.

Inventory record ownership/container semantics and full mutation coverage
are not proven by the existing candidate decoder. Candidate records are
therefore withheld here. A follow-up requires private replay evidence of
self-session ownership, relevant container meanings, complete baseline and
every mutation/gap invalidation before any purchase deduction is enabled.
The JS craft-receipt tracker proves only partial consumed-item usability;
it is not proof of the whole inventory. No proven wallet decoder exists;
`kinahToday` is gained today and cannot populate `wallet.value`. Wallet work
requires independently corroborated balance-change evidence and ownership.

## Validation

Synthetic Rust tests cover known/unequal levels, other-player rejection,
unsupported mask/opaque fields, duplicate IDs, truncation, multiple profiles,
replay isolation, session/character reset, stale capture and explicit unknown
wallet/inventory. Frontend tests cover initial/live permission delivery for
standalone and docked frames. No real capture is committed. Run the normal
developer CI, never release/publish workflows, before opening a PR.
Seeded-state regressions also cover a timed TCP hole and a far reconnect,
each returning Gap then recovered Bytes through the real TCP-order and
assembler path, and rejected leading self frames with missing name bits,
malformed/truncated fields, ambiguous identities and incomplete framing.
