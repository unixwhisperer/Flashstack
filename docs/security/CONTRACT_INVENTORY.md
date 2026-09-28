# FlashStack Contract Inventory & Deployment Map

**Owner:** Security & Contract Lead
**Evidence date:** 2026-09-15 (all on-chain facts re-read on this date)
**Repo state:** branch `security-lead/ci-gating-and-onboarding` @ `436ea9c`

Every "deployed" claim below was established by querying the public Hiro API
(`GET /extended/v1/contract/<principal>.<name>` for existence,
`GET /v2/contracts/interface|source/...` for shape, `POST /v2/contracts/call-read/...`
for live state). Nothing here is taken from README prose. Where the repo's
documentation disagrees with the chain, **both are recorded** and the discrepancy
is filed as a bead rather than silently resolved.

No key material was used or requested. All reads are public and unauthenticated.

---

## 1. Deployer / custody principals

| Principal | Role | Status |
|---|---|---|
| `SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ` | **Generation-1 deployer.** Published the original `flashstack-core` flash-*mint* system, `sbtc-token`, the `flash-receiver-trait` and `stx-flash-receiver-trait`, and the gen-1 receiver library. | Legacy. Treated as precautionarily dead. Its contracts are immutable and still resolve on chain. |
| `SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5` | **Generation-2 deployer.** Published the live reserve-model cores, the v1 LP pools + oracle, and the live receiver library. | Legacy as a *key*; its **contracts are the live system**. Admin rights on them have been rotated away (see §4). |
| `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG` | **Current secure admin wallet.** Published the hardened v2 pools + oracle-v2, and is the `admin` of record on every live FlashStack contract checked. | Current. |

> **VERIFIED.** `get-admin` on all six live cores/pools returns the same principal,
> `SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG`. Admin authority is therefore **not**
> held by either deployer key. This is consistent with ROADMAP's "deployer key
> rotated (2026-06-12)".

---

## 2. V2 / LIVE — the current production surface

All confirmed live on Stacks mainnet 2026-09-15. Live state read on the same date.

| Contract | Principal | Holds funds | Live state | Admin model | Notes |
|---|---|---|---|---|---|
| `flashstack-stx-core` | `SP20XD46…` | **Yes** — STX reserve **75.190500 STX** | `paused=false`, 17 loans, 190,500 µSTX fees (0x2e824) | one-step `transfer-admin` | The STX flash-loan engine. Reserve model. See §5 discrepancy. |
| `flashstack-sbtc-core` | `SP20XD46…` | **Yes** — sBTC reserve | `paused=false`, 3 loans, 21,000 sats volume | one-step `set-admin` | Canonical-sBTC engine. Different admin fn name from stx-core. |
| `flashstack-stx-pool-v2` | `SPR9PQAN…` | **Yes** — 1.000000 STX | `paused=false`, shares 1e12 (virtual) | one-step `transfer-admin` | Virtual-shares hardened LP pool. |
| `flashstack-sbtc-pool-v2` | `SPR9PQAN…` | **Yes** — 44,990 sats | `paused=false` | one-step `transfer-admin` | Virtual-shares hardened, built-in oracle. |
| `flashstack-pool-oracle-v2` | `SPR9PQAN…` | No | read-only, no public fns | none (immutable `POOL` constant) | Reads `flashstack-stx-pool-v2`. |
| `flashstack-yield-vault-v5` | `SP20XD46…` | Yes (vault) | not yet reviewed | not yet reviewed | Out of scope for this pass — filed for later review. |

**Live receiver library** (`SP20XD46…`), all confirmed on chain, none hold protocol funds — they hold only transient loan proceeds inside a single transaction:
`bitflow-arb-receiver-v4`, `velar-sbtc-arb-receiver`, `zest-liquidation-receiver`,
`alex-arb-receiver-v2` / `-v3` / `-v4` / `-v5`, `stx-test-receiver`, `sbtc-test-receiver`.

**Traits (immutable, load-bearing):**
`SP3TGRVG….stx-flash-receiver-trait` (used by the live STX core and both STX pools) and
`SP20XD46….sbtc-flash-receiver-trait` (used by the sBTC core and pools).
> **INFERENCE (low risk):** the STX trait living on the *generation-1* key is not a
> security exposure — traits are immutable and carry no authority — but it does mean
> the live system permanently references a contract published by a key that is
> otherwise treated as dead. Worth stating to the auditor rather than discovering.

---

## 3. V1 / LEGACY

| Contract | Principal | Live? | State | Disposition |
|---|---|---|---|---|
| `flashstack-stx-pool` | `SP20XD46…` | Yes | **`paused=true`, balance 0, shares 0** | Deprecated. Drained and paused **for loans only** — `deposit` is still reachable (`Flashstack-ajv.4.5`). |
| `flashstack-sbtc-pool` | `SP20XD46…` | Yes | **`paused=true`, balance 0, shares 0** | Deprecated. Drained and paused **for loans only** — `deposit` is still reachable (`Flashstack-ajv.4.5`). |
| `flashstack-pool-oracle` | `SP20XD46…` | Yes | read-only | **Deprecated but still answering.** Reads the paused, empty v1 STX pool. |
| `flashstack-core` | `SP3TGRVG…` | Yes | not reviewed | Gen-1 flash-**mint** design (supply-equality invariant, not reserve-balance). Superseded. |
| `sbtc-token` | `SP3TGRVG…` | Yes | not reviewed | **A FlashStack-published token named `sbtc-token` that is NOT canonical sBTC.** Canonical sBTC is `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`. Naming-confusion risk. |
| `snp-flashstack-receiver`, `snp-flashstack-receiver-v3` | `SP3TGRVG…` | Yes | — | Legacy gen-1 SNP integration receivers, bound to the gen-1 core. **Source is now in the repo, verbatim** (D7, closed 2026-09-21). Both contain mock vault placeholders, and v3's `remove-vault` is a no-op stub (`is-not-removed-vault` always returns `true`). Immutable; not in the audit scope. |
| gen-1 receivers (`dex-aggregator-receiver`, `liquidation-receiver`, `collateral-swap-receiver`, `multidex-arbitrage-receiver`, `leverage-loop-receiver`, `yield-optimization-receiver`, `example-arbitrage-receiver`, `test-receiver`) | `SP3TGRVG…` | Yes | — | Legacy; bound to the gen-1 core. |

**Deployment scars** (aborted publishes, useful context for an auditor reading the chain):
`flashstack-stx-core` ×3, `flashstack-sbtc-core` ×2, `usda-vault-rescue-receiver` ×5,
`arkadiko-liquidation-receiver` ×2, `flashstack-yield-vault` v1–v3, `bitflow-arb-receiver-v2`,
`alex-arb-receiver`, plus several `dbg*` / `stx-core-test*` probes. These are
`abort_by_response`, i.e. they never took effect, but they do consume the contract name
forever at that principal — which is why several contracts carry a version suffix.

---

## 4. POOL-V3 / AUDIT TARGET — undeployed

**VERIFIED NOT DEPLOYED** at either `SP20XD46…` or `SPR9PQAN…` (404 on both):

| Contract | Repo path | Purpose |
|---|---|---|
| `flashstack-pool-v3` | `contracts/flashstack-pool-v3.clar` | Generic multi-asset flash-loan + LP pool. The intended audit target. |
| `flashstack-stx-pool-v3` | `contracts/flashstack-stx-pool-v3.clar` | BC1 two-step-admin successor to the STX pool. |
| `flashstack-sbtc-pool-v3` | `contracts/flashstack-sbtc-pool-v3.clar` | BC1 two-step-admin successor to the sBTC pool. |
| `flashstack-sbtc-core-v2` | `contracts/flashstack-sbtc-core-v2.clar` | BC1 two-step-admin successor to the sBTC core. |

**Consequence to state plainly:** the BC1 one-step-admin-transfer fix exists **only in
the repository**. Every contract that is actually live today still has the one-step
behavior. See `docs/security/ADMIN_CUSTODY_MODEL.md`.

---

## 5. Recorded discrepancies (repo docs vs chain vs code)

Each is filed as a bead. None is silently resolved here.

**Status re-verified 2026-09-16** against `origin/main` @ `ccdfff8` (clarinet 3.23.2,
`npm ci` from the committed lockfile). Statuses are evidence-based, not aspirational.

| # | Discrepancy | Evidence | Status (2026-09-16) | Bead |
|---|---|---|---|---|
| D1 | `Clarinet.toml` states `contracts/test/flashstack-stx-core.clar` is "byte-identical" to the mainnet contract. It is not: the local copy adds the BC1 two-step admin transfer (`pending-admin` + `accept-admin`), extra error constants, `print` events, and a `calculate-fee` that now rejects `u0`. The mainnet interface has `transfer-admin` and **no** `accept-admin`. | diff of Hiro `/v2/contracts/source` output vs the local file; interface listing | **FIXED** (PR #45). Copy restored verbatim; hardened variant preserved as `flashstack-stx-core-v2`. Re-verified: `tests/mainnet-fidelity.test.ts` (9 tests) passes and pins the one-step shape for all six live contracts. Recorded as **F-7**. | `Flashstack-ajv.4.1` |
| D2 | README badge + Security section claim a **128**-test suite; ROADMAP claims **125**. Actual: **165 passing across 16 files** (`npm test`, 2026-09-15). | test run output | **FIXED 2026-09-16.** The D2 row itself had also gone stale: the true figure is now **176 passing across 17 files**, counted at runtime (`vitest --reporter=json`), not by grepping `it(` — several suites generate tests in a loop, so a static grep undercounts. README (badge, Security bullet, Quick start), ROADMAP (×2), `AUDIT_BRIEF.md` and `FLASH_LOAN_INVARIANT.md` all corrected. | `Flashstack-ajv.7.1` |
| D3 | `docs/AUDIT_BRIEF.md` item 4 says v1 and v2 pools are "both listed as live in the README's mainnet contract table". No longer true — README now lists only v2 and calls v1 deprecated. My own brief is stale. | README §Mainnet contracts | **FIXED 2026-09-16.** `AUDIT_BRIEF.md` item 4 corrected in place, with a pointer to §3 and F-6 so the v1 surface stays visible to the auditor rather than disappearing. | `Flashstack-ajv.7.1` |
| D4 | ROADMAP "Next" items 1 and 2 ask for the v2 pools and `flashstack-pool-oracle-v2` to be *deployed*. Both are already live at `SPR9PQAN…`. | Hiro contract API | **FIXED 2026-09-16.** Items 1 and 2 marked done with the live principal named. Item 3 (CI gating) deliberately left **unchecked**: the workflow exists (PR #44) but "required on every PR" is branch protection, which cannot be read from the repository — see §7. | `Flashstack-ajv.7.1` |
| D5 | `deployments/default.mainnet-plan.yaml` describes a gen-1 publish from `SP3TGRVG…`, and contains none of the live system. `/deployments/` is CODEOWNERS-protected, so it reads as authoritative. | file contents vs `find contracts` | **FIXED 2026-09-22 — archived.** After D7 closed (both SNP files committed verbatim), all 13 of this plan's paths resolved for the first time, turning a dead file into a genuinely runnable `clarinet deployments apply --mainnet` target — the filename `default.mainnet-plan.yaml` is the exact convention that flag auto-selects with no explicit path given. The "dies on a missing file" behavior had been doing safety work nobody designed for it; closing D7 removed it. Matt's disposition decision: **archive**, not delete — moved to `deployments/archive/gen1-mainnet-plan-2026-09-22.yaml` with a header explaining why, out of `deployments/` and off the auto-pickup filename, so the historical record of the gen-1 publish survives without being a live footgun. **Note:** `deployments/default.testnet-plan.yaml` has the identical all-paths-resolve shape (checked 2026-09-22) but is far lower-stakes — it targets the well-known public Clarinet deployer, a key nobody on this project holds, not a principal Matt controls. Left as-is; flagged here rather than acted on. | `Flashstack-ajv.7.2` |
| D6 | `clarinet check` covers 38 contracts; 70 `.clar` files exist. The 32 uncovered include `contracts/flashstack-pool-v3.clar` and the other v3/v2 successors — i.e. the audit/deploy targets are not type-checked by the CI gate. | `clarinet check` output vs `Clarinet.toml` registry | **PARTIALLY CLOSED (PR #48, 2026-09-18) — closes the receiver-library half, structural half still open.** PR #48 registered 20 previously-uncovered receiver contracts (17 land clean; 3 excluded with explicit comments for genuine `clarinet check` failures — arkadiko/usda read-only-vs-write mismatches, a zest-v2 type mismatch) plus the 46 external `requirements` those receivers call. FlashStack-owned registered contracts go **39 → 55**; the "209/210 contracts checked" figure some CI output shows is cache-state dependent and ~154 of it is third-party (ALEX/Zest/Arkadiko/Pyth/StackingDAO/…) — not a coverage metric for our own code, per Hillary's review on #48. **Structural half untouched:** all 14 funds-bearing contracts (both cores, all six pools, both oracles, `flashstack-pool-v3`, the v3 receiver trait) still resolve in `Clarinet.toml` to their `contracts/test/` localized copies, not the canonical `contracts/*.clar` an auditor would read and a deployment would publish. Clarinet keys contracts by name, so both can't be registered under one name — needs a second manifest/CI job or a restructure. See §7.3. `#53`'s drift guard is the current (weaker) substitute for real type-checking on the canonical sources. | `Flashstack-ajv.2.3` |
| D7 | Source for the live `snp-flashstack-receiver` / `-v3` is absent from the repo. | contract live at `SP3TGRVG…`; no matching file | **FIXED 2026-09-21.** Both sources are now committed verbatim. Each is **byte-identical to the deployed contract**, checked against `GET /v2/contracts/source/SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ/<name>`: `snp-flashstack-receiver` 3,270 bytes, sha256 `0722955560dbd791d5c3a29c84e1787e4a250df88db5ece6d27be768a0b920ea`; `snp-flashstack-receiver-v3` 5,396 bytes, sha256 `2560814d0e0103d2e8fcb337fc560cdbc5c39215828b81606712ab82ffb3fdec`. They had existed on the maintainer's machine but were gitignored as "stale experiment contracts", which is why the 2026-09-16 review found no source; they are not in `mattglory/snp-mvp` either (default branch checked). `tests/deployed-source-pins.test.ts` pins both hashes, so an edit to either file fails CI: an edit would be drift from an immutable contract, the F-7 shape. Re-verify with `curl -s <url> \| jq -j .source \| shasum -a 256`. | `Flashstack-ajv.7.2` |


---

## 6. What is NOT yet established

- `flashstack-yield-vault-v5` — live, holds funds, not reviewed.
- The current approved-receiver whitelist on each live core (enumerable only per-principal via `is-approved-receiver`; needs a candidate list).
- Whether `flashstack-pool-oracle` (v1) has external consumers who would be misled by a share price derived from an empty, paused pool.

---

## 7. Open decisions for the project owner

These are blocked on a judgement call or on access this checkout does not have.
None is a contract bug; all three gate the release/audit process.

### 7.1 Is branch protection actually on? (gates D4 item 3)

`.github/workflows/test.yml` runs `clarinet check` + the full suite on every PR to
`main`, and `CODEOWNERS` assigns `/contracts/`, `/deployments/`, `/.github/workflows/`
and `/Clarinet.toml` to the Security & Contract Lead. Both are real and in the tree.

Neither makes a merge *gate*. "Required status check" and "require review from Code
Owners" live in repository settings, which are not readable from a clone and not
readable without an admin token. Separate these four states and do not conflate them:

| | State | Verifiable here? |
|---|---|---|
| 1 | CI job exists | **Yes** — `.github/workflows/test.yml` |
| 2 | CI job passes | **Yes** — reproduced locally: `clarinet check` ✔ 39 contracts, 176/176 tests |
| 3 | CI job is *required* by branch protection | **No** — admin-side |
| 4 | Code-owner review is *required* | **No** — admin-side |

**Partially resolved 2026-09-17**, once the Security & Contract Lead had `gh` access.
Some protection on `main` is now **demonstrated, not assumed**: PR #53 has every
check green (`Test Smart Contracts`, `Build Frontend`, `Dependency Audit`, `CodeQL`
all SUCCESS) and is still `mergeStateStatus: BLOCKED` with
`reviewDecision: REVIEW_REQUIRED`. A PR cannot be green-and-blocked unless branch
protection is enforcing something. So **review is required on `main` today**, and
state (2) above is confirmed on real CI rather than only locally.

Two things remain genuinely unreadable without admin, and should not be inferred
from the above:

- **Whether `Test Smart Contracts` is a *required status check*.** Every entry in the
  PR's `statusCheckRollup` reports `isRequired: null`, which is what the API returns
  to a non-admin. A check can pass without being a merge gate.
- **Whether the required review must come from a Code Owner.** The PRs that
  demonstrated the block touch only `docs/`, `tests/` and `README.md` — none of the
  CODEOWNERS paths — so they show ordinary required review, not code-owner review.

`GET /repos/mattglory/Flashstack/rulesets` and `/rules/branches/main` both return
`[]`, so no **ruleset** protects `main`; the enforcement is classic branch
protection, which a non-admin cannot read (404, not 403). The Lead's access level is
`push`/`triage`, not `admin`.

The repository's history still shows this was **not** enforced for most of its life:
141 of 148 first-parent commits on `main` are direct non-merge commits, with 8 merge
commits total. **Action for Matt:** confirm in Settings → Branches whether `main`
requires the `Test Smart Contracts` check specifically, and whether review must come
from a Code Owner. Until then, treat only *required review* as established.

### 7.2 Disposition of `deployments/default.mainnet-plan.yaml` (D5) — RESOLVED 2026-09-22

**Decided: archive.** Moved to `deployments/archive/gen1-mainnet-plan-2026-09-22.yaml`,
with a header recording what it was and why it moved. The decision sharpened once D7
closed: committing the two SNP receiver sources made all 13 of this plan's paths
resolve for the first time, turning a file that used to die on a missing path into a
genuinely runnable `clarinet deployments apply --mainnet` target, since that flag
auto-selects a file literally named `default.mainnet-plan.yaml` with no explicit path
given. Delete was rejected — it's the only record anywhere of what the gen-1 key
actually published. A replacement plan describing the real live system was and is
not possible from here: that system was published across two principals over multiple
generations and no plan for it was ever committed.

### 7.3 How should canonical sources get type-checked? (D6)

Today `Clarinet.toml` maps every funds-bearing contract name to its
`contracts/test/` localized copy, so the canonical `contracts/*.clar` files — the
files an auditor will read and the files a deployment will publish — are compiled by
nothing. The copies differ only by address localization (verified pairwise), but
nothing *enforces* that; the existing `tests/mainnet-fidelity.test.ts` guard pins
behavioral shape for 6 contracts, not textual equivalence for all 14.

The two halves should not be confused:

- **The mechanical half** — proving each canonical/copy pair still differs only by
  `use-trait` localization — is cheap and is implementable as a test. Recommended,
  and not blocked on anything.
- **The structural half** — actually type-checking the canonical files — cannot be
  done by adding entries to `Clarinet.toml`, because Clarinet keys contracts by name
  and both files want the same name. It needs either a second manifest checked in a
  separate CI step, or a restructure. **Matt's call on which.**
