# End-to-end encrypted spaces (Decentralized Spaces M8)

> Status: **design + first vertical slice, behind the default-off "Encrypted spaces" feature
> (Settings → Features).** Nothing here is enabled for users, and the wire format is
> **provisional** until the decisions in §0 are made. Contract name in code: `SPACE_E2EE_VERSION = 1`.
> Supersedes the plan in `NIP17_GROUP_ROOMS.md` for *spaces* (that doc still describes small
> DM rooms, which shipped with the DM wire contract).

MUST / SHOULD / MAY are RFC 2119.

## 0. Open contract decisions (owner's call)

Each of these changes what other clients must implement. The slice implements the
recommendation and keeps it behind one module so it is cheap to change (§15 says where).

| # | Decision | Recommendation | Alternatives | Cost of changing later |
|---|---|---|---|---|
| D1 | **Scheme** | A shared symmetric **epoch key** per space, rotated on member removal ("space keys v1"). MLS (Marmot) stays the tracked upgrade behind its audit gate; the inner message format is already the one Marmot uses (an unsigned Nostr event), so only the key layer would change. | (a) NIP-17 wraps per member: no relay gating, one wrap per member per message, NIP-17 itself says to stop at 10 participants. (b) Marmot now: one MLS leaf per device, no shared history, needs a native library the web build cannot load, relay loses membership gating. | High once clients ship. This is the main decision. |
| D2 | **Key transport** | An **in-space key grant** event (kind 4291): one event carries the epoch key wrapped to up to 80 members with a throwaway key. Rotation costs the admin **one signature** whatever the member count, and any device with the account key can re-derive its keys from the space's own relay. | NIP-17 gift wrap per member (how shared music-project keys travel). Costs one seal signature and two signer encryptions *per member* per rotation (minutes on a remote signer for 100 members), depends on each member's DM relays, and cannot be stored on a self-hosted space relay, which only accepts its own groups' events. | Medium: `spaceKeys.ts` grant codec + the grant subscription. |
| D3 | **Kind numbers** | `4290` sealed space event, `4291` space key grant. Both unallocated in the NIPs registry and in the Marmot, NIP-171, NIP-112 and Concord drafts. | Any other free regular kinds; or write this up as a NIP draft and take numbers from review. | Low before release (two constants in `packages/shared-types/src/spaceE2ee.ts`), breaking after. |
| D4 | **History for new members** | Default `epoch`: a new member reads everything since the last key change and nothing older. The creator can pick `full` (every epoch key is handed over) when creating the space. | `full` as default (parity with unencrypted spaces); or `none` (rotate on every join). | Low: a policy value inside the encrypted grant payload. |
| D5 | **What the relay may see** | Only: space id, sender, time, size, epoch id, and who holds keys. The inner kind, channel, replies, mentions and reactions are inside the ciphertext. | Leave routing tags (`channel`, `p` mentions) in the clear so the backend can push "you were mentioned". Leaks the in-space social graph, and an outer `p` tag also grants that pubkey relay read access. | Medium: additive tags later are easy, removing them is not. |
| D6 | **Which space modes** | All three (Platform, Decentralized A-lite, NIP-29-native). The envelope is an ordinary `h`-tagged event, so every relay that hosts the space gates it the same way. Platform spaces lose backend features (§8). | Native-only, so "encrypted" always means "no backend involved". | Low (one predicate in the create dialog). |
| D7 | **Who may hand out and rotate keys** | The space's **key root** (whoever made the first epoch) plus the `managers` each epoch names. Clients enforce it as a signed chain (§5.4), never from the server's role list. The slice names only the root; appointing further managers is an explicit action for phase 2. | Any member may re-share the current key (faster onboarding, weaker against a server that adds a ghost member). | Medium. |
| D11 | **How a device learns a space is encrypted** | Today: only from a key grant it has seen with the feature on (or by creating the space). Until then it treats the space as ordinary and can post plaintext there. D8 (a relay-enforced flag) is the fix and SHOULD land before this is offered beyond testing. | Carry a marker in invites and in 39000 as well; or make every client look for grants before its first post in any space. | Additive. |
| D12 | **Who a device trusts for its first key** | Today (trust on first use): the first grant a device sees is accepted from the space's creator, or, when the creator is unknown (an imported group), from a listed admin, and only when that grant names its own signer as the key root. Those lists come from the relay or the backend, so **a relay or backend that lies about the creator, or any listed admin of a group whose creator is unknown, can hand a device with no key yet a key of its choosing**, and that device then rejects the real keys. The pinned root is shown in the space's info panel so a wrong one can be noticed. Options: **(a, recommended)** carry the key root in the invite / join link, so a joiner pins the root the inviter vouched for and the server is out of the loop; (b) show a short fingerprint of the root to compare out of band, and ask the user to confirm it before the first key is used; (c) both: the link pins it, the fingerprint lets people check later; (d) keep trust on first use as it is. (a) adds a field to invite links of all three space modes. | Medium: (a) touches the invite formats; (b) is client-only. |
| D13 | **Which of two same-`seq` epochs to send with** | Today (§5.3): the smaller `epochId`. An issuer can generate keys until its epoch id is small, so a fork can always win the tie. Nothing can exploit it while only the root issues keys, so the slice leaves the rule as written. Options: (a, recommended) prefer the epoch the key root issued, then the earlier `at`, then the smaller id; (b) prefer the epoch whose grant the client accepted first (not the same on every device); (c) refuse a second epoch with an existing `seq` unless the root signed it. | Low while only the root issues; a rule every client must share once managers exist. |
| D8 | **Server-side "encrypted" flag** | Phase 2: the relay stores an `encrypted` flag per group and refuses plaintext chat kinds there; the backend gets a column for the directory badge. Not in the slice (needs a relay and a backend migration). | Client-only marker forever (what the slice does). | Additive. |
| D9 | **Push for encrypted spaces** | None in v1. Phase 3: opt-in, content-free "new activity in *space*" from the envelope's metadata only. | Mention pushes via cleartext `p` tags (see D5). | Additive. |
| D10 | **Reports to the platform operator** | Phase 3: the reporter discloses the per-message NIP-44 keys for the one reported event, so the operator can verify and read that message and nothing else (§8.4). Needs a crypto review before it ships. | Reports stay inside the space (admins hold the key); or unverifiable plaintext reports. | Additive. |

## 1. Summary

An encrypted space is a normal space whose chat travels as **sealed space events**: the relay
stores and gates them exactly like kind 9 (membership, rate limits, deletion), but the content
is NIP-44 ciphertext under a key only members hold. The key is per **epoch**. A space admin's
client hands the current epoch key to members with a **key grant** event and starts a new epoch
whenever someone is removed or leaves.

```
epoch key K (32 random bytes, one per epoch)
 ├─ epochId     = HKDF(K, "epoch-id")            16 hex, public, names the key
 ├─ contentKey  = HKDF(K, "content:" + spaceId)  NIP-44 v2 conversation key for sealed events
 └─ grantKey    = HKDF(K, "grant:"   + spaceId)  NIP-44 v2 conversation key for the grant payload

sealed space event (kind 4290, signed by the sender)      key grant (kind 4291, signed by a manager)
  tags  h=<space>, epoch=<epochId>                           tags  h=<space>, epoch=<epochId>, eph=<throwaway pubkey>,
  content = nip44(contentKey, JSON(rumor))                         p=<member>,<nip44(throwaway → member, hex(K))> × ≤ 80
                                                             content = nip44(grantKey, JSON(payload))
```

## 2. Threat model

**Protected.** Message content, and everything inside the rumor (kind, channel, replies,
mentions, attachments' URLs), against:

- the relay operator(s) hosting the space, including mirrors, and anyone who obtains the
  relay's database;
- the platform backend (it never receives sealed events and could not read them);
- the network;
- a member after they are removed: they keep what they could already read and get nothing
  from the next epoch on.

**Authenticity.** Every message is signed by its author's own key (the outer event), and the
rumor is bound to that author, so no member can post as another member.

**Explicit non-goals.**

- **Metadata.** The relay still sees who is a member, who posts, when, how much, in which
  space and under which epoch, who was given keys, and what gets deleted. Message sizes are
  blurred by NIP-44 padding (every short message is the same length on the wire).
- **The space's own description.** Its name, picture, about text, channel list and roles are
  not encrypted in v1: they live where they do today (the backend, the relay's 39000–39002,
  the 30078 layout overlay). Phase 3 can seal the layout.
- **Forward secrecy and post-compromise security inside an epoch.** A leaked epoch key reads
  the whole epoch. Rotation is the only ratchet. This is the price of the simple scheme and the
  reason MLS stays on the roadmap (D1).
- **A compromised member device or account key.** Whoever holds a member's key reads what
  that member can read. Decrypted messages are held in memory by the client; the cached epoch
  keys sit in the OS keychain (desktop).
- **Deniability.** Messages are signed.
- **A malicious server adding a member.** Membership is still decided by the relay or the
  backend. If it lists a ghost member, an honest admin's client will hand that member the key.
  The grant names every recipient in the clear and is signed, so clients can show every key
  hand-over; they cannot prevent it. A malicious server cannot *rotate* or *forge* keys (§5.4).
- **Write-side removal against a colluding relay.** After a rotation the relay stops accepting
  the removed member's events. A relay that colludes with them could still accept messages
  sealed under an old epoch; they are signed by the removed member and clients mark authors
  who are not on the roster.
- **Hiding that a space is encrypted**, traffic analysis, and availability (a relay can always
  drop events).

## 3. Options surveyed

Sources: NIP-17, NIP-44, NIP-59, NIP-29, NIP-EE and the Marmot protocol repository, plus the
open drafts NIP-171 (epoch-ticketed private groups), NIP-112 (encrypted group events) and the
Concord protocol, as of 2026-11.

| | NIP-17 rooms, scaled up | Shared epoch key (**chosen**) | MLS / Marmot |
|---|---|---|---|
| Cost per message | one seal + wrap per member | one event | one event |
| Cost of a membership change | none (new room = new history) | one grant event (≤ 80 members each) | commit + welcome, O(log n) |
| Relay membership gating, rate limits, deletion | lost (wraps bypass NIP-29) | **kept** | lost (ephemeral author per event) |
| Forward secrecy / post-compromise | no | per epoch only | yes |
| Multi-device | free (account key) | free (account key) | one leaf per device, pairing flow |
| Remote signer (NIP-46) | 2 decrypts per message | 1 decrypt per epoch, 0 per message | separate MLS credentials |
| History for a new member | none | configurable | none |
| Web build | yes | yes | needs the Rust MDK or marmot-ts |
| Stated limit | NIP-17: "more than 10 participants should find a more suitable messaging scheme" | grant size and rotation frequency (§11) | large groups |
| Maturity | shipped in DMs | new here; same shape as NIP-171 tickets and Concord rekey blobs | spec adopted 2026-07, audits predate the rewrite |

No merged NIP and no open PR defines encryption for NIP-29 groups, so this is new ground
either way. NIP-EE is marked unrecommended in favour of Marmot. The two closest drafts both
move the group off NIP-29 (messages become gift wraps addressed to a group or epoch key), which
gives up exactly the relay behaviour spaces are built on. This design keeps the NIP-29
envelope and encrypts inside it.

Why not gift wraps for key delivery: see D2. The grant event reuses the same primitive a gift
wrap uses (NIP-44 from a throwaway key to the recipient) without the per-member seal.

## 4. Which spaces can be encrypted

Any mode. Encryption is chosen **at creation** and is permanent for that space (§12).

| Mode | Works because | What changes |
|---|---|---|
| Platform | the platform relay gates `h`-tagged events on `app.space_members` | backend features that read content go dark (§8) |
| Decentralized A-lite | same, on the creator's relay | same |
| NIP-29-native | relay-native membership gates `h`-tagged events | nothing else; these spaces had no backend features |

A strict third-party NIP-29 relay stores kind 4290/4291 only if it accepts unknown kinds in a
group. Ours does (both the Postgres and the embedded SQLite build); the create dialog SHOULD
probe before offering encryption on a foreign relay (phase 2).

## 5. Keys

### 5.1 Hierarchy

- **Account key**: the user's Nostr key, in the signer. Used to sign sealed events and grants,
  and for exactly one NIP-44 decryption per epoch (unwrapping a grant).
- **Epoch key `K`**: 32 random bytes from the platform CSPRNG, one per space epoch. Never
  leaves the device except wrapped in a grant.
- **Derived keys** (HKDF-SHA256, salt `thewired-space-e2ee-v1`):
  - `epochId = hex(HKDF(K, info "epoch-id", 8 bytes))`
  - `contentKey = HKDF(K, info "content:" + spaceId, 32 bytes)`
  - `grantKey = HKDF(K, info "grant:" + spaceId, 32 bytes)`

Both derived keys are used as NIP-44 v2 *conversation keys* (the 32-byte value NIP-44 normally
gets from ECDH). NIP-44 then derives per-message keys from a fresh 32-byte nonce, pads, encrypts
with ChaCha20 and authenticates with HMAC-SHA256. Nothing new is invented below that line, and
every Nostr library already ships it.

### 5.2 Distribution

A **manager** (§5.4) publishes a key grant (kind 4291, §6.2) to the space's relays. For each
recipient it carries `hex(K)` encrypted with NIP-44 from a throwaway keypair made for that one
event. The manager needs one signature; the per-member encryption is local.

A member's client subscribes to grants for its spaces, finds its own `p` entry, asks the signer
for one `nip44_decrypt(eph, entry)`, checks the result (§6.2) and stores the key.

- **Creating a space**: the creator makes epoch 0 and publishes a grant to themselves. If the
  creation fails or is cancelled, the prepared key and the space's encrypted marker are
  removed again.
- **A grant counts once the relay stored it.** A manager's client waits for the space's host
  relay to accept each grant (NIP-01 `OK`). Who holds a key is then read back from the relay
  at each reconcile (every valid grant for the epoch it serves), not from a local note: a
  grant the relay refused handed nobody a key and is published again.
- **Members fetch the grants that name them, to the end.** A relay answers one REQ with at
  most its `max_limit` events (500 on ours), so the grants addressed to the account
  (`#p`) are paged with `until` until the relay has no more.
- **Someone joins**: a manager's client sees a roster member without the current key and
  publishes a grant for them (a *late grant*: same epoch, new throwaway key). Until then the
  member sees "Waiting for an admin to share the key".
- **Which roster**: a manager's client MUST decide from the authority's roster *as of that
  moment* (the backend's member list, or the host relay's newest 39002 signed by the pinned
  relay key), never from a cached copy. A stale cache would rotate out members who joined
  since. If the roster cannot be fetched, nothing is granted or rotated.
- **When**: on a fresh roster change, after a removal by this client, and a few seconds after
  a manager opens the space (that is what serves a member who joined while no manager was
  online).
- **History policy `full`**: the late grant is followed by one grant per older epoch.

### 5.3 Rotation

A manager's client starts a new epoch when a holder of the current key is no longer on the
roster (kick, ban, or leave): fresh `K`, `seq + 1`, `prev = <old epochId>`, one grant (or
several of ≤ 80 recipients) to everyone still on the roster. The moderation action that removes
a member triggers it directly; a roster change observed later (a voluntary leave) triggers it
too.

- Senders MUST seal with the newest epoch they hold: highest `seq`, ties broken by the
  smaller `epochId` (D13).
- **A rotation takes effect once its grants are stored.** The new key goes to the keychain
  first, then the grants are published; only when the host relay has accepted all of them does
  the manager's client start sealing with it. Until then it keeps sealing under the previous
  epoch, which everyone still in the space holds (the removed member is already refused by the
  relay), and retries the same rotation with backoff and on the next roster change.
- Receivers MUST accept any epoch they hold a key for. Messages sealed under the old epoch
  during the hand-over still decrypt for everyone who was a member then.
- Two managers rotating at once produce two epochs with the same `seq`. Every member holds
  both; the tie-break picks one for sending; the next rotation cites the winner. Both exclude
  the removed member.
- The removed member keeps the old keys. They are cut off from new messages twice: the relay
  no longer serves them the space's events, and they have no key for the new epoch.

### 5.4 Who may issue keys

The server's role list is not trusted for this. Every grant payload carries:

- `root`: the space's **key root**, the pubkey that made the first epoch. It is the same in
  every epoch of a space and may always issue keys.
- `managers`: who may issue the *next* epoch, and late grants of this one. Always includes
  `root`. A manager list MUST be carried forward from the chain or changed by a deliberate
  user action, never copied from the backend's or relay's role list. (The slice only ever
  names the root.)
- `seq`, `prev`: the epoch's place in the chain. The first epoch has `seq` 0 and no `prev`.

A client accepts a grant's epoch when:

1. **First key for this space** (trust on first use, D12): the signer is the space's creator
   when the client knows the creator, or one of its listed admins when it does not (an
   imported group); **and** the payload names the signer itself as `root`. The client pins it.
   No one can pin a root other than themselves, and a payload that merely lists the signer as
   a manager is not enough.
2. **Otherwise** the payload names the pinned root, and
   - the signer is the root; or
   - the epoch **extends the chain the client holds**: `prev` is an accepted epoch, `seq` is
     exactly one more, and the signer is a manager *of that predecessor*; or
   - the epoch **fills in history**: an accepted epoch names it as `prev` with a `seq` one
     more, and the signer manages some accepted epoch.

Consequences:

- **Once a device holds a key**, a relay or backend that edits the role list cannot make it
  accept a key of its choosing; it would need the root's or a manager's account key.
- **Before that, it can** (D12). The creator and admin lists come from the relay or the
  backend. One that names the wrong creator, or any listed admin of a group whose creator is
  unknown, can hand a device that has no key for the space yet a first key it controls, and
  that device then rejects the real ones. The pinned root is shown in the space's info panel
  with its full key, so members can compare it; the invite-link option in D12 closes this.
- Nobody but the root can jump ahead of the chain, start a second chain or re-root the space.
- A manager dropped at a rotation can issue nothing after it. They can still fork *from the
  last epoch they managed*, one step, which every member would hold alongside the real one;
  the root's next rotation outranks it and they cannot follow.
- Grants reach a device in no particular order (a relay answers newest first). A grant that
  does not link to anything yet is **kept and judged again** when another epoch is accepted,
  not rejected.
- Before asking the account signer to decrypt a grant entry, a client checks from the public
  header alone that the signer could issue keys at all, so grant spam costs no signer calls.
- A grant for an epoch the client already holds is only used for its recipient list, and only
  if its payload opens under the held key.

### 5.5 Multi-device and remote signers

- **Another device, or a reinstall**: fetch the space's grants and decrypt your entries.
  Nothing has to be copied between devices and nobody has to be online.
- **Remote signer (NIP-46)**: one `nip44_decrypt` per epoch per device (the permission is
  already requested for DMs), one `sign_event` per message sent, and none for reading. A manager
  on a remote signer rotates with a single `sign_event`. The client MUST request
  `sign_event:4290` and `sign_event:4291`.
- **Storage**: epoch keys are cached through `secretStore` (OS keychain on desktop; session
  memory on web unless the user opted in to persistence). Slot `space.e2ee.<account>.<spaceId>`,
  index `space.e2ee.index.<account>`. Nothing secret enters Redux or IndexedDB; Redux holds
  only which spaces are encrypted, epoch ids and counts.

### 5.6 What a new member can read

Exactly the epochs they were granted:

| Policy | Granted on join | Reads |
|---|---|---|
| `epoch` (default) | the current epoch | every message since the last key change, nothing before it |
| `full` | every epoch the granting manager holds | all history |

The relay serves a member all of the space's sealed events either way; the ones from epochs
they do not hold stay undecryptable and the client shows a single "earlier messages are from
before you joined" marker instead of them.

### 5.7 Key loss

- **Lost device cache**: nothing is lost (§5.5).
- **Lost account key**: lost like everything else tied to it.
- **A member's grant was never published or was deleted**: any manager's client re-grants on
  the next roster check, or the member uses "Ask for the key" (phase 2; sends a signed
  in-space request so a manager's client can respond without a full roster pass).
- **All managers gone**: the space keeps working on its last epoch but cannot rotate or admit
  new readers. Ownership hand-over must hand `root` over too (phase 2: a `root` transfer is a
  grant signed by the old root naming the new one).

## 6. Wire format

Constants live in `packages/shared-types/src/spaceE2ee.ts`; the codec is
`packages/core/src/crypto/spaceKeys.ts`; fixtures in `packages/shared-types/fixtures/`.

### 6.1 Sealed space event: kind 4290

```jsonc
{
  "kind": 4290,
  "pubkey": "<sender>",                       // the member's own key; the relay gates on it
  "created_at": 1763000000,
  "tags": [
    ["h", "<spaceId>"],                       // exactly one
    ["epoch", "<16 hex epochId>"]             // exactly one
  ],
  "content": "<NIP-44 v2 payload, base64>",   // nip44(contentKey, JSON(rumor))
  "id": "…", "sig": "…"
}
```

`rumor` is an unsigned Nostr event, the same thing a NIP-59 seal or a Marmot application
message carries:

```jsonc
{ "id": "<sha256 of the NIP-01 serialization>", "pubkey": "<sender>", "created_at": 1763000000,
  "kind": 9, "tags": [["h", "<spaceId>"], ["channel", "<channelId>"], …], "content": "hello" }
```

Serialized rumor JSON MUST be ≤ 65535 bytes.

**Sender** MUST: use the newest epoch held; put its own pubkey in the rumor; include
`["h", spaceId]` in the rumor; add no other tags to the outer event (in particular no `p`: on
our relay a `p` tag grants that pubkey read access to the event). NIP-40 `expiration` on the
outer event is allowed.

**Receiver** MUST, failing closed at each step:

1. Verify the outer signature (the normal pipeline does).
2. Require exactly one `h` and one well-formed `epoch` tag.
3. Look up the key for `(h, epoch)`. If it is not held, park the event (bounded) and retry
   when a grant arrives; never render it as text.
4. Decrypt with `contentKey`. A MAC failure drops the event.
5. Parse the rumor; require `rumor.pubkey === event.pubkey`, an `h` tag equal to the outer
   one, and an accepted kind. If the rumor carries an `id`, recompute it and require a match.
6. Drop a rumor id already seen in that space (a replay under a new outer event).
7. Never log plaintext.

**Accepted rumor kinds, v1:** `9` (chat message, including the existing `channel`, `q`, `p`,
`imeta` and `emoji` tags). Unknown kinds are dropped silently. Later phases add 7 (reaction),
kind-9 edits, 1068/1018 (polls).

**References.** Inside a rumor, an `e`/`q` tag that points at another message uses that
message's **outer event id**. The outer id is what the relay can delete and what the client
stores the message under.

**Deletion stays in the clear.** "Delete for everyone" is the existing kind 5 with the outer
event id and the `h` tag; moderator deletion is the existing kind 9005. The relay really
removes the ciphertext row, which an encrypted tombstone could not do.

**Until it knows which spaces are encrypted, a client MUST NOT publish plaintext content kinds
into any space.** This client loads that record before anything else and refuses, with an
explanation, while it can't (§16); the relay-enforced flag (D8) would make this unnecessary.

**In an encrypted space a client MUST NOT publish plaintext content kinds** (9, 7, 1, 1068, …)
with that space's `h` tag, and MUST ignore plaintext kind 9 it receives there. Allowed in the
clear: 5, 9000–9022, 4290, 4291, 1984, 30078 layout overlays.

### 6.2 Space key grant: kind 4291

```jsonc
{
  "kind": 4291,
  "pubkey": "<manager>",
  "created_at": 1763000000,
  "tags": [
    ["h", "<spaceId>"],
    ["epoch", "<16 hex epochId>"],
    ["eph", "<throwaway pubkey, 64 hex>"],
    ["p", "<member pubkey>", "<nip44(throwaway secret → member, hex(K)), base64>"]
    // … up to 80 p entries; more recipients = more grant events for the same epoch
  ],
  "content": "<nip44(grantKey, JSON(payload)), base64>"
}
```

```jsonc
// payload
{ "v": 1, "space": "<spaceId>", "epoch": "<epochId>", "seq": 3, "prev": "<epochId>" | null,
  "root": "<pubkey>", "managers": ["<pubkey>", …], "history": "epoch" | "full", "at": 1763000000 }
```

**Receiver** MUST, failing closed:

1. Verify the signature; require one `h`, one `epoch`, one `eph`.
2. From the header alone, check that the signer could issue keys (§5.4). If not, keep the
   grant for a later retry and stop; do not ask the signer to decrypt.
3. Find its own `p` entry; `K = hex-decode(nip44_decrypt(eph, entry))`; require 32 bytes.
4. Require `epochId(K) === epoch tag`.
5. Decrypt `content` with `grantKey(K, h)`; require `v === 1`, `space === h`,
   `epoch === epoch tag`, `seq` a non-negative integer, `seq === 0` exactly when `prev` is
   null, `root` a pubkey, `managers` an array of pubkeys that includes `root`.
6. Apply the chain rule of §5.4: accept, keep for later, or reject.
7. Store the key and the non-secret epoch record; release parked events for that epoch;
   judge the kept grants again.

A grant is not replaceable and has no expiration: a member's next device must still find it.
Everyone can read the `p` list of a grant, which is how clients show who holds the key.

### 6.3 Versioning

`SPACE_E2EE_VERSION = 1` covers the kinds, tags, the HKDF salt and the payload `v`. A
breaking change bumps the salt suffix and the payload `v` together. Clients drop grants with an
unknown `v`.

## 7. What the relay still sees and enforces

Unchanged, because a sealed event is an ordinary `h`-tagged event from a member:

| | |
|---|---|
| Membership gating on publish | `membership_gate` rejects a non-member's 4290/4291 with `auth-required: not a member of this group` |
| Membership gating on read | stored queries, live broadcast and search only serve `h`-tagged events to members (and the author) |
| Rate limits, size limits | unchanged (content ≤ 102400 bytes, frame ≤ 131072 bytes) |
| Deletion | kind 5 by the author and kind 9005 by a moderator remove the stored ciphertext; deleted events stay refused |
| Operator moderation | suspension, tombstones and shadowing act on pubkeys and event ids, not content |
| Membership and roles | 9000/9001/9021/9022 and the backend's roster are untouched |
| NIP-40 | honoured on the outer event |

The relay needs **no code change** for the slice; `services/relay/tests/sealed_space_events.rs`
pins the behaviour above for both kinds and asserts the stored row is byte-identical to the
ciphertext published.

A `p` entry in a grant gives that pubkey read access to the grant event itself, member or not.
That is intended: a removed member can still fetch the old grants they already used, and a
grant can be made for someone before they join.

## 8. What is lost, and the mitigation

| Lost | Why | Mitigation |
|---|---|---|
| **Relay search** (NIP-50) and **backend search** (Meilisearch) | no plaintext server-side; the backend does not subscribe to 4290 | Phase 3: local search over decrypted messages already on the device. Server search stays off by design. |
| **Backend ingestion**: trending, analytics, discovery scores, activity counts | same | Phase 2: message *counts* from envelope metadata if wanted (D9); content-derived features stay off. The directory shows an "encrypted" badge instead of previews. |
| **Push content and mention pushes** | the backend cannot see mentions (D5) | v1: no push. Phase 3: opt-in content-free "new activity" push from envelope metadata. In-app unread badges still work (the client decrypts). |
| **Server-side moderation** (operator reading reported content, spam filters on text) | no plaintext | Admins are members and read everything: 9005 delete, kick, ban and mute all still work. Operator suspension by pubkey still works. Rate limits still apply. |
| **Reports to the operator** (kind 1984) | the operator cannot read the reported event | §8.4. Until then a report carries only ids, and the client offers "report to the space's admins". |
| **Link previews, media gating by the backend, transcoding** | rumor URLs are hidden; attachments would upload in the clear | v1: attachments are disabled in encrypted spaces. Phase 2: encrypted blobs with the DM file scheme (AES-256-GCM per file, key in the rumor's `imeta`). |
| **The AI assistant** | its context goes to whichever model is configured, which can be a cloud provider | Messages of an encrypted space are never part of an AI context: the auto-run read tools skip them, and "Ask AI" builds no context from such a space, channel, message or thread. A consent step like the one for DMs could open this later. |
| **Polls, reactions, edits, notes/media/music channels** | each needs a sealed form | v1: chat only; the other channel types and actions are disabled in encrypted spaces. Phased in (§13). |
| **Interop with other NIP-29 clients** | they do not know 4290 | They see an empty group. The 39000 metadata gets an `encrypted` marker in phase 2 so they can say why. |

### 8.4 Verifiable reports (phase 3, needs review)

NIP-44 derives the three per-message keys with `HKDF-Expand(conversationKey, nonce, 76)`.
Those 76 bytes decrypt and authenticate one message and reveal nothing about the conversation
key. A report MAY carry them for the reported event. The operator fetches the event (signed by
its author), checks the MAC with the disclosed HMAC key and decrypts that single message. The
reporter cannot substitute a different plaintext without breaking the MAC or finding a second
ChaCha20 key that yields readable text. This must be reviewed before it is relied on (the
three keys are not bound to each other for the verifier).

## 9. Voice and video

Voice/video channels already encrypt every frame with per-sender keys sent pairwise to the
people in the room (`E2EE_CALLS.md`). That is independent of the space key and stronger (fresh
keys per session, rotated on every leave), so it stays as it is in an encrypted space.

Two links between them:

- Phase 2: in an encrypted space, send a media key only to participants who hold the current
  epoch key. Today the participant list comes from the backend's token, so a backend that lists
  a ghost participant would be refused keys here too.
- Voice-channel text and anything else that is chat goes through sealed events like every
  other channel.

NIP-29-native spaces have no voice yet; nothing changes there.

## 10. Client UX

- **Creating**: a single "End-to-end encrypted" switch in the create dialog (shown only with
  the feature on), with a short list of what is turned off, and the history choice (D4).
- **Indicators**: a lock next to the channel name; a banner over the composer when the key is
  missing ("Waiting for an admin to share the key") or the feature is off on this device
  ("Turn on Encrypted spaces to read this"). Phase 2: a lock in the space list, per-message
  "sealed" detail, and the key-holder list in the member panel.
- **Feature off**: on a device that knows the space is encrypted (it created it, or saw a key
  grant while the feature was on), the chat shows the banner, the composer is disabled and
  the client refuses to send plaintext there. A device that has never had the feature on does
  not know, and behaves as in an ordinary space (D11).
- **Membership changes**: "*Alice* shared the key with *Bob*" and "the key was changed" rows
  from grant events (phase 2).
- **Key loss**: automatic re-derivation from grants; "Ask for the key" when none exists
  (phase 2).
- **Managers**: hand-over and rotation are automatic while a manager's client is open; a
  pending count ("2 members are waiting for the key") shows when one is needed (phase 2).

## 11. Scaling limits

| | Limit | Why |
|---|---|---|
| Message size | 65535 bytes of rumor JSON | conservative NIP-44 bound every library accepts |
| Grant | ≤ 80 recipients per event (~21 kB) | relay frame limit 128 kB with wide margin |
| Rotation cost | `ceil(members / 80)` events, 1 signature each, no signer encryptions | throwaway-key wrapping is local |
| Join cost | 1 small grant event per joiner (per epoch under `full`) | needs a manager's client online |
| Practical size | hundreds of members | every leave rotates; a space with constant churn rotates constantly, and each rotation leaves the removed member able to read the hand-over window on a colluding relay. Past that, MLS is the right tool. |
| Reading history | all sealed events of the space are fetched, the channel is only known after decryption | per-channel paging returns later with an optional blinded channel tag (phase 3) |
| Key hand-over latency | a joiner waits for a manager's client to be online | the invite could carry the current epoch key in its link fragment (phase 2), so joiners read at once |

## 12. Migration and compatibility

- **Unencrypted spaces are untouched.** Nothing changes for a space without the marker,
  whether the feature is on or off. Regression tests pin this.
- **No in-place conversion in v1.** Encrypting an existing space would leave its plaintext
  history on the relay and needs every member on a build that understands 4290. Phase 3 can add
  "encrypt from now on" (marker + first epoch + relay flag); the reverse is never offered.
- **Older builds, other clients, and this client with the feature off** see no messages in an
  encrypted space (they do not subscribe to 4290) and, before the relay flag exists, can post
  plaintext kind 9 there. So can a device with the feature on until the first grant reaches it
  (a new device, a reinstall). Clients that know the space is encrypted ignore that plaintext;
  D8 closes the gap server-side and D11 tracks it.
- **Small encrypted DM rooms** (NIP-17, ≤ 10 people) are unaffected and remain the right tool
  for ad-hoc private groups without a space.
- **Marmot**: if adopted later, a space would switch its *key layer* (epoch keys from the MLS
  exporter instead of grants); rumors, references and the client pipeline stay as they are.

## 13. Phases

| Phase | Contents |
|---|---|
| **1 (this slice)** | Feature flag; create an encrypted space (any mode); epoch keys in the keychain; grants and late grants; rotation on removal and on leave; sealed chat send/receive/edit in chat channels, replies and mentions inside the ciphertext; relay-side deletion; plaintext guard; lock indicator and banners; contract types; tests. Known gaps are listed in §16. |
| **2: complete chat + server awareness** | Reactions, edits, replies UI polish, polls; encrypted attachments; `encrypted` flag on the relay (refuse plaintext kinds) and backend (badge, skip ingestion); marker in 39000 and in invites; background unread for encrypted spaces; key-holder list and hand-over rows; "Ask for the key"; root hand-over; media keys only to key holders; history paging. |
| **3: the rest of a space** | Notes/media/articles/music channels as sealed rumors; local search; content-free push; verifiable reports; "encrypt from now on" for existing spaces; blinded channel tags. |
| **4: MLS evaluation** | Re-check Marmot's audit status and multi-device story; if adopted, swap the key layer. |

## 14. Test plan

| Layer | Tests |
|---|---|
| Codec (`packages/core`) | round trip; tampered ciphertext, tags and epoch; wrong key; cross-space key; sender mismatch; replayed rumor; oversize; grant round trip for 1 and 81 recipients; non-recipient cannot unwrap; wrong epoch id; payload/space mismatch; pinned vectors for the HKDF derivations |
| Contract (`packages/shared-types`) | fixture file with keys, a sealed event and a grant; a test in core decrypts the fixtures so another implementation can check itself against them |
| Key state (client) | accept rules (first use, chain, unauthorized signer); epoch choice and tie-break; keychain round trip; nothing secret in Redux |
| Rotation (client) | roster diff → late grant vs rotate; removed member's key fails on post-rotation messages; new member reads exactly what the policy grants |
| Pipeline (client) | sealed event → chat index under the channel; parked until the grant arrives; plaintext kind 9 ignored in an encrypted space |
| Regression (client) | feature off: 4290/4291 never requested, never indexed, never sent; unencrypted spaces send kind 9 unchanged with the feature on and off; DM gift-wrap path untouched |
| Relay | member/non-member publish and read for both kinds; stored content equals the published ciphertext; kind 5 and 9005 delete it; embedded SQLite build behaves the same |
| Live QA | see the PR description |

## 15. Where the slice lives

| Piece | File |
|---|---|
| Contract constants and types | `packages/shared-types/src/spaceE2ee.ts` |
| Codec (derivations, seal/open, grant build/open) | `packages/core/src/crypto/spaceKeys.ts` |
| Key store (keychain) | `client/src/features/spaces/e2ee/spaceKeyStore.ts` |
| Key state, accept rules, epoch choice | `client/src/features/spaces/e2ee/spaceKeyring.ts` |
| Roster reconcile (late grant / rotate) | `client/src/features/spaces/e2ee/keyReconcile.ts` |
| Roster the reconcile acts on | `client/src/features/spaces/e2ee/freshRoster.ts` |
| Key holders as the relay serves them | `client/src/features/spaces/e2ee/freshHolders.ts` (paged with `pagedReq.ts`) |
| Which spaces are encrypted (loaded before any key) | `client/src/features/spaces/e2ee/e2eeRecord.ts` |
| Send and receive | `client/src/features/spaces/e2ee/sealedChat.ts` |
| Subscriptions and lifecycle | `client/src/features/spaces/e2ee/e2eeController.ts` (mounted by `useSpaceE2ee` in `App.tsx`) |
| Pipeline seam | `client/src/lib/nostr/spaceE2eeHooks.ts` |
| Non-secret Redux state | `client/src/store/slices/spaceE2eeSlice.ts` |
| Plaintext guard | `client/src/lib/nostr/publish.ts` |
| Pipeline branch | `client/src/lib/nostr/pipeline/ingest.ts` |

D2 (transport) is confined to the grant functions in `spaceKeys.ts` and the grant subscription;
D3 to two constants; D4 to `epochsToGrant` in `keyReconcile.ts`; D5 to `sealSpaceEvent`.

## 16. Known gaps in the slice

Found while building, in live QA and in an independent review; none is hidden by the feature
being off by default.

- **A device can post plaintext into an encrypted space until it learns the space is
  encrypted** (D11): with the feature off, or on a new device before the first grant arrives.
  The relay-enforced flag (D8) is the fix.
- **Only the key root issues keys.** If the creator is away, nobody is granted and nothing
  rotates. Appointing managers and handing the root over are phase 2. With several managers a
  dropped one can still fork one step from the last epoch they managed (§5.4).
- **An admin can mark a space encrypted on other members' devices** by publishing a grant
  there, which blocks plaintext chat on those devices; there is no "unmark" in the UI.
- **The first key is trust on first use** (D12): a lying relay or backend can hand a device
  its first key. The pinned root is shown so a wrong one can be noticed.
- **Posting to any space is refused while the account's record of encrypted spaces cannot be
  read — by design** (owner decision). The record is one IndexedDB read at startup and after
  an account switch; until it has loaded, the composer is disabled and nothing space-scoped
  is signed in the clear, because nobody can say the space is *not* encrypted. Each attempt
  waits at most a few seconds: if local storage doesn't answer (an IndexedDB open blocked by
  another tab of the app, for example), the post is refused at once with "local storage isn't
  answering… close other tabs or windows of The Wired, or reload", and the composer shows the
  same explanation. The next attempt (and a background retry) reads again, and a read that
  answers late still loads the record, so posting recovers by itself. The kinds that stay in
  the clear (deletions, NIP-29 management, join and leave, reports, layout, voice presence)
  are not held back. This client-side strictness can go once the relay-enforced flag (D8)
  refuses plaintext in encrypted spaces.

- **History is one REQ of 500 sealed events per space**, newest first, with no paging.
- **Reactions**: the reaction button still shows in an encrypted space, and reacting is
  refused by the plaintext guard (kind 7 is not sealed yet). Polls, attachments and non-chat
  channels are hidden or refused the same way.
- **Feature switched off mid-session**: messages already decrypted stay on screen until a
  reload; nothing new is fetched, decrypted or sent.
- **Keys are not wiped when you leave or are removed.** The device keeps the epochs it had
  (it could read those messages anyway). A wipe on leave belongs with phase 2.
- **The reconcile treats the backend's member list as the whole roster.** That is true today
  (the endpoint returns every member). When that endpoint gains paging, the reconcile MUST
  walk every page first, or it would rotate out the members beyond the first one.
- **Two managers online at once** both hand a joiner the key (harmless duplicates) and can
  both rotate on a removal (two epochs with the same `seq`, resolved by the tie-break, D13).
- **Live delivery right after creating or joining a group**: the relay refreshes a
  connection's membership at most every 30 s, so events from others in that window are not
  pushed live (true for plaintext chat as well). They load on the next history fetch.
- **Cold start**: these subscriptions open before NIP-42 AUTH completes, so the first answer
  is empty; the controller asks again with backoff (five tries, ~45 s in all). A signer that
  takes longer than that to approve AUTH leaves the space empty until it is reopened.
- **Web without persistence** re-derives every epoch from its grant at each reload: one
  signer decryption per epoch held. Fine for an extension, slow on a remote signer with many
  epochs.
