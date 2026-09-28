/**
 * Preconditions for re-running Step 8 alone against an ALREADY-DEPLOYED core.
 *
 * `deploy-testnet.mjs --steps=admin` skips Steps 1-7 — it publishes nothing and
 * funds nothing, it only exercises the two-step admin sequence against a contract
 * that is already on chain. That is the whole point (docs/TESTNET_STAGING.md §6c,
 * route A): the BC1 evidence gap is an assertion-strength problem, not a
 * deployment problem, so re-publishing a whole line to fix it would be the wrong
 * shape of change.
 *
 * Skipping the publishes means the script no longer establishes the state it then
 * assumes. Three things have to be true before a single transaction is broadcast,
 * and each one fails differently and badly if it is not:
 *
 *   1. The contract exists at that principal. Without this the admin calls hit
 *      nothing and the failure reads like a contract bug rather than a targeting
 *      mistake — and on testnet a mistyped deployer is an easy way to spend ten
 *      minutes debugging the wrong chain.
 *   2. `get-admin` is the signing deployer. `transfer-admin` is admin-gated, so if
 *      admin has moved the run aborts partway through — worst case after the first
 *      propose, leaving a live pending-admin pointing at a principal nobody
 *      intended. scripts/deploy-testnet-bc1-negative.mjs documents exactly this
 *      window; §6b's restore closed it, and a guard is what keeps it closed.
 *   3. `get-pending-admin` is `none`. A leftover proposal means some earlier run
 *      did not finish, so the contract is NOT in the state §6a/§6b describe. It
 *      also means an outstanding offer is sitting there for whoever it names to
 *      accept. Overwriting it silently and carrying on would bury that.
 *
 * These live here rather than inline in deploy-testnet.mjs for the reason #58
 * moved callReadOnly/assertEqual out: that script `process.exit(1)`s at import
 * without TESTNET_MNEMONIC, so nothing inline in it can be tested. A guard whose
 * failure mode is "silently allows the run" belongs somewhere a test can reach it.
 */

import { callReadOnly, assertEqual } from "./testnet-readonly.mjs";

/** True if a contract is published at <address>.<name> on this API's chain. */
export async function contractExists(api, address, name) {
  const res = await fetch(`${api}/v2/contracts/interface/${address}/${name}`);
  return res.ok === true;
}

/**
 * Throw unless the chain is in the exact state the admin-only path assumes.
 * Resolves to nothing on success; every failure names what was wrong and what
 * to do about it, because the operator reading it has a funded key in hand.
 */
export async function assertAdminStepPreconditions(api, deployer, contractName) {
  console.log(`  Precondition check — ${deployer}.${contractName}`);

  if (!(await contractExists(api, deployer, contractName))) {
    throw new Error(
      `PRECONDITION FAILED — no contract at ${deployer}.${contractName} on this chain.\n` +
        `  --steps=admin does not publish anything; it re-runs Step 8 against an existing\n` +
        `  deployment. Either the deployer key is not the one that published it, or this\n` +
        `  line has not been staged yet — in which case run the full script instead.`,
    );
  }
  console.log(`  OK: contract exists at ${deployer}.${contractName}`);

  const admin = await callReadOnly(api, deployer, deployer, contractName, "get-admin");
  if (admin !== deployer) {
    throw new Error(
      `PRECONDITION FAILED — admin is ${admin}, not the signing deployer ${deployer}.\n` +
        `  transfer-admin is admin-gated, so this run would abort partway through and could\n` +
        `  leave a pending-admin behind. If a previous run of\n` +
        `  scripts/deploy-testnet-bc1-negative.mjs died mid-sequence, admin may still be the\n` +
        `  second key: restore it (transfer-admin back to the deployer, then accept-admin)\n` +
        `  before running this.`,
    );
  }
  assertEqual("admin is the signing deployer", admin, deployer);

  const pending = await callReadOnly(api, deployer, deployer, contractName, "get-pending-admin");
  if (pending !== "none") {
    throw new Error(
      `PRECONDITION FAILED — pending-admin is ${pending}, expected none.\n` +
        `  An outstanding proposal means an earlier run did not finish, so the contract is\n` +
        `  not in the state docs/TESTNET_STAGING.md §6a/§6b describe — and whoever that\n` +
        `  proposal names can still accept it. Resolve it deliberately (re-propose to the\n` +
        `  deployer and accept, which clears pending) before re-running Step 8.`,
    );
  }
  assertEqual("pending-admin is clear", pending, "none");
}
