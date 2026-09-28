# The FlashStack Solvency Invariant

**Owner:** Security & Contract Lead · **Evidence date:** 2026-09-15 · **Repo:** `436ea9c`

This is the single load-bearing safety property of the protocol. Everything else —
the receiver whitelist, the pause switch, the max-loan cap — is defence in depth.
If this property holds, an arbitrary and actively hostile receiver **cannot** take
value out of the pool. If it does not hold, nothing else saves you.

This document traces the invariant to the code that enforces it and the tests that
prove it, rather than restating the README.

---

## 1. The property

For one `flash-loan` call on asset *A*:

```
B_before  :=  balance of A held by the pool contract, measured on chain
fee       :=  max(1, floor(amount * fee_basis_points / 10000))

            transfer `amount` of A  ->  receiver
            call     receiver's callback
            (the receiver may do anything at all here)

B_after   :=  balance of A held by the pool contract, measured on chain again

REQUIRE:  B_after >= B_before + fee        else the whole transaction reverts
```

Note it is `>=`, not `==`. Over-repayment is a donation to the LPs, which is safe.
Under-repayment by even one unit aborts.

## 2. Why repayment cannot simply be trusted

The obvious design is to *ask* the receiver whether it repaid — have the callback
return `(ok true)` and take that as proof. That is worthless, because the receiver is
attacker-controlled code. It can return `(ok true)` having transferred nothing.

A slightly less obvious wrong design is to *record* a repayment: have the receiver
call back into `repay(amount)` and increment an internal counter. That is also
worthless unless the counter is reconciled against the real balance, because the
counter is only as honest as the path that increments it.

FlashStack avoids both by never asking. It **measures**. `B_after` is not a number
the receiver supplies or influences through bookkeeping — it is read from the chain's
own ledger with `stx-get-balance` or the token's `get-balance`. The only way to make
that number go up is to actually move the asset.

The practical consequence: the protocol does not need to understand, audit, or even
be able to read what the receiver does. An arbitrage, a liquidation, a five-hop DEX
route, a deliberately malicious contract — all are the same to the pool. They either
leave the balance higher by the fee, or they never happened.

## 3. Why atomicity is what makes measurement sufficient

Measurement alone would be useless on a system where the "revert" could be partial.
On Stacks, a public function returning `(err ...)` — or an `asserts!` failing — unwinds
**every** state change made during that contract call, including the outbound transfer
that funded the receiver in the first place.

So the failure mode is not "the pool lost money and we noticed". It is "the loan never
occurred". The pool's exposure between the transfer and the balance check is confined
to a window that cannot outlive the transaction, and that window has no observer who
can act inside it other than the receiver itself.

This is also why the ordering matters: the `asserts!` on `B_after` is the **last**
thing that can fail before the accounting vars are updated. Stats are incremented
only after solvency is proven.

## 4. Where it is implemented

`asserts! (>= reserve-after (+ reserve-before fee)) ERR-REPAY-FAILED`

**Live on mainnet** (verified against source fetched from the chain, not the repo copy):

| Contract | Enforcement site (repo copy) |
|---|---|
| `flashstack-stx-core` | `contracts/flashstack-stx-core.clar:167` |
| `flashstack-sbtc-core` | `contracts/flashstack-sbtc-core.clar:83` |
| `flashstack-stx-pool-v2` | `contracts/flashstack-stx-pool-v2.clar:164` |
| `flashstack-sbtc-pool-v2` | `contracts/flashstack-sbtc-pool-v2.clar:158` |
| `flashstack-stx-pool` (v1, paused) | `contracts/flashstack-stx-pool.clar:152` |
| `flashstack-sbtc-pool` (v1, paused) | `contracts/flashstack-sbtc-pool.clar:146` |

**Undeployed successors / audit target:**

| Contract | Enforcement site |
|---|---|
| `flashstack-pool-v3` | `contracts/flashstack-pool-v3.clar:373` |
| `flashstack-sbtc-core-v2` | `contracts/flashstack-sbtc-core-v2.clar:91` |
| `flashstack-stx-pool-v3` | `contracts/flashstack-stx-pool-v3.clar:172` |
| `flashstack-sbtc-pool-v3` | `contracts/flashstack-sbtc-pool-v3.clar:166` |

**Exception — a different invariant, not this one:**
`contracts/flashstack-core.clar:153` (generation-1, live at `SP3TGRVG…`) uses
`asserts! (is-eq supply-after (+ supply-before fee))`. That is a flash-*mint* design
checking token **supply equality**, not a reserve-balance inequality. It is a different
security argument and is **not** covered by this document. Filed under `Flashstack-ajv.4`.

### The measurement calls themselves

- STX: `(stx-get-balance (as-contract tx-sender))` — the chain's native balance.
- sBTC and SIP-010 assets: `(contract-call? <token> get-balance (as-contract tx-sender))`.

`(as-contract tx-sender)` is the pool's own principal. This is the detail that makes
the measurement trustworthy: the subject of the measurement is the contract itself,
not an argument the caller passes in.

## 5. Which tests prove it

A test proves the invariant only if it fails when the invariant is removed. These are
the ones that do:

| Test | File |
|---|---|
| "happy path: an approved receiver repays, and the reserve grows by exactly the fee" | `tests/flashstack-stx-core-reserve.test.ts:59` |
| "repay-or-revert: a receiver that keeps the funds reverts, and the reserve is untouched" | `tests/flashstack-stx-core-reserve.test.ts:71` |
| "happy path: an approved receiver repays, and the sBTC reserve grows by exactly the fee" | `tests/flashstack-sbtc-core-reserve.test.ts:67` |
| "repay-or-revert: a receiver that keeps the sBTC reverts, and the reserve is untouched" | `tests/flashstack-sbtc-core-reserve.test.ts:78` |
| "happy path: reserve grows by exactly the fee" | `tests/flashstack-pool-v3.test.ts:240` |
| "a receiver that never repays reverts the whole transaction" | `tests/flashstack-pool-v3.test.ts:248` |
| "a flash-loan fee raises the LP's value by exactly the fee, realizable on withdrawal" | `tests/flashstack-sbtc-pool.test.ts:75` |

The adversary in these is a real deployed-to-simnet contract, not a mock:
`contracts/test/test-receiver-bad.clar`, `test-sbtc-receiver-bad.clar`,
`test-pool-v3-receiver-bad.clar` (keeps the funds) and
`test-pool-v3-receiver-reentrant.clar` (re-enters during the callback).

### Mutation check — which of those tests are actually load-bearing

**VERIFIED 2026-09-15.** I replaced the solvency assertion with a tautology
(`(asserts! true ERR-REPAY-FAILED)`) in the simnet copies of `flashstack-stx-core`,
`flashstack-sbtc-core` and `flashstack-pool-v3`, re-ran their suites, and restored the
files. Result: **3 failed, 34 passed.**

The three that failed are exactly the adversarial ones:

- `flashstack-stx-core-reserve.test.ts` — "repay-or-revert: a receiver that keeps the funds reverts, and the reserve is untouched"
- `flashstack-sbtc-core-reserve.test.ts` — "repay-or-revert: a receiver that keeps the sBTC reverts, and the reserve is untouched"
- `flashstack-pool-v3.test.ts` — "a receiver that never repays reverts the whole transaction"

**The "happy path: reserve grows by exactly the fee" tests did NOT fail.** That is the
useful part of this exercise: a well-behaved receiver repays whether or not the protocol
checks, so happy-path tests observe the invariant without proving it. Only three tests
in the entire suite actually hold this property up (165 tests when this mutation run was done; 176 as of 2026-09-16 — the three adversarial tests are unchanged). That is thin coverage for
the single property the protocol's safety rests on, and it is a concrete, cheap thing to
deepen before the audit — partial repayment (short by one unit), over-repayment, repayment
by a third party rather than the receiver, and repayment of the wrong asset are all
untested. Tracked in `Flashstack-ajv.1.3`.

## 6. What the invariant assumes — and therefore does not protect

The invariant is only as strong as these assumptions. Each is a place an auditor
should press.

1. **The balance reading is honest.** For STX this is chain-native. For a SIP-010
   token it is a `contract-call?` into the *token contract*, which for a hostile or
   buggy token is attacker-controlled code. A token whose `get-balance` lies, or that
   re-enters, breaks the measurement. `contracts/test/malicious-token.clar` exists to
   probe this. **This is the main reason `flashstack-pool-v3` — which accepts
   registered arbitrary assets — is a materially larger attack surface than the
   single-asset STX/sBTC cores.**
2. **The asset cannot be moved out by a second path during the callback.** The
   invariant compares two snapshots; anything that legitimately reduces the balance
   between them (a withdrawal, another loan) is invisible to it. This is precisely
   what finding pv3-F1 was about, and why `pool-v3` holds a per-asset lock.
3. **Nothing else changes the accounting between the snapshots.** A reentrant
   `deposit` during the callback raises `B_after` without the receiver having repaid —
   again pv3-F1.
4. **`fee` is computed before the callback** and cannot be lowered by the receiver.
   Verified: `fee` is bound in the `let` at entry, and `set-fee-basis-points` is
   admin-gated.
5. **Atomic revert semantics hold.** A Clarity/Stacks-level guarantee, not a
   FlashStack one. If it ever failed, the design fails with it.
6. **The invariant says nothing about fairness between LPs.** Share pricing,
   first-depositor inflation (F-1) and oracle scale (F-2) are *separate* properties.
   A pool can satisfy this invariant perfectly while an LP is robbed on deposit.
   This is a very common misreading and is worth stating to the auditor explicitly.
7. **It says nothing about admin authority.** The admin can withdraw the reserve by
   design. The invariant protects against borrowers, not against the admin key. See
   `docs/security/ADMIN_CUSTODY_MODEL.md`.
