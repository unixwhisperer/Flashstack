# FlashStack Roadmap

FlashStack is the **neutral flash-liquidity rail for Bitcoin DeFi** — atomic, uncollateralized STX and canonical-sBTC loans any Clarity contract can integrate, on Stacks today. It is one half of a two-product effort: **[DeepStack](https://github.com/mattglory/deepstack)**, an AI market-making agent, is FlashStack's first customer and its growth engine. Flash loans already exist on Stacks inside lending markets (Zest, since Dec 2024); FlashStack's role is different and complementary — standalone, open liquidity you don't have to join a lending market to use.

*Last updated: 2026-07-25.*

---

## Where it stands today (honest snapshot)

- **Live on mainnet:** STX + canonical sBTC flash-loan engines, LP pools, a collateral oracle, and a receiver library.
- **Tested:** 254 passing tests covering every deployed contract (both invariants + all guards).
- **Capital:** reserve is ~75 STX and the LP pools are effectively unfunded — **reserve size is the hard ceiling** on what the protocol can serve.
- **Trust:** not yet professionally audited; receivers are approval-gated (permissioned beta).
- **Usage:** DeepStack runs a live pilot rebalancing through FlashStack — the flywheel, proven on mainnet in a single atomic transaction.

---

## Shipped

**Protocol**
- [x] STX + canonical-sBTC flash-loan engines (reserve model, Aave-style live-balance solvency invariant)
- [x] LP pools (deposit → shares → yield from fees) + `flashstack-pool-oracle` collateral feed
- [x] Flash receiver trait standard (SIP-compatible)
- [x] Independent security-review findings resolved; deployer key rotated (2026-06-12)

**Testing & security**
- [x] 254-test suite across every deployed contract (invariants + guards, fully offline)
- [x] Internal security review documented (trust model, reentrancy reasoning, findings)
- [x] LP-pool share-inflation hardening (v2 pools, virtual shares/assets) — built + proven by test, ready to deploy

**Ecosystem**
- [x] Receiver library — Bitflow / Velar / ALEX arbitrage, liquidation, collateral swap, and templates
- [x] Auto-compounding yield vault (audit-hardened)
- [x] DeepStack integration — first live DeepStack → FlashStack → Bitflow flash-rebalance on mainnet

**Product & funding**
- [x] Live app ([flashstack.vercel.app](https://flashstack.vercel.app)) — flash loans, LP pool, arb UI, live on-chain stats
- [x] Stacks Endowment grant — M1–M3 complete

---

## Next — audit-readiness → audit → capital

The one ordering that matters: **security audit → LP deposits → reserves → capacity.**

1. [x] Deploy the **hardened v2 LP pools** (virtual-shares protection) before opening real LP deposits; migrate any v1 liquidity first — **done**: `flashstack-stx-pool-v2` and `flashstack-sbtc-pool-v2` are live at `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG`; both v1 pools are drained and paused
2. [x] Matching `flashstack-pool-oracle-v2` for the STX pool (oracle/pool math consistency) — **done**: live at `SPR9PQAN…`
3. [ ] CI gating — tests + `clarinet check` required on every PR — *workflow added (PR #44), but "required" is a branch-protection setting that cannot be read from this repository; unchecked until confirmed in repo settings*
4. [ ] **Professional third-party audit** + bug bounty
5. [ ] **Remove the receiver whitelist → fully permissionless** (post-audit — the core's solvency does not depend on the whitelist)
6. [ ] Grow LP deposits → lift the reserve/capacity ceiling

---

## Ecosystem & partnerships

- **Bitflow** — DeepStack market-makes Bitflow's sBTC pairs and FlashStack routes flash-rebalance/arb volume into their pools. Design-partner relationship.
- **Zest** (active; Tycho engaged) — two complementary threads:
  - *DeepStack ↔ Zest:* manage liquidity for **USDCx**, Zest's single largest exposure (~$5.5M in their vault) whose thin DEX depth quietly caps its use as a collateral/borrow asset. Deeper USDCx markets mean cleaner liquidations and better entry/exit for Zest users. This is the needle-mover.
  - *FlashStack ↔ Zest:* the **authorised-integrator pattern** ([ZEST_INTEGRATION_SPEC.md](docs/ZEST_INTEGRATION_SPEC.md)) — FlashStack's *separate* STX/sBTC reserves let contract-based liquidators work against `v0-4-market` **without touching Zest's own vault liquidity**. Blocked only on Zest relaxing the `contract-caller == tx-sender` check on their side; the leverage-loop receiver is already in the repo. Not a duplicate of Zest's native vault flash loans — a complement.

## The vault / AUM future

- The LP pools and the auto-compounding yield vault are the on-chain **primitives**.
- **DeepStack's non-custodial AUM vaults** — managing others' liquidity for a management + performance fee — are the **scalable business** those primitives feed into. This is where FlashStack-as-infrastructure turns into revenue at scale.
- Perps order-book market-making on Velar (DeepStack's unclaimed niche) — gated pending the pilot scaling.

---

## Decentralization

- **Receiver whitelist** is defense-in-depth during the unaudited beta — *not* what guarantees solvency (the Aave-style balance invariant is). It is designed to be **removed after the security audit**, making the protocol permissionless like Aave. That is a launch milestone, not a quiet edit.
- **Governance token:** deferred. A token is premature at this stage and a distraction from the real work — audit, traction, and the vault business come first.

---

## Long-Term Vision

FlashStack aims to be the neutral flash-liquidity rail for Bitcoin DeFi — on Stacks today, expanding to other Bitcoin L2s as the ecosystem matures.

**The flywheel:** DeepStack rebalances through FlashStack flash loans — *DeepStack volume → FlashStack fees → LP yield → deeper reserves → more DeepStack capacity.*

The protocol is designed to be:
- **Open & composable** — any Clarity contract can be a receiver; approval-gated during the unaudited beta, permissionless after a security audit
- **Solvency-safe by design** — the core measures its reserve balance before and after every callback and reverts unless it grows by the fee (Aave-style invariant)
- **Capital efficient** — zero idle capital for borrowers, continuous yield for LPs
- **Bitcoin-native** — settles in STX and canonical sBTC on Stacks

---

## What this project is *not* doing (deliberately)

- **Not racing to be "first."** Flash loans already exist on Stacks (Zest). The edge is neutral, composable liquidity plus the execution layer (DeepStack) on top — not primitive novelty.
- **Not shipping a governance token yet** — premature.
- **Not duplicating Zest's native vault flash loans.** Where FlashStack complements Zest is *separate* reserves + the authorised-integrator pattern (see Ecosystem above), not re-offering a capability they already have.

---

*Reality check: the reserve is ~75 STX and the LP pools are unfunded, so the 100k-STX-scale targets are aspirational, not forecasts. The deployed v1 LP pools should be replaced by the hardened v2 pools before they hold meaningful deposits. Nothing here is a promise of returns.*
