# Multi-Asset Flash-Loan Core — Design (v0.1)

**Internal design doc — for review before implementation.** Target: replace the per-asset SIP-010 cores/pools (`flashstack-sbtc-core`, `flashstack-sbtc-pool-v2`) with a single generic core + pool that lists any SIP-010 token (sBTC, **USDCx**, aeUSDC, sUSDT, …) as a reserve. STX stays on the native `flashstack-stx-core`. Aave-style, pro-standard.

---

## 1. Goals / non-goals

**Goals**
- One flash-loan core + one LP pool handle **any listed SIP-010 asset** — adding an asset is an admin call, not a new contract.
- Same solvency guarantee as today (measure-balance-before/after invariant), per asset.
- Virtual shares/assets (F-1 fix) built in from day one on the pool.
- USDCx listable immediately (Circle xReserve USDC on Stacks; central to the Hermetica→Zest yield flow).

**Non-goals**
- Not handling native STX in the generic core (STX isn't SIP-010; keep `flashstack-stx-core`).
- Not a lending market (no borrowing against collateral — that's Zest). This is flash liquidity + LP yield only.

---

## 2. The Clarity constraint that shapes the design

Clarity **cannot persist a trait reference** in a var/map, so the core can't "store a token and call it later." Therefore:

- The token is passed as a **`<sip-010-trait>` parameter on every call** (`flash-loan`, `deposit`, `withdraw`).
- The core derives the asset key with `(contract-of token)` and looks up per-asset state in maps keyed by that **principal**.
- Balance/transfer use the passed trait.

This is exactly how Aave-on-Clarity and Zest handle multi-reserve. It also creates a **new security dependency** (§7): a malicious token contract could lie about `get-balance`/`transfer`, so **only admin-listed assets may be borrowed** — the asset allow-list is *load-bearing for solvency here*, unlike the receiver whitelist (which stays defense-in-depth).

---

## 3. Traits

**Generic flash-receiver trait** (new — replaces per-asset `execute-stx-flash`/`execute-sbtc-flash`):

```clarity
(define-trait flash-receiver
  (
    ;; token passed so the receiver can repay; asset principal + amount + core
    (execute-flash (<sip-010-trait> uint principal) (response bool uint))
  )
)
```

SIP-010 trait: use the canonical Stacks `sip-010-trait` (`SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard` or the repo's local mirror).

**Provenance-clean deploy (decided 2026-07-27):** the v1/v2 receiver traits live under the *compromised/dead* namespaces (STX → `SP3TGRVG…`, sBTC → `SP20XD46…`). Referencing them is safe — a `define-trait` is an immutable interface with no funds/admin/state, so a compromised key can't touch it — but it's not clean provenance. For v3, **deploy the new generic `flash-receiver` trait FRESH under the secure wallet `SPR9PQ…`** (and, if we want a fully self-contained stack, fresh STX/sBTC receiver traits too). Result: the entire v3 system references no compromised namespaces. The already-deployed v2 pools keep their old-namespace trait refs (immutable, safe, unavoidable).

---

## 4. Core interface (`flashstack-core-v3`, working name)

**Public**
| Fn | Args | Notes |
|----|------|-------|
| `flash-loan` | `(token <sip-010-trait>) (amount uint) (receiver <flash-receiver>)` | the money path (§5) |
| `add-asset` | `(token principal) (fee-bp uint) (max-loan uint)` | admin: list a reserve |
| `set-asset` | `(token principal) (fee-bp uint) (max-loan uint) (paused bool)` | admin: update |
| `remove-asset` | `(token principal)` | admin: delist |
| `add-approved-receiver` / `remove-approved-receiver` | `(receiver principal)` | admin |
| `set-paused` | `(bool)` | admin: global halt |
| `propose-admin` / `accept-admin` | two-step ownership | admin |

**Read-only**
`get-asset(token) → {enabled, fee-bp, max-loan, paused, total-loans, total-volume, total-fees}`, `get-reserve(token <trait>) → uint` (live balance), `is-approved-receiver(principal)`, `is-listed(token)`, `get-admin`.

---

## 5. Flash-loan flow + invariant

```clarity
(define-public (flash-loan (token <sip-010-trait>) (amount uint) (receiver <flash-receiver>))
  (let ((asset  (contract-of token))
        (cfg    (unwrap! (map-get? assets asset) ERR-NOT-LISTED))
        (fee    (max u1 (/ (* amount (get fee-bp cfg)) u10000)))
        (before (unwrap! (contract-call? token get-balance (as-contract tx-sender)) ERR-BAL)))
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (asserts! (not (get paused cfg)) ERR-ASSET-PAUSED)
    (asserts! (and (> amount u0) (<= amount (get max-loan cfg))) ERR-LIMIT)
    (asserts! (default-to false (map-get? approved (contract-of receiver))) ERR-NOT-APPROVED)
    (asserts! (>= before amount) ERR-INSUFFICIENT)
    ;; send
    (unwrap! (as-contract (contract-call? token transfer amount tx-sender (contract-of receiver) none)) ERR-XFER)
    ;; callback
    (try! (contract-call? receiver execute-flash token amount (as-contract tx-sender)))
    ;; INVARIANT: reserve grew by >= fee
    (let ((after (unwrap! (contract-call? token get-balance (as-contract tx-sender)) ERR-BAL)))
      (asserts! (>= after (+ before fee)) ERR-REPAY)
      ;; per-asset stats update …
      (ok true))))
```

Invariant is **per token balance**, measured on the passed trait — identical safety to the single-asset cores. Reentrancy: each asset's balance is independent, so a receiver re-entering for a *different* asset is safe (its own invariant must hold too).

---

## 6. Multi-asset LP pool (`flashstack-pool-v3`, working name)

- `deposit(token <trait>, amount)` / `withdraw(token <trait>, shares)` — **per-asset** share accounting.
- State: `shares: {asset, lp} → uint`, `total-shares: asset → uint`. Reserve = live token balance.
- **Virtual shares + virtual assets from day one** (the F-1 fix), per asset:
  `shares_out = amount * (total + VS) / (reserve + VA)` ; `assets_out = shares * (reserve + VA) / (total + VS)`.
- Built-in oracle per asset: `get-share-price(token)`, `get-lp-value(token, lp)` using the same offset formula (F-2-consistent).
- Fees from each flash loan on an asset stay in that asset's reserve → its shares appreciate. Flash-loan path mirrors §5.

Decimals: `SHARE-PRECISION` per asset is unnecessary if we normalize — but keep a fixed large precision (e.g. `u1000000` virtual offset) and let the frontend format by the token's decimals (the `LP_POOLS` registry already carries `decimals`/`sharePrecision`).

---

## 7. Security model (what's new vs single-asset)

| Control | Role |
|---|---|
| **Asset allow-list** (`add-asset`) | **Load-bearing for solvency.** Only trusted, real SIP-010s are borrowable; blocks a malicious token that lies about `get-balance`/`transfer`. Admin-gated. |
| Balance invariant (per asset) | Same as today — reserve must grow by ≥ fee or the tx reverts. |
| Receiver whitelist | Defense-in-depth (beta); removable post-audit. |
| Virtual shares/assets | First-depositor inflation protection, per asset. |
| Per-asset pause + global pause | Circuit breakers. |
| **Two-step admin transfer** | **Non-negotiable, proven pattern — see below.** No fat-finger ownership loss. |

**Key point for the auditor:** the asset allow-list is a *security boundary*, not a convenience — a generic core that let anyone flash-loan an arbitrary token principal would be exploitable via a dishonest token contract. Only vetted assets (USDCx, sBTC, aeUSDC) get listed.

### 7a. Two-step admin transfer (BC1 audit finding, 2026-08-01)

**Confirmed defect in every currently-deployed governed contract** (`flashstack-stx-core`, `flashstack-sbtc-core`, `flashstack-stx-pool-v2`, `flashstack-sbtc-pool-v2`): admin transfer is **one-step and self-gated** — `transfer-admin`/`set-admin` is itself gated by the current admin, with no accept step, timelock, or alternate recovery path. Proposing a mistyped or uncontrolled principal **permanently bricks every admin function on that contract**, including the ability to fix the mistake, and on the cores strands the deposited reserve (`withdraw-reserve` becomes unreachable). Not attacker-reachable (admin-only), but unrecoverable — an operational footgun, not an exploit. Empirically proven via failing/passing simnet tests (`tests/bc1-admin-lockout.test.ts`).

**Fix, already written and proven** (`tests/bc1-two-step-fix.test.ts`, 6/6 passing) in `flashstack-sbtc-pool-v3.clar`, `flashstack-stx-pool-v3.clar`, `flashstack-sbtc-core-v2.clar`:

```clarity
(define-data-var pending-admin (optional principal) none)

;; Step 1: propose. Does NOT change admin yet.
(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set pending-admin (some new-admin)))))

;; Step 2: the PROPOSED admin must accept. A principal nobody controls can never
;; call this, so a bad proposal simply never takes effect — the original admin
;; keeps full control and can re-propose the correct address.
(define-public (accept-admin)
  (let ((pending (unwrap! (var-get pending-admin) ERR-NOT-PENDING-ADMIN)))
    (asserts! (is-eq tx-sender pending) ERR-NOT-PENDING-ADMIN)
    (var-set admin pending)
    (var-set pending-admin none)
    (ok true)))
```

**Requirement for `flashstack-pool-v3`: this pattern is mandatory from the first line of code, not a retrofit.** Reference the three contracts above directly rather than re-deriving it. Every `add-asset`/`set-asset`/pause/fee-setter function is gated the same way, so the same lockout shape applies identically to a multi-asset core holding several real tokens — get it right before any deposit is possible.

---

## 8. USDCx (first listed asset)

USDCx = Circle's native USDC on Stacks (xReserve), SIP-010, 1:1 USDC. Get the exact contract from the Stacks docs (`docs.stacks.co/learn/bridging/usdcx`) and verify on-chain before listing. Once the core is live: `add-asset(usdcx, fee-bp=5, max-loan=<sane cap>)`. Strategically ties into the Hermetica→Zest flow (BTC→sBTC→borrow USDCx→USDh→yield) — amplified by SIP-045 Bitcoin staking.

---

## 9. Rollout

1. **Timing + Clarity version:** SIP-045 (PoX-5 Bitcoin staking) and **SIP-044 (Clarity 6)** both activate at **Stacks Epoch 4.0** in the same ~Jul 29 hard fork. **New contracts deployed in Epoch 4.0 default to Clarity 6** — so target **Clarity 6** for core-v3/pool-v3 once the fork lands (verify clarinet/SDK support post-fork). Clarity 6 also adds capabilities worth using: **native trustless Bitcoin-tx verification** (no oracle for sBTC/BTC-peg checks), Ed25519/secp256k1 crypto built-ins, variadic `concat`, and `with-staking`/`with-pox` allowances (relevant if the STX pool later stacks its idle reserve for BTC yield — "fees + staking yield").
2. Implement core-v3 + pool-v3; port the full test discipline (invariants, guards, first-depositor neutralization, malicious-token-listed-vs-unlisted, **two-step admin transfer + lockout test — §7a, non-negotiable**).
3. Deploy under the **secure wallet** (`SPR9PQ…`), same as the v2 pools.
4. `add-asset`: sBTC, then USDCx (+ aeUSDC later).
5. Frontend: extend the `LP_POOLS` registry; the pool page already switches on asset.
6. **Audit gate:** the generic core holds multiple real assets incl. a stablecoin — a professional audit is a hard prerequisite before meaningful TVL. The asset allow-list keeps risk bounded until then.

---

## 10. Decisions — LOCKED (2026-07-26, after research)

1. **Receiver whitelist → GLOBAL (beta-only).** Temporary defense-in-depth; removed post-audit toward Aave-style permissionless. The asset allow-list + balance invariant are the real solvency controls.
2. **Rollout → keep v2 STX/sBTC pools live; introduce the generic system with USDCx; migrate sBTC into it post-audit.** Optional: ship a *standalone* hardened USDCx pool sooner (copy of the sBTC pool) if USDCx is urgent for the Zest/Hermetica thread, and fold it into the generic pool later.
3. **REVISED → ONE combined generic pool, NOT separate core + pool.** The v2 pools already combine LP + `flash-loan` in one contract, and Aave V3's Pool does the same. A separate core would fragment the asset's liquidity (reserve vs LP) or be a pointless wrapper. So the SIP-010 multi-asset system = **one `flashstack-pool-v3`** (LP liquidity *is* the flash-loan reserve; fees accrue to LPs). The legacy `flashstack-stx-core` (native STX, admin reserve, DeepStack flywheel) stays untouched. *(Zest-style separated logic/state for upgrade-without-migration considered and deferred — too complex for this stage.)*
4. **Fee → per-asset configurable via `add-asset`/`set-asset`, default 5 bp, HARD CAP ≤100 bp (1%)** so admin can't set a predatory fee.
5. **Admin transfer → two-step (propose + accept-admin), MANDATORY, non-negotiable (§7a).** Confirmed via audit that every currently-deployed governed contract uses a one-step, self-gated transfer that permanently bricks governance (and strands the reserve on the cores) if given a bad value — admin-only trigger, but unrecoverable. Proven fix already exists in `flashstack-{sbtc,stx}-pool-v3`/`flashstack-sbtc-core-v2`; port it verbatim, don't re-derive it.

**Net structural change from §4/§6:** drop the separate `core-v3`; build a single `flashstack-pool-v3` (generic multi-asset LP pool with built-in flash loans, virtual shares/assets, per-asset config + oracle). Everything in §5 (flash-loan flow/invariant) and §6 (pool) merges into that one contract. Build on Clarity 6 after Epoch 4.0 (~Jul 29); full test discipline + malicious-token listed-vs-unlisted test; audit gate before real TVL.

---

## 11. Scaffold built (2026-08-01) — two empirical corrections to this design

`flashstack-pool-v3.clar` (+ test copy, `flashstack-v3-receiver-trait.clar`, and a full test suite: `tests/flashstack-pool-v3.test.ts`, 18 tests) is written and passing (154/154 full suite, `clarinet check` ✔ 37 contracts). Building it surfaced two things this design got wrong that are worth recording so they aren't re-derived:

1. **Clarity 6 is now live in this contract (migrated 2026-09-09) — and the earlier "toolchain gap" note was wrong about why it wasn't.** §9 said "target Clarity 6 once the fork lands, verify clarinet/SDK support post-fork." The fork landed (Epoch 4.0 / PoX-5 activated at Bitcoin block 960,230, confirmed on-chain 2026-08-01), and `as-contract` — used by every deposit/withdraw/flash-loan in this codebase — failed at `clarity_version=6` with "use of unresolved function 'as-contract'," reproduced on clarinet CLI/SDK 3.22, 3.23.1, and 3.23.2. This was previously written up here as a toolchain gap waiting on a clarinet/SDK fix. **That was wrong.** `as-contract` is a hard error by design as of Clarity 4 — deprecated in favor of `as-contract?` (explicit allowance list: `with-stx`/`with-ft`/`with-nft`/`with-stacking`/`with-staking`/`with-pox`, returns `(response A uint)`) and the new `current-contract` keyword for the common no-privilege "get my own principal" case — confirmed against the actual Clarity 4 spec (SIP-033) and docs.stacks.co. Migrated all nine `as-contract` call sites: seven were pure identity reads (`(as-contract tx-sender)` → `current-contract`, no allowance needed) and two were real fund outflows (withdraw's and flash-loan's transfer-out), which now carry `(as-contract? ((with-ft (contract-of token) "*" amount)) ...)` — scoped to the one listed token contract and the exact amount moved, `"*"` for the token-name because this pool is generic across SIP-010 assets and can't know each one's internal `define-fungible-token` name at compile time. Deliberately not `with-all-assets-unsafe` (unrestricted access to every asset the contract holds) since the narrower allowance is available and sufficient. `clarinet check` clean, full suite still 165/165 post-migration, including the flash-loan and withdraw paths that exercise the new allowance at runtime, not just statically. `flashstack-pool-v3` is now `clarity_version = 6`, `epoch = "4.0"` — the three receiver test contracts that call into it were bumped to `epoch = "4.0"` too (a real dependency-ordering requirement Clarinet enforces) but deliberately stay `clarity_version = 3`, since their own `as-contract` usage is still valid there and nothing required changing it.

2. **The oracle read-only functions in §4/§6 (`get-share-price(token <trait>)`, `get-lp-value(token <trait>, lp)`, `get-reserve(token <trait>)`) are not implementable as written.** Clarity forbids *dynamic* (trait-typed) `contract-call?` inside `define-read-only` — stricter than the literal-vs-`define-constant` gotcha already documented in `BUILD_A_RECEIVER.md`: a trait-typed parameter means the actual callee is unknown until runtime, so Clarity cannot statically prove an arbitrary implementer's function is side-effect-free, and rejects the call outright regardless of which function is named. **Fix:** the `assets` map carries a cached `reserve: uint` field, refreshed at the end of every `deposit`/`withdraw`/`flash-loan` (all of which already re-measure the live balance via the trait, since they're `define-public` and dynamic dispatch is fine there). The three oracle functions read this cached field and take a plain `principal`, not a trait. Consequence: a direct token donation to the pool (bypassing `deposit`) won't move the oracle price until the *next* real interaction refreshes the cache — a lag, not a solvency issue, since the balance invariant in `flash-loan`/`withdraw` still measures the live balance every time.

## 12. Post-scaffold code review (2026-08-19) — two fixes applied

Fresh review of the finished scaffold (ecosystem/toolchain re-verified first: SIP-044/045 formally ratified, clarinet bumped 3.22→3.23.1 — the Clarity-6 `as-contract` gap from §11 **still reproduces on 3.23.1**, confirmed again — and USDCx now has a real, on-chain-verified mainnet contract, `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx`, SIP-010 confirmed, $461K TVL in the Bitflow sBTC/USDCx pool — the "first listed asset" placeholder in §8 is now concretely answerable). Two findings, both fixed and tested (155/155 full suite, `clarinet check` ✔ 37 contracts):

1. **MEDIUM — `deposit()` wrote state after the external token transfer; `withdraw()` already did it in the safer order.** `withdraw()` correctly updates `lp-shares`/`total-shares` *before* calling `contract-call? token transfer`; `deposit()` had it backwards. Traced by hand (not just asserted): if a *listed* token's `transfer` ever called back into `deposit`/`withdraw` for the same asset mid-call, `total-shares`'s stale `let`-bound value (captured before the reentrant call) would get map-set *after* the interaction, silently overwriting whatever the reentrant call had written — `lp-shares` self-heals (it re-queries fresh at write time) but `total-shares` does not, so the two maps end up inconsistent (a depositor's own recorded shares can exceed the recorded total supply of shares). Every asset actually verified on this project (sBTC, USDCx, the local mocks) uses plain `ft-transfer?`, which cannot reenter — so this isn't exploitable by any currently-real listed token — but it's a free, zero-downside fix (pure reorder; Clarity transactions are atomic, so if the transfer subsequently fails everything reverts together) and exactly the class of finding a professional audit would flag. **Fixed**: all `deposit()` state writes now happen before the transfer call, matching `withdraw()`.
   - **Not proven with an executable reentrant-token test, and here's why, precisely:** built a real SIP-010 mock (`ft-transfer?`-backed, so balances genuinely move) whose `transfer()` calls back into `deposit()` for itself. Clarinet's deployment-plan dependency scanner treats a contract's own trait-argument self-reference (`.reentrant-token` passed as the `<sip-010-trait>` argument to its own reentrant call) as a `CircularReference` and refuses to compute a plan — confirmed with three independent workarounds, all failing: (a) dot-sugar self-reference, (b) an absolute-principal self-reference (semantically identical at runtime, but the analyzer still flags it), (c) manually freezing an on-disk plan with `-d`/`--use-on-disk-deployment-plan` to bypass auto-computation entirely, which gets past the *CircularReference* but then fails at analysis time with `use of unresolved contract` — the static analyzer cannot resolve a contract referencing itself regardless of declared order, since it doesn't consider a contract "known" while it's still analyzing that same contract. The SDK's `initSimnet` has no option to supply a fixed plan path, so this isn't reachable from `npm test` either. Genuine Clarinet/Clarity tooling limitation, not a workaround I missed — the fix here rests on a rigorous manual trace (walked the exact map values through both the buggy and fixed ordering) rather than a red→green test. Removed the mock rather than leave a permanently-broken contract in the tree.

2. **LOW/MEDIUM — `deposit()` had no floor guard on the shares it mints; `withdraw()` already had the equivalent guard on its output.** `withdraw()` asserts `amount-out > 0`; `deposit()` asserted `amount > 0` (the input) but never checked `new-shares > 0` (the output). A small deposit into an already-large/valuable pool can floor-divide to exactly `0` new shares — the token transfer still succeeds, the depositor receives `(ok u0)`, and their deposit is silently absorbed with no revert and no shares credited. Reachable by any honest depositor with bad timing, no adversary needed. **Fixed**: `deposit()` now asserts `new-shares > 0`, mirroring `withdraw()`. **Proven empirically, both directions**: a test skews the pool's price-per-share via a direct donation (same technique the F-1 test already uses) until a 1-base-unit deposit floors to zero shares. Ran it against the guard removed first — failed with `Expected (err ...) but got (ok 0)`, exactly the predicted silent-loss bug — then restored the guard and confirmed it passes (`tests/flashstack-pool-v3.test.ts`, "deposit rejects a zero-share mint").

## 13. Independent review by Hillary Kibet (2026-08-25) — three findings, all fixed

External review of the finished, already-once-reviewed scaffold, scoped specifically to state/invariants, adversarial reentrancy, and cross-checking the "ported verbatim" claims in §7a/§12 against the actual sibling contracts. Found three real, worthwhile issues section 12's review missed — proof the second-pass-by-a-different-reviewer model is earning its keep. All three reproduced independently (not taken on faith) before fixing, per this project's standing practice. Full suite after all fixes: 165/165, `clarinet check` ✔ 38 contracts.

**Aside, corrected 2026-08-26 after further correspondence with Hillary — one process observation that was wrongly dismissed, and one scope mismatch that wasn't anyone's error:**

(1) Hillary originally reported PR #24's merge unexpectedly bringing in 129 files / +21,600/-4,658 lines including `pool-v3.clar` itself. The specific mechanism she first proposed — that the *merge* introduced those files — checked out false: the merge commit touched exactly the 8 originally-reviewed files, nothing else, and `pool-v3.clar` on `main` was byte-identical before and after it. That much was accurately reported here. Calling the whole thing a "false alarm" was wrong, though: her real, underlying observation — that `pool-v3.clar` and a large volume of surrounding code reached `main` outside of any PR — is true and she re-verified it precisely. `git merge-base --is-ancestor cd98b0b 76d4f95` confirms `pool-v3.clar`'s scaffold commit (`cd98b0b`, 2026-08-02) predates PR #24 (opened three weeks later) and is not an ancestor of the PR #24 branch (`f89ac09`); it is also not reachable through the second parent of any merge commit on `main`. It landed the same way the large majority of this repo's history has: as of this correction, 135 of 140 first-parent commits on `main` (~96%) are direct, non-merge commits, with only 5 merge commits total. That's a fair thing for an external reviewer to flag as a process gap — not a stale-checkout artifact — and it's noted here plainly rather than argued away a second time.

(2) Hillary reported "16 tests across four files" against my original "6 tests in one file." Both numbers are correct — they answer different questions. My count was scoped to tests that verify the BC1 two-step fix was ported to the three siblings named in §7a/§12 (`flashstack-sbtc-pool-v3`, `flashstack-stx-pool-v3`, `flashstack-sbtc-core-v2`): that's `tests/bc1-two-step-fix.test.ts`, 6 tests at the time of this review. (Now 8, as of 2026-09-16: PR #45 added `flashstack-stx-core-v2` as a fourth contract in that file's matrix, and the file runs 2 tests per contract. The sibling-porting question this section addresses is unchanged.) Her 16/4 figure, re-run and confirmed exactly at the time (18 as of 2026-09-16, for the same PR #45 reason), adds `tests/bc1-admin-lockout.test.ts` (2 tests, demonstrates the *original* one-step lockout bug on `flashstack-sbtc-pool-v2` — a different, non-sibling contract) plus two unrelated hardening files for the v2 pools (4 tests each). Neither addition is about the sibling-porting question this section addresses. No discrepancy, no stale checkout — just two people counting different, valid things under the same shorthand. Worth being explicit about so it doesn't read as either of us being wrong.

1. **MEDIUM (F1) — a receiver reentering `deposit()` for the SAME asset during its own flash-loan callback got its real deposit inflow miscounted as fee revenue.** `flash-loan` computes `total-fees += (reserve-after - reserve-before)`, a naive balance delta that assumes the entire measured growth is loan repayment. If the receiver calls `deposit()` for the same asset before repaying, that deposit's real token inflow lands in the SAME balance delta and gets counted as fee. Reproduced with Hillary's exact numbers (`tests/pool-v3-hillary-review.test.ts`): a 1,000,000-unit loan at 5bp (500 fee) armed with a 1,000-unit reentrant deposit made `flash-loan` succeed with `total-fees` reported as 1500. No fund-loss path — `lp-shares`/`total-shares`/`reserve` all stayed internally consistent — but a real, cheap (single-tx, no capital cost beyond the deposit itself), and arbitrarily-repeatable way to corrupt an analytics/yield-reporting counter, meaningfully worse than the already-accepted "many tiny loans inflate total-loans" pattern (that one costs real gas+capital per increment; this one doesn't). **Fixed:** a per-asset reentrancy lock (`asset-locked: principal -> bool`), checked and set as the first operation in `deposit`/`withdraw`/`flash-loan`, released as the last. Deliberately **per-asset, not global** — a global lock would also block a receiver's callback from legitimately flash-loaning a *different* asset in the same transaction, regressing the cross-asset independence §5 already establishes as safe and intentional (a real pattern for multi-asset arb/rebalance strategies, e.g. DeepStack-style). Post-fix, the same repro now reverts with `ERR-REENTRANT` (u815) and `total-fees`/`total-loans` are untouched — proven both directions (blocked-with-error, and a normal non-reentrant loan on the same asset still working correctly afterward).
2. **MEDIUM (F2) — the generic pool used one flat virtual-shares constant (1e6) for every asset; the sibling single-asset v3 contracts calibrate it to each asset's own decimals (1e8 for sBTC, 1e6 for STX).** Found specifically by checking the "ported verbatim" claim in §7a/§12 against the actual sibling sources rather than trusting the comment — the two-step-admin logic ported byte-identical, but the decimals-specific calibration did not carry over into the generic pool. A flat constant under-calibrates the F-1 inflation-attack protection for any asset with more decimals than the constant assumes (weaker phantom-shares dominance relative to that asset's own unit scale) — exactly the kind of gap a generic multi-asset pool is more exposed to than the single-asset contracts it was generalized from, since decimals now genuinely vary per listed asset. **Fixed:** `assets` gained a `share-scale` field (= `10^decimals`), computed from a **live `get-decimals()` call** on the token at `add-asset` time (not a hardcoded per-asset lookup table — works for any future SIP-010 without a code change), used everywhere the old flat `VIRTUAL-SHARES`/`SHARE-PRECISION` constants were. `add-asset` changed signature from `(token principal)` to `(token <sip-010-trait>)` to allow the live read. A `MAX-DECIMALS` sanity cap (24) guards against a pathological `get-decimals()` value. Proven directly: sBTC (8 decimals) computes `share-scale = 100,000,000`; USDCx (6 decimals) computes `1,000,000` — different, correct, live-derived values (`tests/pool-v3-hillary-review.test.ts`, "F2: share-scale is calibrated to each asset's own decimals").
3. **MEDIUM (F3) — pause blocked `flash-loan` but not `deposit`.** The header comment explicitly documents that `withdraw` is intentionally never pause-gated (LPs can always exit); it said nothing about `deposit`, and there was no test either way — an oversight, not a considered decision. Standard circuit-breaker semantics (Aave/Compound-style: pause stops *new* exposure, never blocks exit) say deposits should be gated the same as loans. **Fixed:** `deposit` now asserts both the global and per-asset pause, identically to `flash-loan`; `withdraw` is unchanged (still never gated). Tested both pause paths blocking deposit and confirmed withdraw still isn't gated even while paused (`tests/pool-v3-hillary-review.test.ts`, "F3: pause gates deposit like it gates flash-loan").

**Two additional hardening points, both fixed as part of the same pass:**
- **Oracle cache staleness across a delist/relist cycle.** Originally `remove-asset` deleted the map entry outright; a later `add-asset` reset `reserve` to a hardcoded `0`, which would be wrong if the pool still held a real balance from before delisting (e.g. LPs who hadn't withdrawn yet). **Fixed as part of the F1/F2 restructure:** `remove-asset` now soft-disables (`enabled: false`) instead of deleting, and `add-asset` (now needed as a trait-taking function for F2 anyway) live-queries `get-balance()` to seed `reserve` correctly on both first listing and re-enable — this also gives the previously-dead `enabled` field (flagged as unused in an earlier review pass) a real purpose, and lets `withdraw` keep reading `share-scale`/`reserve` for a delisted asset without the `match ... true` graceful-degradation branch it needed before.
- **Oracle reads for a never-listed token returned a plausible-looking default instead of erroring.** `get-share-price`/`get-lp-value`/`get-reserve` used `default-to` fallbacks that silently produced a small-but-nonzero "valid-looking" value for a token that was never added, which could mislead an integrator (e.g. a lending protocol checking collateral value) into treating it as real. **Fixed:** all three now `unwrap!` the `assets` map entry and return `ERR-NOT-LISTED` for a token that was never listed. Tested directly for all three functions.
