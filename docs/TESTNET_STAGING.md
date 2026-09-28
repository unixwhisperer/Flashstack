# Testnet Staging Procedure

**Owner:** Security & Contract Lead
**Status:** Procedure defined; **not yet executed for any contract.**
**Evidence date:** 2026-09-17 (repo facts re-read, and testnet chain state
verified read-only via the public Hiro API, on this date)
**Bead:** `Flashstack-ajv.6.1`

---

## 1. Why this exists

FlashStack has never staged a deployment on testnet. The live contracts went
**simnet → mainnet**, with the Clarinet simnet suite as the only pre-deployment
gate.

The simnet suite is good and catches logic bugs, but it cannot catch what actually
goes wrong at publish time: real trait resolution across principals, a real token
contract rather than a local mock, post-conditions, fee and nonce handling, epoch
and clarity-version acceptance, and address-substitution mistakes.

The mainnet history is a record of exactly that class of failure. From
`docs/security/CONTRACT_INVENTORY.md` §3 — `flashstack-stx-core` aborted 3 times,
`flashstack-sbtc-core` twice, `usda-vault-rescue-receiver` five times, plus assorted
`dbg*` and `stx-core-test*` probes. Aborted publishes never take effect, but they
**consume the contract name permanently at that principal**, which is why the live
system carries `-v2`/`-v3`/`-v4`/`-v5` suffixes. That is the cost of debugging on
mainnet.

**Scope: forward-looking only.** The live contracts are immutable and nothing here
changes them. This applies to the undeployed successors — `flashstack-stx-core-v2`,
`flashstack-sbtc-core-v2`, `flashstack-stx-pool-v3`, `flashstack-sbtc-pool-v3` — and
to `flashstack-pool-v3`, the audit target.

---

## 2. The gate

No contract reaches mainnet except through every step, in order:

| # | Step | Gate | Who |
|---|---|---|---|
| 1 | `clarinet check` clean | 0 errors | CI |
| 2 | Full suite green | all tests pass | CI |
| 3 | Security & Contract Lead review | CODEOWNERS approval | Lead |
| 4 | **Testnet deploy from a plan checked into `deployments/`** | all publishes confirmed, no aborts | Operator |
| 5 | **Testnet verification** — exercise the real paths | every assertion in §5 passes | Operator |
| 6 | Post-testnet security review of the recorded evidence | Lead sign-off | Lead |
| 7 | Mainnet deploy from a reviewed plan | txids recorded | Operator |
| 8 | Repo's localized copy updated in the **same** change | `canonical-copy-drift` + `mainnet-fidelity` green | Lead |

Step 8 is not bureaucracy. Skipping it is precisely what produced finding **F-7**:
`contracts/test/flashstack-stx-core.clar` drifted from the deployed contract and the
"deployed core" suite spent weeks asserting the behavior of a contract that does not
exist on mainnet.

---

## 3. Operator setup (one-time)

The operator holds the testnet key. **The Security & Contract Lead does not need it,
must not be given it, and must never be sent a mnemonic, seed phrase or private
key.** Testnet STX is valueless faucet currency, but the habit matters: the same
procedure with `TESTNET_` swapped for `MAINNET_` moves real funds.

1. **Create a fresh wallet.** Use a wallet that can produce a 24-word Stacks
   mnemonic — the Leather browser extension, or Xverse. Create a **new** wallet used
   only for testnet staging. Never reuse a wallet that has ever held mainnet funds.
2. **Switch the wallet to testnet.** Leather: Settings → Change network → Testnet.
   The address changes prefix from `SP…` to `ST…`.
3. **Fund it.** <https://explorer.hiro.so/sandbox/faucet?chain=testnet> — 1000 STX
   per request. Run it **3–4 times**: publishing this many contracts plus funding a
   reserve costs more than a single grant covers.
4. **Confirm the balance** before deploying:
   ```bash
   curl -s https://api.testnet.hiro.so/extended/v1/address/<ST-ADDRESS>/balances \
     | python3 -m json.tool
   ```
5. **Never commit the mnemonic.** Pass it per-invocation, from the shell, and let it
   leave no trace in history:
   ```bash
   read -rs TESTNET_MNEMONIC && export TESTNET_MNEMONIC   # leading space, not echoed
   ```
   `settings/Testnet.toml` is gitignored; `settings/Testnet.toml.example` is the
   committed template. Keep it that way.

---

## 4. What exists today, and what does not

### Exists

`scripts/deploy-testnet.mjs` (393 lines) is real and works. It derives the key from
`TESTNET_MNEMONIC`, rewrites mainnet principals to the testnet deployer, publishes in
dependency order waiting for each confirmation, then whitelists a receiver, funds the
reserve, seeds the receiver and executes a live flash loan — producing testnet txids
as evidence. It is a sound template.

### Does not exist

**It targets the previous generation.** Its deploy list is
`stx-flash-receiver-trait`, `flashstack-stx-core`, `flashstack-stx-pool`,
`flashstack-pool-oracle`, `stx-test-receiver` — none of the contracts this gate is
meant to protect.

Nothing in `scripts/` or `deployments/` targets `flashstack-pool-v3` or any v3/v2
successor. Both committed testnet plans are gen-1: `deployments/testnet-plan.yaml`
names `ST2X1GBHA2WJXREWP231EEQXZ1GDYZEEXYRAD1PA8`, which has **zero transactions** on
testnet, and `deployments/default.testnet-plan.yaml` names the well-known Clarinet
default deployer, whose two testnet contracts belong to unrelated third parties. Both
reference `snp-flashstack-receiver`, whose source was not in this repo when this was written (**D7**, closed 2026-09-21: now committed verbatim).

---

## 5. Three things that had to be solved before the current generation could be staged

> **All three are now resolved (2026-09-17).** Kept in full rather than deleted: each
> records a real constraint an auditor or future maintainer will otherwise re-derive.

These are **open technical questions**, recorded rather than guessed. Each is a real
blocker found by reading the contracts, not a hypothetical.

### 5.1 The address patcher is incomplete

`deploy-testnet.mjs` rewrites exactly two principals:

```js
const MAINNET_ADDRS = [
  "SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ",
  "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
];
```

The current generation references **three more** that it would silently leave
unpatched — so the publish would abort on testnet with an unresolved contract:

| Principal | Referenced by | Nature |
|---|---|---|
| `SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard` | `flashstack-pool-v3`, `flashstack-v3-receiver-trait` | The SIP-010 standard trait. Exists on testnet at a **different** principal — must be remapped, not rewritten to the deployer. |
| `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-v3-receiver-trait` | `flashstack-pool-v3` | Our own trait. Rewrites to the deployer correctly, but only if the address is added to the list. |
| `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | `flashstack-sbtc-core-v2`, `flashstack-sbtc-pool-v3` | Canonical sBTC — see 5.2. |

**Decision needed:** the patcher must distinguish *rewrite-to-deployer* (our own
contracts) from *remap-to-testnet-equivalent* (a third-party dependency).

**Narrowed 2026-09-17.** Testnet has been regenesised — burn height is only 17,656 —
so **no third-party mainnet infrastructure can be assumed present**. Probing the
usual addresses for a canonical `sip-010-trait-ft-standard` on testnet returned 404 /
invalid-address. That is not a problem: the repo already carries its own copy at
`contracts/test/sip-010-trait-ft-standard.clar`, so the trait should simply be
**published by us as the first contract in the plan** and rewritten to the deployer
like everything else we own.

Net effect: §5.1 collapses to adding `SP3FBR2AGK5H9…` and `SPR9PQAN…` to the patch
list and publishing our trait copy first. The only dependency with **no** testnet
substitute is canonical sBTC — which is §5.2, and is a genuinely different problem.

### 5.2 ~~The sBTC contracts cannot be staged faithfully~~ — RESOLVED 2026-09-17

The original concern was that canonical sBTC (`SM3VDXK3…sbtc-token`) is mainnet-only,
so staging `flashstack-sbtc-core-v2` / `flashstack-sbtc-pool-v3` would require a mock
— meaning the bytes staged are not the bytes shipped, which destroys the value for
exactly the integration risk being tested.

**A real sBTC deployment exists on testnet, and its source is byte-identical to
mainnet.** Verified read-only; nothing deployed:

`ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM` carries the complete sBTC contract set,
and every contract matches mainnet exactly (SHA-256 over
`/v2/contracts/source`, both chains):

| Contract | Bytes | Result |
|---|---|---|
| `sbtc-token` | 4,759 | **identical** (`sha256 8f0a0edd…`) |
| `sbtc-registry` | 11,209 | **identical** |
| `sbtc-deposit` | 4,151 | **identical** |
| `sbtc-withdrawal` | 12,264 | **identical** |
| `sbtc-bootstrap-signers` | 5,801 | **identical** |

`sbtc-token`'s only internal dependency is `.sbtc-registry`, which is present and
also identical. A live `get-decimals()` read returns `(ok u8)`, matching mainnet — so
`share-scale` calibration (pv3-F2) would be exercised against the real value.

**Consequence:** staging the sBTC line is a *faithful* stage, not a mock-backed one.
The localizer maps `SM3VDXK3…` to this principal rather than to a hand-written mock.

**One caveat to record rather than gloss.** That address is the well-known Clarinet
default deployer, whose key is public. The *code* is provably canonical; the
*deployment* is not authoritative, and anyone can exercise its protocol roles. On
testnet that is acceptable — no value is at stake and the point is integration
mechanics, not custody — but the evidence should say "staged against a byte-identical
sBTC deployment at the public Clarinet deployer address", never "staged against
canonical sBTC".

**Resolved 2026-09-18 — obtain it by plain SIP-010 `transfer`, not by minting.**
Read-only investigation; nothing deployed, no key used.

`protocol-mint` is unreachable for us, and confirming *why* matters more than the
conclusion: it asserts `sbtc-registry.is-protocol-caller` on **`contract-caller`**,
and the registry seeds only three roles — `.sbtc-deposit` (mint), `.sbtc-withdrawal`
(burn), `.sbtc-bootstrap-signers` (governance). `update-protocol-contract` itself
requires the governance role, so the set cannot be extended from outside. Going
through the front door instead, `sbtc-deposit.complete-deposit-wrapper` asserts
`tx-sender` equals the registry's current signer principal, live-read as
`SN35NB5S0NFPMSDNFHHJFK7AMZ750J58H7VTA7G6R` — not us. Confirmed directly:
`is-protocol-caller(deposit-role, ST1PQHQ…)` returns `(err u400)`.

None of that is needed, because **the balance already exists**. Live reads:

| | |
|---|---|
| `get-total-supply` | `u2100000000000000` = **21,000,000 sBTC** |
| `get-balance(ST1PQHQ…)` | `u8000000000` = **80 sBTC** |

`transfer` authorises on `(is-eq tx-sender sender)`, so whoever signs as `ST1PQHQ…`
can send sBTC to the staging deployer with an ordinary SIP-010 transfer. That key is
the public Clarinet default mnemonic, so this is available to anyone — which is the
point, and also the caveat.

**What this sharpens about §5.2's caveat.** A 21,000,000 sBTC supply — the entire
Bitcoin supply, pre-minted — is not how sBTC behaves anywhere real. This deployment
is a **test fixture** that happens to use byte-identical contract code, not a live
sBTC protocol instance. The distinction matters for what a staging run can claim:

- **Faithful**, because the code is byte-identical: trait resolution, SIP-010
  conformance, `get-decimals` = 8, transfer semantics, post-conditions, and
  therefore pool-v3's `share-scale` calibration (pv3-F2).
- **Not faithful**: deposit/withdrawal flows, signer attestation, realistic supply
  or balance distribution. A staging run must not claim to have exercised those.

Also: the 80 sBTC sits at a key anyone holds, so the balance can vanish between runs.
Treat funding as a step in the procedure, not a precondition to assume.

### 5.3 ~~`flashstack-pool-v3` needs epoch 4.0 on testnet~~ — RESOLVED 2026-09-17

**Testnet accepts Clarity 6. `flashstack-pool-v3` can be staged.** Verified by
public read-only API, no deployment:

- **Testnet is past Epoch 4.0.** `GET /v2/pox` lists `Epoch40` at `start_height
  2702`; current burn height is **17,656**. Node reports `stacks-node 4.0.1`.
- **Clarity 6 publishes actually succeed.** Across 400 recent testnet
  contract-deploy transactions: **64 at `clarity_version = 6`, all `success`, and
  zero `abort_by_response` at that version.** (Every other version has failures —
  cv3 70, cv4 41 — so this is not a quiet-period artifact.) Example:
  `ST1M193TGQK6DZ958F9YT51AD756E6GN26PHS798Q.counter`, block 395,236.
- **The specific primitives pool-v3 depends on are live**, not merely the version
  number: `as-contract?`, `current-contract` **and** `with-ft` all appear in
  successfully-deployed testnet contracts (e.g.
  `ST23DXFQJVPA735K0HWRYFS6EF8BHJ2ENSZ3NNNMC.stackspot-sponsor`). This is the part
  that mattered — §11 records that `as-contract` is a hard error from Clarity 4, so
  version acceptance alone would not have proven the replacement forms work.

No action needed. This blocker is closed.

---

## 6. Verification checklist (step 5 of the gate)

A testnet deploy that only proves "the publish confirmed" has not tested anything the
simnet suite did not already cover. Record a txid for each:

**Per contract published**
- [ ] Publish transaction is `success`, not `abort_by_response`
- [ ] Source fetched back from `/v2/contracts/source/<addr>/<name>` matches the
      submitted source modulo address localization — the same rule
      `tests/canonical-copy-drift.test.ts` enforces in-repo
- [ ] `/v2/contracts/interface/…` exposes the expected public functions, and **does
      not** expose any it shouldn't (this is what would have caught F-7)

**Per pool / core**
- [ ] `deposit` succeeds and credits the expected shares
- [ ] `withdraw` returns the expected amount and **still works while paused** (LP exit
      is never gated)
- [ ] `deposit` is **rejected** while paused (pv3-F3)
- [ ] Flash loan happy path: reserve grows by exactly the fee
- [ ] Flash loan with a non-repaying receiver: whole transaction reverts, reserve
      untouched — the solvency invariant, against a real token, on a real chain
- [ ] Unapproved receiver is rejected
- [ ] Two-step admin: `transfer-admin` does **not** change admin; `accept-admin` from
      a non-pending principal fails; the original admin retains control throughout
      (BC1)

**`flashstack-pool-v3` only**
- [ ] `add-asset` derives `share-scale` from a live `get-decimals()` (pv3-F2) — assert
      the actual value, not just success
- [ ] Same-asset reentrancy during a flash-loan callback reverts with `ERR-REENTRANT`
      u815 (pv3-F1)
- [ ] A **different**-asset flash loan inside a callback still succeeds — the lock is
      per-asset by design and must not have become global
- [ ] Oracle reads for a never-listed token return `ERR-NOT-LISTED`, not a
      plausible-looking default

**Recorded output**
- [ ] Every txid written into `deployments/` alongside the plan that produced it
- [ ] Contract addresses, block heights, and the commit SHA staged

---

## 6a. First testnet run — 2026-09-18

`scripts/deploy-testnet.mjs` run against `flashstack-stx-core-v2` + `stx-test-receiver-v2`
(#56). Deployer: `ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT`. Every item below was
independently re-verified against the live testnet API after the run, not taken from
the script's own success output.

**Proven, with evidence:**
- [x] All three publishes `success`: [`stx-flash-receiver-trait`](https://explorer.hiro.so/txid/5949a87346009951f1975a52bd59f92e32934d2371a667ca31aa77c85da769e4?chain=testnet), [`flashstack-stx-core-v2`](https://explorer.hiro.so/txid/fe11c31edcaf368f8b9e0efc3447565ce2509793e243145e4a6295c901462209?chain=testnet), [`stx-test-receiver-v2`](https://explorer.hiro.so/txid/d81602ea5785eb2983894474da28d03b9f9fd5ec0a0070ad834d958f6b5a2d90?chain=testnet)
- [x] Source fetched back from `/v2/contracts/source/…` for `flashstack-stx-core-v2`
      matches `localize(local-source, deployer)` **exactly** — byte-for-byte
      comparison, not eyeballed
- [x] Flash loan happy path: reserve went from `50,000,000` (post-fund) to
      `50,005,000` post-loan — **exactly** the 0.05% fee on a 10 STX loan (5,000
      µSTX), read back and decoded from `get-reserve-balance`, not assumed.
      [Evidence tx](https://explorer.hiro.so/txid/6edae18d820a4819178d22634351273e9d59015d2735fd312cef006992aa208d?chain=testnet)
- [x] Two-step admin happy path: [`transfer-admin`](https://explorer.hiro.so/txid/23c454f6030b86a94d450ce4e20fd62585a2d82ae87f7f5f5081a1ec0bdab9f2?chain=testnet)
      (propose to self) then [`accept-admin`](https://explorer.hiro.so/txid/b8f7fdffcdc60728d79272421537d5495ea1bd85f6b3ff335bbdc04d0951b414?chain=testnet)
      both `success`; `get-admin` decodes to `(ok ST3XQ5DM…)`, confirmed against
      the deployer, not just a non-error response
- [x] Interface check: public and read-only function sets on the deployed
      `flashstack-stx-core-v2` match the local source exactly, in both
      directions — 10 public, 8 read-only, zero unexpected on-chain functions.
      `transfer-admin` and `accept-admin` both present, confirming the BC1
      shape on chain. This is the check that would have caught F-7 had it
      existed then. (Verified independently on review, not part of the
      original run.)

**NOT proven by this run — genuinely open, not implied by the above:**
- [ ] Flash loan with a non-repaying receiver reverts
- [ ] Unapproved receiver is rejected
- [x] ~~**The actual negative case BC1 exists to prevent**~~ — proven separately,
      with a second key. See §6b.
- [ ] Recorded in `deployments/` alongside a plan file; block heights not
      captured

**Note on staleness:** this run predates `a92fb8e` (the fix landed on #56
after this evidence was recorded). It used the *old* Step 8 — propose-to-self
then accept, with no read-only assertions — not the corrected sequence that
proposes to a principal the key doesn't control and asserts `get-admin`
unchanged in between. The two-step admin happy-path evidence above still
holds (both txs did succeed and the end state is correct), but it does not
carry the assertion strength `a92fb8e` added. **A re-run against the current
script is required before this document can be treated as current BC1
evidence, not optional.** (§6b below proves the negative case with a
different, purpose-built script — it does not substitute for this re-run.)

---

## 6b. BC1 negative-path proof — 2026-09-18

`scripts/deploy-testnet-bc1-negative.mjs`, a second, purpose-built script —
not `deploy-testnet.mjs` — run against the already-deployed
`flashstack-stx-core-v2` from §6a. Two independent keys: the original
deployer `ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT` (current admin) and a
freshly generated, faucet-funded second wallet
`ST2YZPFDGFZH37GTRG2RA7WME4QWTC3KNAP1SB96D`. Every item below was
independently re-verified against the live testnet API — sender, function,
args, and result decoded from each tx directly, plus a fresh `get-admin` /
`get-pending-admin` read after the run — not taken from the script's own
console output.

**Proven, with evidence:**
- [x] `transfer-admin` (deployer proposes second key):
      [`4a9f4aad…`](https://explorer.hiro.so/txid/4a9f4aad4955898999f07427d64238c3775cc6e0abe7fcf5576b87d8f8b6b2e2?chain=testnet)
      `success`, `(ok true)`, block 409791. Confirmed `get-admin` unchanged
      (deployer) and `get-pending-admin` = `(some ST2YZPFDGFZH…)` immediately
      after.
- [x] **The negative case itself**: deployer — the *old* admin, not the
      pending one — calls `accept-admin`:
      [`9107e675…`](https://explorer.hiro.so/txid/9107e6752e467ab16fb8d09888fc2684d63fb8ed15ca827381c81f1284dbd3ef?chain=testnet),
      block 409793. `tx_status` is `abort_by_response`, `tx_result` is
      `(err u309)` — `ERR-NOT-PENDING-ADMIN`, read directly from
      `contracts/flashstack-stx-core-v2.clar:40`, not a generic failure.
      `get-admin` re-checked immediately after: still the deployer, confirming
      the rejected call had zero effect on state. This is `accept-admin` from
      a non-pending principal actually failing on-chain, not merely untried.
- [x] Legitimate acceptance: the second key — the real pending admin — calls
      `accept-admin`:
      [`aa6f8a14…`](https://explorer.hiro.so/txid/aa6f8a145503e99a4daa2cad54bfc0acc4ee18424fbcbbf5db92b13b79283775?chain=testnet),
      block 409795, `success`, `(ok true)`. `get-admin` re-checked: now the
      second key — authority genuinely moved, from the correct caller only.
- [x] State restored: second key proposes back to the deployer
      ([`79b759e3…`](https://explorer.hiro.so/txid/79b759e381a04b569bc38486e27d2b00fe7bc281d949e0072252e2711a79bfe9?chain=testnet),
      block 409796), deployer accepts
      ([`d6c8e7aa…`](https://explorer.hiro.so/txid/d6c8e7aa02df47a4f2ab6d159b30afc3ca9ad4b412d36676373fda7d17de72d1?chain=testnet),
      block 409799). Final state independently re-read post-run: `get-admin`
      decodes to the original deployer, `get-pending-admin` decodes to
      `none` — the contract is back exactly where it started, so later runs
      and this document can keep assuming the deployer is admin.
- [x] Block ordering coherent throughout (409791 → 409793 → 409795 → 409796
      → 409799), sender on each tx matches the principal the step claims made
      the call.

**Still open:** this proves the negative case for `flashstack-stx-core-v2`
only. The v3-track successors (`flashstack-stx-pool-v3`,
`flashstack-sbtc-pool-v3`, `flashstack-sbtc-core-v2`) share the same
`transfer-admin`/`accept-admin` shape but are unstaged and untested — this
result doesn't extend to them automatically.

---

## 6c. §6a re-run — PREPARED, NOT EXECUTED

> **This section contains no evidence.** It is a form. Every value in the block
> below is a placeholder, and the checkboxes are inside a fenced code block
> precisely so they cannot be read as ticked. Nothing here has happened.

§6a's BC1 rows come from the *pre-`a92fb8e`* Step 8 — propose-to-self, then
accept, with no read-only assertions — and §6a says outright that a re-run
against the current script is required, not optional. §6b proves the negative
case with a second key and explicitly does not substitute. The current Step 8
(`scripts/deploy-testnet.mjs:354-405`) proposes to `ST1PQHQ…`, a principal the
signing key does not control, and asserts `get-admin` is **unchanged** in
between — the one assertion that distinguishes a correct two-step contract from
a broken one-step one. That is what has to be run.

**The plan it runs is now written**: `deployments/testnet-current-gen-plan.yaml`
— contract set, order, fees, nonce discipline and arguments, each field
referenced back to the line of `deploy-testnet.mjs` it was read off, with empty
`evidence:` slots to fill.

### The execution decision — made: route A

Live read of the §6a deployment on 2026-09-21 (sender `ST3XQ5DM…`): `get-admin`
= the deployer, `get-pending-admin` = `none`, `get-reserve-balance` =
`u50005000`, `is-approved-receiver` = `true`, deployer nonce 12, balance
`946490000` µSTX. The deployment is intact and §6b's restore held.

So Steps 1–3 of the plan would publish contract names that **already exist** at
that address, and a name is consumed permanently there whether or not the
publish took effect (`CONTRACT_INVENTORY` §3, deployment scars). Two routes:

| | Route | Cost | What it needs first |
|---|---|---|---|
| **A** ✅ | Admin steps only, against the existing deployment | 300,000 µSTX | **Chosen.** Needed step selection, which `--steps=admin` now provides (PR #66). Note it is a run of `deploy-testnet.mjs`'s own Step 8 path — extracted, not copied — but not of the *whole* script; `Flashstack-ajv.6.3`'s acceptance criterion was amended to say so. |
| **B** ❌ | A fresh `-v3` line, full 10-step run | 53.31 STX | **Not a rename in the script.** `contracts/stx-test-receiver-v2.clar:16` calls `.flashstack-stx-core-v2` statically, so a `-v3` core needs a `-v3` receiver source too — new `.clar` files and a wider diff than this evidence gap warrants. **Parked:** staging `flashstack-stx-pool-v3` is worth more than a `-v3` rename. |

**Decided 2026-09-21: route A.** §6b already proves the property on this
deployment, so the gap is assertion strength on the positive path, not a
deployment — and B would rewrite contracts to fix a documentation problem.
`deploy-testnet.mjs --steps=admin` (PR #66) runs Step 8 and nothing else, and
refuses unless the contract exists, admin is the signing deployer and
pending-admin is `none` (`scripts/lib/testnet-preconditions.mjs`). Steps 1–7 of
the plan file below therefore stay unexecuted for this line; only the 8a/8b/8c
`evidence:` slots get filled.

### Drop-in replacement for §6a

On a successful run, this replaces §6a in full — including deleting §6a's
staleness note, which no longer applies — and §6c goes away with it.

```markdown
## 6a. Testnet run — <DATE>

`scripts/deploy-testnet.mjs` at `<COMMIT-SHA>` run against `<CONTRACT-SET>`.
Deployer: `<DEPLOYER>`. Plan: `deployments/testnet-current-gen-plan.yaml`.
Every item below was independently re-verified against the live testnet API
after the run — sender, function, args and decoded result read off each tx —
not taken from the script's own success output.

**Proven, with evidence:**
- [ ] All three publishes `success`: trait `<TXID-1>` (block `<H>`), core
      `<TXID-2>` (block `<H>`), receiver `<TXID-3>` (block `<H>`)
- [ ] Source fetched back from `/v2/contracts/source/…` for `<CORE>` matches
      `localize(local-source, deployer)` byte-for-byte — compared, not eyeballed
- [ ] Interface check: public and read-only function sets on the deployed
      `<CORE>` match the local source in both directions — `<N>` public,
      `<M>` read-only, zero unexpected on-chain functions. This is the check
      that would have caught F-7.
- [ ] Flash loan happy path: reserve `<BEFORE>` → `<AFTER>`, exactly the 0.05%
      fee (5,000 µSTX on a 10 STX loan at `fee-bp` = `u5`), decoded from
      `get-reserve-balance`, not assumed. `<TXID-7>` (block `<H>`)
- [ ] **BC1 with assertion strength** — the corrected Step 8 (`a92fb8e`),
      proposing to a principal this key does not control:
  - [ ] `transfer-admin` → `ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM`:
        `<TXID-8a>` (block `<H>`), `success`
  - [ ] `get-admin` read immediately after: **still `<DEPLOYER>`** — admin did
        not move on propose. *This is the assertion the pre-fix run could not
        make: propose-to-self leaves admin equal to the deployer either way.*
  - [ ] `get-pending-admin` = `(some ST1PQHQ…)` — the proposal landed, and
        landed on someone else
  - [ ] `transfer-admin` → self (re-propose): `<TXID-8b>` (block `<H>`);
        `get-pending-admin` = `(some <DEPLOYER>)` — the earlier proposal was
        overwritten, so a mis-addressed proposal is recoverable before anyone
        accepts it
  - [ ] `accept-admin`: `<TXID-8c>` (block `<H>`), `success`; `get-admin` =
        `<DEPLOYER>`, `get-pending-admin` = `none`
- [ ] Recorded in `deployments/testnet-current-gen-plan.yaml`: every
      `evidence:` slot filled with txid, block height and status, alongside the
      commit SHA staged

**NOT proven by this run — genuinely open, not implied by the above:**
- [ ] Flash loan with a non-repaying receiver reverts — **no non-repaying
      receiver contract exists for this core.** One has to be written and
      published before this item can be attempted at all.
- [ ] Unapproved receiver is rejected — needs no new contract, but no step in
      the plan performs it
- [x] ~~The negative case BC1 exists to prevent~~ — proven separately with a
      second key. See §6b.
```

### Verification protocol for the filled-in version

Each txid is checked against `/extended/v1/tx/0x<txid>`: `tx_status`, `sender_address`,
`contract_call.function_name`, decoded `function_args`, `tx_result.repr`, and
`block_height`. Each state claim is a fresh `/v2/contracts/call-read` **after**
the run, decoded through `scripts/lib/testnet-readonly.mjs` — not the value the
script printed during it. A row whose evidence cannot be reproduced that way
does not get ticked.

---

## 7. What is deliberately not in this document

Fees, nonce handling and batch ordering are **not** specified here. They should be
derived from `scripts/deploy-testnet.mjs`, which already handles them correctly
against a real chain, rather than invented in prose. Writing plausible-looking
operational numbers that have never been executed would be worse than leaving the gap
visible.

A deployment plan for the current generation **is** now committed, at
`deployments/testnet-current-gen-plan.yaml` — §5.1–5.3 are all resolved, so the
precondition for writing one is met. It derives every fee, nonce and ordering
decision from `scripts/deploy-testnet.mjs` with per-field line references, rather
than restating them here. It is deliberately **not** a Clarinet plan and must not
be run with `clarinet deployments apply`: Clarinet publishes source verbatim, which
would broadcast contracts still carrying mainnet principals (§5.1).

---

## 8. Next actions

| # | Action | Blocked on |
|---|---|---|
| 1 | ~~Confirm testnet epoch/clarity-version support for pool-v3 (§5.3)~~ | **DONE 2026-09-17 — testnet accepts Clarity 6** |
| 2 | ~~Decide the sBTC mock question (§5.2)~~ | **DONE 2026-09-17 — byte-identical sBTC exists on testnet; no mock needed** |
| 3 | ~~Extend the patcher (§5.1)~~ | **DONE — PR #55**, `scripts/lib/testnet-localize.mjs` |
| 4 | ~~Map `SM3VDXK3…` → `ST1PQHQ…` in the localizer and move it from `THIRD_PARTY` to a new `TESTNET_EQUIVALENT` set~~ | **DONE — PR #55**, `TESTNET_EQUIVALENT` in `scripts/lib/testnet-localize.mjs` |
| 5 | ~~Determine how the deployer obtains a testnet sBTC balance~~ | **DONE 2026-09-18 — SIP-010 `transfer` from `ST1PQHQ…`, which holds 80 sBTC. Minting is unreachable and unnecessary (§5.2)** |
| 6 | ~~Write `deployments/testnet-current-gen-plan.yaml`~~ | **DONE 2026-09-21** — written from `deploy-testnet.mjs`, `evidence:` slots empty pending a run |
| 7 | Execute the stage and record evidence | A funded testnet deployer — **operator only** |
| 8 | Re-run §6a against the corrected Step 8 (`a92fb8e`) | **Route A chosen**; `--steps=admin` in PR #66. Then a funded key — operator only |

**All three original blockers are now closed.** The entire current generation — the
STX line, `flashstack-pool-v3`, *and* the sBTC line — can be staged faithfully. What
remains is mechanical work plus one practical unknown (obtaining testnet sBTC), none
of which needs an owner decision.
