# FlashStack Findings Register

**Status:** Internal register, now tracked in-repo (moved here 2026-09-16 at the
Security & Contract Lead's request — an auditor needs this on day one, not as
tribal knowledge). Supersedes the previous local-only `SECURITY_REVIEW.md`.
**Scope:** every contract reviewed to date — the live v1/v2 system and the
undeployed v3/BC1-successor line, including `flashstack-pool-v3` (the audit
target).

Severity follows standard usage: Critical/High = funds at risk without an
adversary needing privileged access; Medium = real but requires a specific,
plausible condition or has a bounded blast radius; Low/Informational = no
fund-loss path, but worth fixing or documenting. **No Critical or High finding
has been identified in any contract reviewed to date.**

---

## Findings table

| ID | Severity | Contract | Issue | Status |
|----|----------|----------|-------|--------|
| F-1 | Medium | `flashstack-stx-pool`, `flashstack-sbtc-pool` (v1) | First-depositor / donation share inflation — no minimum-liquidity lock, dead-shares mint, or virtual-shares mitigation | **Fixed** in `flashstack-stx-pool-v2` / `flashstack-sbtc-pool-v2` (virtual shares/assets, ERC-4626-style), proven by test. v1 pools remain vulnerable in principle but are now paused/drained (see F-6). |
| F-2 | Low | `flashstack-pool-oracle`, sBTC pool's built-in oracle | `get-share-price` returns a launch-price scale inconsistent with the post-deposit scale | **Fixed** in `flashstack-pool-oracle-v2` and the sBTC v2 built-in oracle (offset formula well-defined at 0 shares), proven by test. |
| F-3 | Informational | `flashstack-pool-oracle` (v1 and v2) | `get-share-price` integer-rounds; a 0.05% fee doesn't move it | Doc note — integrators should price collateral off `get-lp-value`, which tracks the true value precisely. |
| F-4 | Informational | `flashstack-sbtc-core` | `set-fee-basis-points` returns `ERR-NOT-ADMIN` on a too-high fee instead of a distinct error code | Open (cosmetic, no security impact). |
| F-5 | Informational | all live cores/pools | `total-loans` / `total-volume` are inflatable by many tiny loans | Accepted — don't treat these on-chain counters as tamper-proof traction metrics. |
| **F-6** | **Low** | `flashstack-stx-pool`, `flashstack-sbtc-pool` (v1) | **`deposit` is not gated by `paused`.** Verified against the deployed source directly: the v1 pools' `deposit` function has no `paused` check at all — only `amount > 0`. Both pools are currently `paused=true` with zero balance and zero shares, but a deposit today would still succeed, using the pre-F-1 share formula (`amount * SHARE-PRECISION` at zero shares — the exact inflation-vulnerable path F-1 fixed in v2). | **Open, accepted risk.** These are immutable deployed contracts — nothing can be patched in place. Mitigations: (1) documentation now states plainly that "paused" does not mean "closed to deposits" for the v1 pools; (2) no funds are currently at risk since the pools are empty; (3) migrating any future liquidity intent to the v2 pools removes the F-1 exposure but **not this gap** — the v2 pools share it (see F-8; *corrected 2026-09-21, this row previously presented v2 as the fix*). Found by the Security & Contract Lead, 2026-09-15. |
| BC1 | Medium | `flashstack-stx-core`, `flashstack-sbtc-core`, `flashstack-stx-pool-v2`, `flashstack-sbtc-pool-v2` | One-step, self-gated admin transfer — a bad value permanently bricks governance (and stalls the reserve on the cores). Admin-only trigger, but unrecoverable if mistriggered. | **Fixed** in the not-yet-deployed successors (`flashstack-stx-core-v2`, `flashstack-sbtc-core-v2`, `flashstack-stx-pool-v3`, `flashstack-sbtc-pool-v3`) via two-step transfer (propose + accept). The four *deployed* contracts remain one-step and are immutable; mitigated operationally by treating `transfer-admin`/`set-admin` on any live contract as a do-not-call path until the successors ship. |
| **F-7** | **Medium (process, not a contract bug)** | `contracts/flashstack-stx-core.clar` (and its `contracts/test/` copy) | The file claimed to be a byte-identical local copy of the deployed mainnet contract had silently drifted: it carried the BC1 two-step fix (`pending-admin`/`accept-admin`, absent on mainnet) and a `calculate-fee` that rejects `u0` (mainnet floors to `u1` instead). Both differences were verified directly against the source fetched from the chain. Effect: the "deployed core" test suite was validating the behavior of a contract that does not exist on mainnet. | **Fixed.** `flashstack-stx-core.clar` restored verbatim from the deployed source; the hardened variant preserved as a proper named successor, `flashstack-stx-core-v2.clar`, matching the pattern the other three BC1 successors already use. `tests/mainnet-fidelity.test.ts` now pins the deployed shape for all six live contracts so this class of drift fails CI instead of going unnoticed. Found and fixed by the Security & Contract Lead (PR #45), 2026-09-15/16. |
| **F-8** | **Low** (confirmed by the Security & Contract Lead) | `flashstack-stx-pool-v2`, `flashstack-sbtc-pool-v2` (**live, still open**); `flashstack-stx-pool-v3`, `flashstack-sbtc-pool-v3` (**fixed**) | **`deposit` is not gated by `paused`.** Verified 2026-09-21 by reading the *deployed mainnet source* of both v2 pools and the repo source of both v3 pools: `deposit` asserted only `amount > 0`, while `flash-loan` asserted `(not (var-get paused))`. Same defect as F-6 (v1 pools) and pv3-F3 (pool-v3, fixed there only). The v3 pools were the v2 pool sources plus the two-step admin change (14 differing lines each, all admin-related), so they inherited it. | **Split by deployment status (PR #68, 2026-09-22).** Live v2 pools: **still open** — immutable, cannot be patched; while paused, deposits still succeed (withdrawals are intentionally never blocked). Undeployed v3 pools: **fixed** — `deposit` now runs `(asserts! (not (var-get paused)) ERR-PAUSED)` before the zero-amount check in both `flashstack-stx-pool-v3` and `flashstack-sbtc-pool-v3`, matching pool-v3's ordering; the `contracts/test/` copies carry the identical change, and 8 regression tests (`tests/v3-pools-pause-gate.test.ts`) are mutation-checked — stripping the gate from the compiled copies turns exactly the 4 fix-dependent tests red. Found while verifying a claim in `AUDIT_SCOPE.md`, 2026-09-21. |
| pv3-F1 | Medium | `flashstack-pool-v3` | A receiver reentering `deposit()` for the same asset during its own flash-loan callback got its real deposit inflow miscounted as fee revenue | **Fixed** — per-asset reentrancy lock (deliberately not global, to preserve legitimate cross-asset flash-loan flows). Found by an external reviewer, independently reproduced before fixing. |
| pv3-F2 | Medium | `flashstack-pool-v3` | Flat virtual-shares constant, not calibrated per asset decimals | **Fixed** — `share-scale` computed from a live `get-decimals()` call at listing time, not a hardcoded table. Proven directly (sBTC → 1e8, USDCx → 1e6). |
| pv3-F3 | Medium | `flashstack-pool-v3` | `deposit` was not gated by pause (oversight — `flash-loan` was) | **Fixed** — `deposit` now asserts both global and per-asset pause, matching `flash-loan`. |

---

## Notes for the auditor

- **The BC1 successors and `flashstack-pool-v3` are undeployed.** Everything with a "Fixed" status above is fixed *in the repository*, not on any live contract, unless the row says otherwise. Six contracts are live today and none of them contain a BC1 or F-7 fix — see `docs/security/CONTRACT_INVENTORY.md` §2 for exactly which.
- **F-6 cannot be fixed in place.** It's recorded here as a live, open, low-severity gap on immutable contracts, not as a to-do. Migrating to v2 removes the F-1 exposure but **not** the pause-gate gap, which the v2 pools share (**F-8**); only the undeployed v3 pools can still be fixed.
- **`docs/security/CONTRACT_INVENTORY.md` §5** records several additional discrepancies between repo documentation and actual chain/code state (stale test-count claims, a mismatched mainnet deployment plan file, CI coverage gaps, missing source for two live contracts) found during the same review pass that produced F-6 and F-7. Not duplicated here since they're not contract-security findings, but an auditor should read that section too.

---

*This register will be superseded by the professional audit report once one exists. Until then it is the project's security baseline — update it as findings are added or remediated, not just at review time.*
