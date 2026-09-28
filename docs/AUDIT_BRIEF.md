# Audit Brief — Security & Contract Lead Handoff

Working notes for whoever is the internal technical counterpart to the
professional audit. **The audit firm is not yet chosen** (ROADMAP.md lists only
"Professional third-party audit"; an earlier version of this brief named two
firms and cited ROADMAP for it, which the ROADMAP does not support). Not a
replacement for the README/ROADMAP — a pointer into them plus the open items
an auditor will ask about first.

**For the external-facing scope and evidence packet, see
[`security/AUDIT_SCOPE.md`](security/AUDIT_SCOPE.md).** This file is the internal
handoff; that one is what goes to a prospective auditor.

## Where the real docs live

- Protocol overview, mainnet contract addresses, security posture: `README.md`
  (see the **Security** section — solvency invariant, test suite, access
  control model).
- Multi-asset core redesign: `docs/02-technical/MULTI_ASSET_CORE_DESIGN.md`
- LP/collateral integration surface for third parties: `docs/LP_COLLATERAL_INTEGRATION_SPEC.md`
- Roadmap / audit timing: `ROADMAP.md` ("In Progress (Q2 2026)")

## Status of the items an auditor asks about first

*Updated 2026-09-21. Items 1–3 were open when this brief was written; each was
re-checked against the repo and GitHub before being marked done.*

1. **Findings register — done.** `docs/security/FINDINGS_REGISTER.md` holds the
   findings (F-1 to F-7, BC1, pv3-F1 to F3) with status and evidence. It is no
   longer local-only.
2. **CI gating — done.** `.github/workflows/test.yml` runs `clarinet check`, then
   the full suite, on every PR to `main`.
3. **Second-reviewer requirement — on, with one caveat.** Branch protection on
   `main` requires 1 approving review **from a code owner** and both status
   checks (`Build Frontend`, `Test Smart Contracts`), read from the GitHub API on
   2026-09-21. `enforce_admins` is **off**, so a repo admin can bypass it; that is
   a deliberate choice for a two-person team, not an oversight.
4. **v1 vs v2 pools.** v1 STX/sBTC pools are deprecated in favor of virtual-shares
   v2 pools (ERC-4626-style). *Corrected 2026-09-16:* this item previously said both
   generations were listed as live in the README's mainnet contract table. That is no
   longer true — the README lists only the v2 pools. The v1 pools are still live on
   chain (paused, drained) and are in scope for the auditor as immutable legacy; see
   `docs/security/CONTRACT_INVENTORY.md` §3 and finding **F-6**.

## Contract inventory at a glance

Full addresses and explorer links are in `README.md`; `Clarinet.toml` lists
what's actually registered for `clarinet check`. Three receivers are
intentionally excluded because they fail a real check — each has a comment in
`Clarinet.toml` explaining why (see also `docs/BUILD_A_RECEIVER.md`). Do not
quote `clarinet check`'s "contracts checked" total as coverage of our own code:
it depends on the requirements cache and counts third-party contracts.
