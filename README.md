# FlashStack

**Open flash-liquidity infrastructure for Bitcoin Layer 2**

[![Status](https://img.shields.io/badge/Status-Mainnet%20Live-brightgreen)]()
[![Tests](https://img.shields.io/badge/Tests-254%20Passing-success)]()
[![Clarity](https://img.shields.io/badge/Clarity-3-F7931A)]()
[![Live](https://img.shields.io/badge/App-flashstack.vercel.app-F7931A)](https://flashstack.vercel.app)
[![License](https://img.shields.io/badge/License-MIT-yellow)]()

> Atomic, uncollateralized flash loans on Stacks (Bitcoin L2). Borrow STX or canonical sBTC with zero collateral, run any on-chain strategy, and repay — all in a single transaction. If repayment fails, the whole transaction reverts. Zero risk to the protocol.

FlashStack is neutral, standalone flash-liquidity any Clarity contract can integrate — no lending market to join. It is also the rail behind **[DeepStack](https://github.com/mattglory/deepstack)**, a Bitcoin-native market-making agent that rebalances through it:

> **DeepStack volume → FlashStack fees → LP yield → deeper reserves → more DeepStack capacity ↻**

The first live DeepStack → FlashStack → Bitflow flash-rebalance ran on mainnet in [one atomic transaction](https://explorer.hiro.so/txid/0x1f826abe4668f3c8f04b93d0113d1e00b1f52280fa0fff285b8be02e4878b097?chain=mainnet).

---

## How it works

**Flash loan.** Call `flash-loan(amount, receiver)` on a core. The core sends the asset to your receiver, invokes its callback, and requires the reserve to grow by at least the fee before the transaction ends — otherwise everything reverts. Repayment is never trusted; it is *measured*. This is the Aave live-reserve model, so a malicious receiver can only fail, never drain the pool.

**LP pool.** Anyone deposits STX or sBTC and receives shares. Every flash-loan fee stays in the pool, so each share appreciates. Withdraw principal + accrued yield anytime. Share value is exposed to lending protocols via a collateral oracle (`get-share-price` / `get-lp-value`).

Fee: **0.05%** per loan. Assets: **STX** and **canonical sBTC** (`SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`).

---

## Live app

**[flashstack.vercel.app](https://flashstack.vercel.app)**

- **Flash Loan** — borrow STX or canonical sBTC with zero collateral
- **LP Pool** — deposit, earn yield from every flash-loan fee
- **Dashboard** — live on-chain protocol stats
- **Receivers** — deployed strategy contracts and build-your-own templates

---

## Mainnet contracts

**Flash-loan engines & receivers** — `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5`

| Contract | Description |
|----------|-------------|
| [`flashstack-stx-core`](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core?chain=mainnet) | STX flash-loan engine (reserve model) |
| [`flashstack-sbtc-core`](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-sbtc-core?chain=mainnet) | Canonical sBTC flash-loan engine |
| [`bitflow-arb-receiver-v4`](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.bitflow-arb-receiver-v4?chain=mainnet) | Bitflow STX/stSTX arbitrage |
| [`velar-sbtc-arb-receiver`](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.velar-sbtc-arb-receiver?chain=mainnet) | Velar wSTX↔sBTC arbitrage |
| [`zest-liquidation-receiver`](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.zest-liquidation-receiver?chain=mainnet) | Zero-capital Zest liquidator (4 modes) |
| [`alex-arb-receiver-v2`](https://explorer.hiro.so/address/SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.alex-arb-receiver-v2?chain=mainnet) | ALEX STX/ALEX arbitrage |
| `stx-test-receiver` / `sbtc-test-receiver` | Minimal borrow-and-repay receivers |

**Hardened LP pools & oracle (v2)** — `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG`

| Contract | Description |
|----------|-------------|
| [`flashstack-stx-pool-v2`](https://explorer.hiro.so/address/SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-stx-pool-v2?chain=mainnet) | STX LP pool — virtual-shares hardened |
| [`flashstack-sbtc-pool-v2`](https://explorer.hiro.so/address/SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-sbtc-pool-v2?chain=mainnet) | sBTC LP pool — virtual-shares hardened, built-in oracle |
| [`flashstack-pool-oracle-v2`](https://explorer.hiro.so/address/SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-pool-oracle-v2?chain=mainnet) | STX collateral oracle |

> The v2 pools add virtual shares/assets (OpenZeppelin ERC-4626 style) against first-depositor share inflation. The earlier v1 pools are deprecated.

---

## Security

**Status: mainnet, not yet professionally audited. Use at your own risk.**

- **Solvency invariant** — every core/pool measures its asset balance before and after the receiver callback and reverts unless it grew by at least the fee. This is what makes an arbitrary receiver safe.
- **254-test suite** (Vitest + Clarinet simnet) covering every deployed contract — both invariants and every guard. The suite runs against the localized simnet copies under `contracts/test/`, not the canonical sources; see `docs/security/CONTRACT_INVENTORY.md` §5 (D6).
- **Internal security review** — see the trust model, per-contract analysis, and findings register (kept local until remediation). Two findings were fixed and proven by test: **F-1** (LP share inflation → virtual-shares v2 pools) and **F-2** (oracle scale consistency).
- **Access control** — admin can deposit/withdraw reserve, pause, and set parameters; it cannot mint, alter loans, or seize LP funds. The receiver whitelist is defense-in-depth during the unaudited beta and is designed to be removed post-audit (permissionless, like Aave).

A professional third-party audit is the top priority before opening real LP deposits.

---

## Quick start

```bash
git clone https://github.com/mattglory/Flashstack.git
cd flashstack
npm install
npm test          # 254 tests passing
npm run check     # clarinet check — type-checks contracts registered in Clarinet.toml
                  # (script-deployed receivers aren't in the project; see docs/BUILD_A_RECEIVER.md)

cd web && npm install && npm run dev   # frontend at http://localhost:3000
```

**Requirements:** Node.js 18+, [Clarinet](https://github.com/hirosystems/clarinet) 2.0+.

> Scripts read wallet mnemonics from the environment only. Never hardcode or commit a mnemonic.

---

## Build a receiver

Any Clarity contract implementing the receiver trait can borrow. New to Clarity? Start with the [New Developer Walkthrough](docs/NEW_DEVELOPER_WALKTHROUGH.md).

```clarity
(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    (fee-bp     (unwrap! (contract-call? 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core get-fee-basis-points) (err u500)))
    (fee        (let ((raw (/ (* amount fee-bp) u10000))) (if (> raw u0) raw u1)))
  )
    ;; ...your strategy here — `amount` STX is already in this contract...
    (unwrap! (as-contract (stx-transfer? (+ amount fee) tx-sender core)) (err u500))
    (ok true)
  )
)
```

Deploy to mainnet, then open a [GitHub issue](https://github.com/mattglory/Flashstack/issues) with your contract address to get whitelisted. Full templates: [BUILD_A_RECEIVER.md](docs/BUILD_A_RECEIVER.md) · [TESTING_GUIDE_STX.md](docs/TESTING_GUIDE_STX.md) · [TESTING_GUIDE_SBTC.md](docs/TESTING_GUIDE_SBTC.md).

---

## Confirmed mainnet flash loans

| Asset | Type | Tx |
|-------|------|-----|
| STX | DeepStack flash-rebalance (borrow → Bitflow swap → repay) | [`0x1f826abe…`](https://explorer.hiro.so/txid/0x1f826abe4668f3c8f04b93d0113d1e00b1f52280fa0fff285b8be02e4878b097?chain=mainnet) |
| STX | Bitflow STX/stSTX round-trip | [`0xabd33fc4…`](https://explorer.hiro.so/txid/0xabd33fc46ffa204ce61f25664f057e414063f28ce75c8387a6df9116453110cb?chain=mainnet) |
| sBTC | Canonical sBTC borrowed & repaid atomically | [`0x67f0c77d…`](https://explorer.hiro.so/txid/0x67f0c77d9d7ab9762c08a3638ba0990d5bbc3d19db8adc1a0d616cd7170f9baa?chain=mainnet) |

---

## Roadmap

See **[ROADMAP.md](ROADMAP.md)** — audit-readiness → audit → deploy v2 → LP deposits, the vault/AUM future, and permissionless-post-audit.

## License

[MIT](./LICENSE)

---

**Built by Glory Matthew** — [@flashstackbtc](https://x.com/flashstackbtc) · [GitHub](https://github.com/mattglory) · [mattglory14@gmail.com](mailto:mattglory14@gmail.com)
