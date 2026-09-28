# Audit Scope — FlashStack `flashstack-pool-v3`

**Purpose:** a scoping packet for a prospective Clarity auditor. Every figure below was
checked against the repository or the live chain on **2026-09-21**; the checks are
named so they can be repeated. Where something is not done, it says so.

**Reviewed state:** `main` @ `9210540`. The commit to audit will be frozen at kickoff.

## What this is

FlashStack is a flash-loan protocol on Stacks. Its live contracts (STX and canonical
sBTC) are immutable and out of scope — see
[`CONTRACT_INVENTORY.md`](CONTRACT_INVENTORY.md) §2–3. `flashstack-pool-v3` is the
**undeployed** successor: one generic contract that lists any admin-approved SIP-010
token as both an LP asset and a flash-loan reserve. Nothing is at risk today; the audit
is meant to happen **before** any TVL.

## Scope

| Tier | Contract | Lines¹ | Clarity / epoch | Status |
|---|---|---|---|---|
| **1 — primary** | `contracts/flashstack-pool-v3.clar` | 483 | 6 / 4.0 | Not deployed (404 on mainnet at both FlashStack principals, and on testnet at the staging deployer) |
| **1 — primary** | `contracts/flashstack-v3-receiver-trait.clar` | 22 | 3 / 3.0 | Not deployed |
| **2a — cores** | `flashstack-stx-core-v2.clar` | 230 | 3 / 3.0 | Staged on testnet, see below |
| **2a — cores** | `flashstack-sbtc-core-v2.clar` | 224 | 3 / 3.0 | Not deployed |
| **2b — pools** | `flashstack-stx-pool-v3.clar` | 306 | 3 / 3.0 | Not deployed |
| **2b — pools** | `flashstack-sbtc-pool-v3.clar` | 336 | 3 / 3.0 | Not deployed |

¹ Physical lines (`wc -l`), comments and blank lines included. Tier 1 is **505**. Tier 2
adds **1,096**: **454** in the cores (reserve model, no LP shares) and **642** in the pools
(LP shares). Please quote Tier 1 alone and Tier 1 + 2, pricing 2a and 2b separately if you can.

**Why Tier 2 is more than extra contracts.** The two v3 pools carry Tier 1's virtual-shares
design (the first-depositor inflation defence), so the share-math surface spans both tiers. A
Tier 1 finding may or may not reproduce in the Tier 2 pools, and we would want that stated
either way. The pools are also the repository's v2 pool sources plus the two-step admin change
(each pair of files differs in 14 lines, all admin-related), so a finding there can bear on
the live v2 pools, which are immutable.

Two language versions are in scope: pool-v3 targets **Clarity 6 / epoch 4.0**. Epoch 4.0
activated on mainnet at burn height 960,230 (`GET /v2/pox`), which is when Clarity 6 became
deployable (stacks-core 4.0.0 release notes). Neither current FlashStack deployer principal
has transacted since epoch 4.0 activated, so no FlashStack contract has been deployed on
Clarity 6 yet. Tier 2 targets Clarity 3.

**Out of scope:** the deployed contracts, the receiver library, `web/`, and third-party
protocol contracts referenced by receivers.

## Where we would most want scrutiny

These are the properties the contract's own header and
[`MULTI_ASSET_CORE_DESIGN.md`](../02-technical/MULTI_ASSET_CORE_DESIGN.md) (§7, §13)
declare load-bearing:

- **The asset allow-list is load-bearing for solvency.** Clarity cannot persist a trait
  reference, so every entry point takes the token as a `<sip-010-trait>` argument. A
  malicious token that lies about `get-balance`/`transfer` must be unreachable; an
  unlisted token is meant to be rejected before any token call is made.
- **Per-asset balance invariant** across the flash-loan callback.
- **Virtual shares** (first-depositor inflation defence), with `share-scale` read live from
  each token's `get-decimals()` at listing time.
- **Per-asset reentrancy lock**, deliberately not global so legitimate cross-asset flows
  still work.
- Pause semantics (global and per-asset), two-step admin transfer, and the receiver
  whitelist (defence-in-depth during beta, not relied on for solvency).

## Evidence to date

- **Tests:** 254 passing across 23 files (`npm ci && npm test`). Pool-v3 specifically has
  29 tests in `tests/flashstack-pool-v3.test.ts` and `tests/pool-v3-hillary-review.test.ts`,
  including: an unlisted token rejected even when malicious, a non-repaying receiver
  reverting the whole transaction, an unapproved receiver rejected, the donation/inflation
  attack, a reentrant deposit blocked, per-asset decimals, and a non-pending principal
  unable to `accept-admin`. **The two Tier 2 pools are tested directly for the two-step
  admin transfer** (`tests/bc1-two-step-fix.test.ts`) **and the pause gate**
  (`tests/v3-pools-pause-gate.test.ts`, 8 tests, mutation-checked). Their broader pool logic
  is the v2 pools', which have dedicated hardening tests
  (`tests/flashstack-stx-pool-v2-hardening.test.ts`, `tests/flashstack-sbtc-pool-v2-hardening.test.ts`),
  but nothing beyond admin transfer and pause exercises that logic through the v3 files
  themselves.
- **Static check:** `clarinet check` passes with 0 errors. CI runs it and the suite on
  every PR. `main` requires one approving code-owner review and both checks, **but
  `enforce_admins` is off, so a repository admin can bypass them** (a deliberate choice for a
  two-person team).
- **Internal findings:** three Medium findings on pool-v3 (`pv3-F1` reentrant deposit
  miscounted as fee revenue, `pv3-F2` share-scale not calibrated per decimals, `pv3-F3`
  deposit not gated by pause). All fixed, each with a regression test. `pv3-F1` was found
  by an external reviewer and independently reproduced before fixing. One further finding,
  `F-8` (Low, confirmed): `deposit` not gated by pause in the Tier 2 pools — **fixed in the
  undeployed v3 pools (PR #68); still open on the live, immutable v2 pools**, see below. Full
  register: [`FINDINGS_REGISTER.md`](FINDINGS_REGISTER.md).
- **Testnet staging:** the gate is defined in [`../TESTNET_STAGING.md`](../TESTNET_STAGING.md).
  `flashstack-stx-core-v2` (Tier 2) is staged. On it, the **negative case is proven on chain
  with a second key** (`accept-admin` from a non-pending principal rejected with
  `ERR-NOT-PENDING-ADMIN`, §6b, verified against the live testnet API). The **happy-path
  transactions also succeeded and the end state is correct (§6a), but §6a's run predates the
  intermediate state assertions** that were added afterwards, and a re-run with them is pending
  (§6c). Treat §6a as superseded on that point.

## What is not done — please read

- **No professional audit has been performed on any FlashStack contract.**
- **Pool-v3 has not been staged on testnet.** That is a planned gate step, not a done one.
- **The canonical file is not what `clarinet check` compiles.** Clarinet keys contracts by
  name, so it compiles `contracts/test/flashstack-pool-v3.clar`, a localized copy. For
  pool-v3 the two differ only in a 4-line header comment and two `use-trait` lines (local
  mirrors instead of mainnet principals). `tests/canonical-copy-drift.test.ts` fails CI if
  any of the 14 canonical/copy pairs drift, but that is a weaker guarantee than compiling
  the canonical source. Tracked as D6 in [`CONTRACT_INVENTORY.md`](CONTRACT_INVENTORY.md) §5.
  **Please audit `contracts/flashstack-pool-v3.clar`, not the copy.**
- **The live v2 pools do not gate `deposit` on the pause flag (`F-8`, still open).**
  `flash-loan` does; `deposit` checks only `amount > 0`. Same defect as `F-6` (v1 pools).
  Checked 2026-09-21 by reading the deployed mainnet source of both v2 pools. They are
  immutable, so this cannot be patched. The undeployed Tier 2 v3 pools had the identical
  defect — inherited from the v2 sources they're built on — and it is **fixed as of PR #68**:
  `deposit` now asserts the pause flag, with 8 mutation-checked regression tests.
- **Admin-transfer naming differs.** Four contracts propose with `transfer-admin`;
  `flashstack-sbtc-core-v2` uses `set-admin`. All five accept with `accept-admin`. All are
  undeployed, so this can still be unified; until it is, an operations runbook written
  against one name fails against the other.
- The four deployed contracts with a one-step admin transfer (finding `BC1`) stay that way;
  the two-step fix exists only in the undeployed successors.

## Reproducing

Node 20 (what CI runs) and Clarinet. `npm ci && clarinet check && npm test`. The third-party contracts
that receivers call are vendored under `.cache/requirements/`, so no network fetch is
needed and CI does not depend on a rate-limited API.

## Logistics

- **Repository:** <https://github.com/mattglory/Flashstack> (public).
- **Maintainer:** `@mattglory`. **Security & Contract Lead:** `@unixwhisperer`, who reviews
  every contract change.
- **Fixes** land as PRs against the frozen commit, each with a regression test.
- **Timing:** we want the earliest available start, and an itemized quote for the two
  scopes above.
