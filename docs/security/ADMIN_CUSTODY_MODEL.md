# Admin & Custody Security Model

**Owner:** Security & Contract Lead · **Evidence date:** 2026-09-15 · **Repo:** `436ea9c`

Who can do what, on which contract, with which key — and where that authority is
recoverable if it is used wrongly. All on-chain facts read via the public Hiro API.
**No key material was used, requested, or handled. Nothing in this document requires
touching a private key, and no recovery of an old key is proposed.**

---

## 1. The authority boundary

| Band | Principal | What it still controls |
|---|---|---|
| **OLD / precautionarily dead** | `SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ` (gen-1 deployer) | Nothing in the current system. Its contracts remain immutable and live; the traits it published are still referenced by the live contracts, but a trait confers no authority. |
| **OLD / precautionarily dead** | `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5` (gen-2 deployer) | Nothing. It *published* the live cores and pools, but publishing confers no ongoing rights in Clarity, and `get-admin` on each of its contracts returns the secure wallet, not itself. **VERIFIED.** |
| **CURRENT / live** | `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG` (secure admin wallet) | `admin` of record on **all six** live cores and pools, across both deployers. Also the deployer of the v2 pools and oracle-v2. |
| **UNDEPLOYED / audit target** | n/a | `flashstack-pool-v3`, `flashstack-{stx,sbtc}-pool-v3`, `flashstack-sbtc-core-v2` — admin will be whoever publishes them. |

> **FACT.** `get-admin` returned the same principal on `flashstack-stx-core`,
> `flashstack-sbtc-core`, `flashstack-stx-pool`, `flashstack-sbtc-pool`,
> `flashstack-stx-pool-v2` and `flashstack-sbtc-pool-v2`:
> `0x070516309b5d55d9bb1cb6b857450acd8a2fc338982930` → `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG`.
>
> This **matches Matt's handover** ("v2 secure admin wallet"). Rotation is complete
> on every live contract checked — not partially applied.

**Single point of failure (INFERENCE, stated plainly):** that is one hot key with
admin rights over the entire live protocol, including reserve withdrawal. There is no
multisig, no timelock and no separation between "pause" authority and "move the money"
authority. That is a reasonable posture for a ~75 STX reserve and an unfunded LP pool;
it is not a posture that survives meaningful TVL. It should be an explicit item in the
audit scope, and a decision for Matt — not something to change unilaterally.

## 2. What admin can and cannot do

**Can** (every one of these is `asserts! (is-eq tx-sender (var-get admin))`):

| Power | Function | Where |
|---|---|---|
| Move the reserve out | `withdraw-reserve` | cores |
| Fund the reserve | `deposit-reserve` | cores |
| Halt the protocol | `set-paused` | cores + pools |
| Change the fee | `set-fee-basis-points` | cores + pools |
| Change the loan cap | `set-max-single-loan` | cores + pools |
| Gate who may borrow | `add-approved-receiver` / `remove-approved-receiver` | cores + pools |
| Hand over control | `transfer-admin` (`set-admin` on `flashstack-sbtc-core`) | cores + pools |

**Cannot:** mint, alter an in-flight loan, seize LP shares, or withdraw LP deposits.
LP `withdraw` is **not** admin-gated — verified by reading the deployed source of
`flashstack-stx-pool-v2`, where `withdraw` asserts only on the caller's own share
balance. It is also **not** pause-gated, which is correct — even total loss of the admin key,
or an admin who pauses everything, leaves LPs able to withdraw.

> **Pause is narrower than it sounds.** `set-paused` gates `flash-loan` only. On
> **every** live pool — v1 and v2 — `deposit` asserts nothing but `amount > u0`.
> Pausing a pool does not close it to new money. See `Flashstack-ajv.4.5`; the
> undeployed `flashstack-pool-v3` corrects this.

**Oracle authority: none.** `flashstack-pool-oracle` and `flashstack-pool-oracle-v2`
expose **zero public functions** — verified from their deployed interfaces. They are
pure read-throughs over a pool address fixed as a `define-constant` at publish time.
There is no admin, no setter, no push-feed and therefore no oracle-manipulation surface
*in the oracle itself*. The oracle's integrity is entirely the integrity of the pool's
share accounting, which is a different problem (F-1 / F-2 / pv3-F2).

## 3. BC1 — one-step admin transfer, re-verified

**WHAT.** On the live contracts, `transfer-admin` (or `set-admin`) writes the new admin
**immediately**, and is itself gated by the admin var it just overwrote.

**RISK.** A single mistyped or uncontrolled principal permanently bricks pause, fee,
loan-cap and receiver-allowlist governance, with **no** on-chain recovery. It is not
reachable by an attacker — only the current admin can call it — so this is a
trusted-operator footgun, not an exploit. Severity comes from irreversibility, not
from likelihood.

**Which live contracts still have it — VERIFIED from deployed interfaces, 2026-09-15:**

| Contract | Transfer fn | `accept-admin` present? | Status |
|---|---|---|---|
| `flashstack-stx-core` | `transfer-admin` | **No** | **Vulnerable** |
| `flashstack-sbtc-core` | `set-admin` | **No** | **Vulnerable** |
| `flashstack-stx-pool-v2` | `transfer-admin` | **No** | **Vulnerable** |
| `flashstack-sbtc-pool-v2` | `transfer-admin` | **No** | **Vulnerable** |
| `flashstack-stx-pool` (v1) | `transfer-admin` | **No** | Vulnerable but paused & empty |
| `flashstack-sbtc-pool` (v1) | `transfer-admin` | **No** | Vulnerable but paused & empty |

**Which successors have the fix — all UNDEPLOYED:**

| Contract | Fix | Source |
|---|---|---|
| `flashstack-sbtc-core-v2` | `set-admin` proposes; `accept-admin` commits | `contracts/flashstack-sbtc-core-v2.clar:166,175` |
| `flashstack-stx-pool-v3` | `transfer-admin` + `accept-admin` | `contracts/flashstack-stx-pool-v3.clar:230,239` |
| `flashstack-sbtc-pool-v3` | `transfer-admin` + `accept-admin` | `contracts/flashstack-sbtc-pool-v3.clar:220,229` |
| `flashstack-pool-v3` | `transfer-admin` + `accept-admin` | `contracts/flashstack-pool-v3.clar:150,160` |

**Proven by test:** `tests/bc1-admin-lockout.test.ts` demonstrates the lockout against
`flashstack-sbtc-pool-v2` (a faithful copy of the mainnet contract — confirmed by diff);
`tests/bc1-two-step-fix.test.ts` proves all three successors resist the same sequence
and stay recoverable.

**Operational mitigation available today (no deploy required):** BC1 is only triggered
by calling the transfer function. So the mitigation is procedural — treat
`transfer-admin`/`set-admin` on a live contract as a change-controlled operation:
never issued ad hoc, the target principal proven controllable by signing something
with it first, and the call reviewed by a second person. That belongs in
`Flashstack-ajv.6` (Mainnet Change-Control Process). **RECOMMENDATION:** until the
successors are deployed, the correct posture is "this function is not to be called",
written down, rather than "we'll be careful".

**Does the current state match Matt's handover?** Yes on rotation — admin is the secure
wallet everywhere. No on remediation — the handover framing that BC1 was "fixed" is true
of the repository and **false of mainnet**. Every live contract still has the one-step
behavior, because the fixed successors have never been published.

## 4. Follow-ups

- `Flashstack-ajv.4.1` — the `flashstack-stx-core` simnet copy carries the two-step fix,
  so the test suite exercises admin behavior the mainnet contract does not have.
- `Flashstack-ajv.6` — change-control process, including the BC1 procedural mitigation.
- `Flashstack-ajv.4.4` — disposition of the v1 pools and the still-answering v1 oracle.
- Open question for Matt: multisig / timelock on the admin key before LP deposits open.
