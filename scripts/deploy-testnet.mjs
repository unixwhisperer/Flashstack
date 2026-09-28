/**
 * FlashStack — Testnet Deployment + Flash Loan Evidence (current generation)
 *
 * Deploys the BC1-fixed STX flash loan core to Stacks testnet and executes a
 * real flash loan, producing on-chain testnet txids as evidence.
 *
 * UPDATED 2026-09-18: previously deployed the v1 line (flashstack-stx-core,
 * flashstack-stx-pool, flashstack-pool-oracle) — none of which is what
 * docs/TESTNET_STAGING.md's gate exists to protect. v1 is already live on
 * mainnet; staging it again proves nothing new. This now targets
 * flashstack-stx-core-v2, the undeployed BC1 two-step-admin successor, using
 * scripts/lib/testnet-localize.mjs (fixed in #55) to rewrite mainnet
 * principals correctly instead of the old two-address patcher that would
 * have silently mis-published it.
 *
 * Setup:
 *   1. Create a FRESH wallet for testnet only — see docs/TESTNET_STAGING.md §3.
 *      Never reuse a wallet that has ever held mainnet funds.
 *   2. Fund it at: https://explorer.hiro.so/sandbox/faucet?chain=testnet
 *      (1000 STX per request — run 3-4 times to cover deploy fees + reserve)
 *   3. Run:
 *      TESTNET_MNEMONIC="word1 ... word24" node scripts/deploy-testnet.mjs
 *      (testnet address is derived automatically from the mnemonic)
 *
 * Modes:
 *   --steps=all    (default) the full sequence below.
 *   --steps=admin  Step 8 ONLY, against an already-deployed core. Publishes
 *                  nothing, moves no STX, costs 3 x 100_000 uSTX. This is how
 *                  §6a's BC1 rows get regenerated against the corrected Step 8
 *                  without republishing a line that is already on chain
 *                  (docs/TESTNET_STAGING.md §6c, route A). It refuses to run
 *                  unless the contract exists, admin is the signing deployer and
 *                  pending-admin is none — scripts/lib/testnet-preconditions.mjs.
 *
 * Scope of this run — deliberately narrow:
 *   Proves flashstack-stx-core-v2 end-to-end, including the BC1 two-step
 *   admin transfer this whole successor line exists for. Does NOT include
 *   flashstack-stx-pool-v3 (a separate flash-loan-capable contract, needs
 *   its own receiver — stx-test-receiver-v2 hardcodes core-v2 by name, the
 *   same static-reference constraint documented in that file) or pool-v3 /
 *   sbtc-core-v2 (the generic multi-asset line — now stageable per #55's
 *   sBTC TESTNET_EQUIVALENT work, but a materially bigger deploy: multiple
 *   assets, add-asset calibration, its own receiver). Both are natural
 *   follow-ups once this simpler line is proven, not folded in blind here.
 *
 * Deploys in order:
 *   1. stx-flash-receiver-trait    — trait interface (testnet regenesised,
 *                                    no prior deployment survives — fresh)
 *   2. flashstack-stx-core-v2      — flash loan engine, BC1 two-step admin
 *   3. stx-test-receiver-v2        — minimal borrow-and-repay receiver
 *   Then: whitelist receiver → fund reserve → execute flash loan → evidence
 */

import {
  makeContractDeploy,
  makeContractCall,
  makeSTXTokenTransfer,
  PostConditionMode,
  ClarityVersion,
  Cl,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import networkPkg from "@stacks/network";
const { STACKS_TESTNET } = networkPkg;
import walletPkg from "@stacks/wallet-sdk";
const { generateWallet } = walletPkg;
import { readFileSync } from "fs";
import { localize, assertFullyLocalized } from "./lib/testnet-localize.mjs";
import { callReadOnly as callReadOnlyRaw, assertEqual } from "./lib/testnet-readonly.mjs";
import { assertAdminStepPreconditions } from "./lib/testnet-preconditions.mjs";
import { parseSteps } from "./lib/parse-steps.mjs";

// Thin wrapper so call sites keep their original signature (the API base is a
// module-level constant here, but a parameter in the lib so tests can point it
// elsewhere).
const callReadOnly = (sender, contractAddress, contractName, fn, args = []) =>
  callReadOnlyRaw(API, sender, contractAddress, contractName, fn, args);

// ── Config ────────────────────────────────────────────────────────────────────

const MNEMONIC  = process.env.TESTNET_MNEMONIC;
const API       = "https://api.testnet.hiro.so";
// --steps=all (default) runs the whole line. --steps=admin re-runs Step 8 ONLY,
// against an already-deployed core: the BC1 evidence in docs/TESTNET_STAGING.md
// §6a predates a92fb8e's fix and needs regenerating, and re-publishing a whole
// contract line to fix an assertion-strength gap would be the wrong shape of
// change (§6c, route A). Guarded — see scripts/lib/testnet-preconditions.mjs.
let STEPS;
try {
  STEPS = parseSteps(process.argv);
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
const EXPLORER  = "https://explorer.hiro.so/txid";
const network   = STACKS_TESTNET;

// How much STX to deposit as flash loan reserve (50 STX = 50_000_000 microSTX)
const RESERVE_AMOUNT = 50_000_000;

// stx-test-receiver repays principal + the 0.05% fee from its OWN balance, so a
// freshly deployed receiver (0 STX) cannot cover the fee and the flash loan
// reverts with (err u500). Seed it with a small amount first. (1 STX = 1_000_000)
const RECEIVER_SEED_AMOUNT = 1_000_000;


if (!MNEMONIC) {
  console.error("ERROR: Set TESTNET_MNEMONIC");
  console.error("");
  console.error("  TESTNET_MNEMONIC=\"word1 ... word24\" node scripts/deploy-testnet.mjs");
  console.error("");
  console.error("  Fund your testnet address first:");
  console.error("  https://explorer.hiro.so/sandbox/faucet?chain=testnet");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getPrivateKey() {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
  return wallet.accounts[0].stxPrivateKey;
}

// Derives testnet address from private key (same approach as generateWallet uses internally)
function deriveTestnetAddress(privateKey) {
  return getAddressFromPrivateKey(privateKey, STACKS_TESTNET);
}

function patchSource(source, deployerAddress, label = "contract") {
  // Rewrite every FlashStack-published principal to the testnet deployer, then
  // REFUSE to proceed if any mainnet principal survives. Previously this
  // function knew about two principals and silently left the rest in place, so a
  // contract referencing a third would be broadcast and abort at publish time
  // with an unresolved contract. See scripts/lib/testnet-localize.mjs and
  // docs/TESTNET_STAGING.md §5.1.
  const patched = localize(source, deployerAddress);
  assertFullyLocalized(patched, label);
  return patched;
}

async function getNonce(deployer) {
  const res  = await fetch(`${API}/v2/accounts/${deployer}?proof=0`);
  const data = await res.json();
  if (!data.nonce && data.nonce !== 0) {
    throw new Error(`Could not fetch nonce for ${deployer}. Is the address funded?\n  Fund at: https://explorer.hiro.so/sandbox/faucet?chain=testnet`);
  }
  return data.nonce;
}

async function getBalance(deployer) {
  const res  = await fetch(`${API}/v2/accounts/${deployer}?proof=0`);
  const data = await res.json();
  return BigInt(data.balance ?? "0x0");
}

async function waitForConfirm(txid, label) {
  process.stdout.write(`  Waiting for "${label}"`);
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 8000));
    const res  = await fetch(`${API}/extended/v1/tx/0x${txid}`);
    const data = await res.json();
    if (data.tx_status === "success") {
      console.log(" confirmed.");
      return data;
    }
    if (data.tx_status?.startsWith("abort")) {
      const reason = data.tx_result?.repr ?? "unknown";
      console.log(`\n  FAILED: ${reason}`);
      console.log(`  Tx: ${EXPLORER}/${txid}?chain=testnet`);
      throw new Error(`"${label}" failed: ${reason}`);
    }
    process.stdout.write(".");
  }
  throw new Error(`Timeout waiting for "${label}"`);
}

async function broadcast(tx) {
  const raw   = tx.serialize();
  const bytes = typeof raw === "string"
    ? Buffer.from(raw.replace(/^0x/, ""), "hex")
    : raw;
  const res  = await fetch(`${API}/v2/transactions`, {
    method:  "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body:    bytes,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Node response not JSON: ${text.slice(0, 200)}`); }
  if (typeof data === "object" && data.error) {
    throw new Error(`${data.error} — ${data.reason ?? ""} ${data.reason_data ? JSON.stringify(data.reason_data) : ""}`);
  }
  const txid = typeof data === "string" ? data : data.txid;
  if (!txid) throw new Error(`Unexpected response: ${text.slice(0, 200)}`);
  return txid;
}

async function deployContract(privateKey, nonce, name, sourcePath, deployer) {
  const raw    = readFileSync(sourcePath, "utf8");
  const source = patchSource(raw, deployer, name);
  const tx = await makeContractDeploy({
    contractName:      name,
    codeBody:          source,
    senderKey:         privateKey,
    network,
    clarityVersion:    ClarityVersion.Clarity3,
    postConditionMode: PostConditionMode.Allow,
    anchorMode:        1,
    fee:               500_000,
    nonce,
  });
  const txid = await broadcast(tx);
  console.log(`  Broadcast: ${txid}`);
  console.log(`  Explorer:  ${EXPLORER}/${txid}?chain=testnet`);
  return txid;
}

async function callContract(privateKey, nonce, contractAddress, contractName, fn, args, fee = 100_000, deployer) {
  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName:      fn,
    functionArgs:      args,
    senderKey:         privateKey,
    network,
    postConditionMode: PostConditionMode.Allow,
    anchorMode:        1,
    fee,
    nonce,
  });
  const txid = await broadcast(tx);
  console.log(`  Broadcast: ${txid}`);
  console.log(`  Explorer:  ${EXPLORER}/${txid}?chain=testnet`);
  return txid;
}

async function transferStx(privateKey, nonce, recipient, amount, fee = 10_000) {
  const tx = await makeSTXTokenTransfer({
    recipient,
    amount,
    senderKey:  privateKey,
    network,
    anchorMode: 1,
    fee,
    nonce,
    memo:       "seed receiver fee",
  });
  const txid = await broadcast(tx);
  console.log(`  Broadcast: ${txid}`);
  console.log(`  Explorer:  ${EXPLORER}/${txid}?chain=testnet`);
  return txid;
}

// ── Step 8: Prove BC1 — the two-step admin transfer this line exists for ─────
// Extracted so `--steps=admin` runs THIS code and not a copy of it. A second
// implementation of the assertion sequence is exactly how the two would drift,
// and a drifted copy that still prints OK is the F-7 shape all over again.
//
// Returns the next unused nonce.
async function proveBC1(privateKey, DEPLOYER, startNonce, results) {
  let nonce = startNonce;
  // A propose-to-self-then-accept sequence is NOT evidence of anything: if
  // transfer-admin secretly set admin directly (the exact v1 bug this line
  // fixes), the txids would look identical, both success, admin unchanged
  // throughout. Read-only calls between each step are what makes this real
  // evidence instead of "two functions executed without erroring" (caught in
  // review — the earlier version of this step had exactly that gap).
  //
  // OTHER is the well-known public Clarinet default testnet deployer (also
  // used as sBTC's TESTNET_EQUIVALENT target in #55) — a real, distinct
  // testnet principal the deployer key does not control.
  const OTHER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
  console.log("Step 8 — Prove BC1: two-step admin transfer, with state asserted at each step");
  console.log(`  (Proposing to ${OTHER}, a principal this key does not control)`);

  results.proposeOther = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-stx-core-v2", "transfer-admin",
    [Cl.principal(OTHER)],
    100_000,
  );
  await waitForConfirm(results.proposeOther, "transfer-admin (propose to OTHER)");

  const adminAfterPropose = await callReadOnly(DEPLOYER, DEPLOYER, "flashstack-stx-core-v2", "get-admin");
  assertEqual("admin after propose (must NOT have moved)", adminAfterPropose, DEPLOYER);

  const pendingAfterPropose = await callReadOnly(DEPLOYER, DEPLOYER, "flashstack-stx-core-v2", "get-pending-admin");
  assertEqual("pending-admin after propose", pendingAfterPropose, `(some ${OTHER})`);

  console.log("  (Re-proposing to self — demonstrates recovery from a fat-fingered address)");
  results.proposeAdmin = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-stx-core-v2", "transfer-admin",
    [Cl.principal(DEPLOYER)],
    100_000,
  );
  await waitForConfirm(results.proposeAdmin, "transfer-admin (re-propose to self)");

  const pendingAfterRepropose = await callReadOnly(DEPLOYER, DEPLOYER, "flashstack-stx-core-v2", "get-pending-admin");
  assertEqual("pending-admin after re-propose", pendingAfterRepropose, `(some ${DEPLOYER})`);

  results.acceptAdmin = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-stx-core-v2", "accept-admin",
    [],
    100_000,
  );
  await waitForConfirm(results.acceptAdmin, "accept-admin");

  const adminAfterAccept = await callReadOnly(DEPLOYER, DEPLOYER, "flashstack-stx-core-v2", "get-admin");
  assertEqual("admin after accept", adminAfterAccept, DEPLOYER);
  console.log();

  return nonce;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Derive deployer address from mnemonic
  const privateKey = await getPrivateKey();
  const DEPLOYER   = deriveTestnetAddress(privateKey);

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       FlashStack — Testnet Deployment                ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Network:  testnet (https://api.testnet.hiro.so)`);
  console.log(`  Deployer: ${DEPLOYER}`);
  console.log(`  Explorer: https://explorer.hiro.so/address/${DEPLOYER}?chain=testnet`);
  console.log();

  // Pre-flight: balance check. The thresholds below describe the FULL run;
  // --steps=admin broadcasts three 100_000 uSTX calls and nothing else, so
  // applying them there would warn about 5000 STX for a 0.3 STX job.
  const balanceMicro = await getBalance(DEPLOYER);
  const balanceSTX   = Number(balanceMicro) / 1_000_000;
  console.log(`  Balance: ${balanceSTX.toFixed(2)} STX`);
  if (STEPS === "admin" && balanceMicro < BigInt(300_000)) {
    console.error("  ERROR: below the 300,000 uSTX the three admin calls cost.");
    console.error(`  Fund at: https://explorer.hiro.so/sandbox/faucet?chain=testnet`);
    process.exit(1);
  }
  if (STEPS === "all" && balanceMicro < BigInt(5_000_000_000)) {
    console.warn("  WARNING: Balance is below 5000 STX. Deploy fees + reserve require ~3000 STX.");
    console.warn(`  Fund at: https://explorer.hiro.so/sandbox/faucet?chain=testnet`);
    console.warn(`  Address to fund: ${DEPLOYER}`);
    console.warn("  (Run faucet 3-4 times, then re-run this script)");
    if (balanceMicro < BigInt(500_000_000)) {
      console.error("  ERROR: Insufficient balance to proceed.");
      process.exit(1);
    }
  }
  console.log();

  let nonce = await getNonce(DEPLOYER);
  console.log(`  Starting nonce: ${nonce}\n`);

  const results = {};

  if (STEPS === "admin") {
    // Route A (docs/TESTNET_STAGING.md §6c): regenerate §6a's BC1 rows against
    // the corrected Step 8 without republishing a line that is already on chain.
    // §6b already proved the negative case on this same deployment, so what is
    // missing is assertion strength on the positive path, nothing else.
    console.log("Mode — --steps=admin: Step 8 only, against the existing deployment.");
    console.log("  Publishes, reserve funding, receiver seeding and the flash loan are SKIPPED.");
    console.log("  Cost: 3 calls x 100,000 uSTX. Nothing is deployed and no STX moves.\n");

    await assertAdminStepPreconditions(API, DEPLOYER, "flashstack-stx-core-v2");
    console.log();

    nonce = await proveBC1(privateKey, DEPLOYER, nonce, results);

    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║   BC1 RE-RUN COMPLETE (Step 8 only)                  ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`  Contract: ${DEPLOYER}.flashstack-stx-core-v2`);
    console.log(`  transfer-admin (to OTHER):   ${EXPLORER}/${results.proposeOther}?chain=testnet`);
    console.log(`  transfer-admin (re-to self): ${EXPLORER}/${results.proposeAdmin}?chain=testnet`);
    console.log(`  accept-admin:                ${EXPLORER}/${results.acceptAdmin}?chain=testnet`);
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log();
    console.log("Next: fill the Step 8a/8b/8c evidence slots in");
    console.log("  deployments/testnet-current-gen-plan.yaml, then regenerate §6a from");
    console.log("  the §6c template. Re-verify every txid against the live API first —");
    console.log("  the console output above is not evidence.");
    return;
  }

  // ── Step 1: stx-flash-receiver-trait ─────────────────────────────────────
  console.log("Step 1 — Deploy stx-flash-receiver-trait");
  console.log("  (Defines the interface all STX flash receivers must implement)");
  results.trait = await deployContract(
    privateKey, nonce++,
    "stx-flash-receiver-trait",
    "contracts/stx-flash-receiver-trait.clar",
    DEPLOYER,
  );
  await waitForConfirm(results.trait, "deploy stx-flash-receiver-trait");
  console.log();

  // ── Step 2: flashstack-stx-core-v2 ───────────────────────────────────────
  console.log("Step 2 — Deploy flashstack-stx-core-v2");
  console.log("  (Flash loan engine — reserve model, BC1 two-step admin, 0.05% fee)");
  results.core = await deployContract(
    privateKey, nonce++,
    "flashstack-stx-core-v2",
    "contracts/flashstack-stx-core-v2.clar",
    DEPLOYER,
  );
  await waitForConfirm(results.core, "deploy flashstack-stx-core-v2");
  console.log();

  // ── Step 3: stx-test-receiver-v2 ─────────────────────────────────────────
  console.log("Step 3 — Deploy stx-test-receiver-v2");
  console.log("  (Minimal receiver targeting core-v2: borrow STX, repay principal + fee)");
  results.receiver = await deployContract(
    privateKey, nonce++,
    "stx-test-receiver-v2",
    "contracts/stx-test-receiver-v2.clar",
    DEPLOYER,
  );
  await waitForConfirm(results.receiver, "deploy stx-test-receiver-v2");
  console.log();

  // ── Step 4: Whitelist test receiver in stx-core-v2 ───────────────────────
  console.log("Step 4 — Whitelist stx-test-receiver-v2 in flashstack-stx-core-v2");
  results.whitelist = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-stx-core-v2", "add-approved-receiver",
    [Cl.principal(`${DEPLOYER}.stx-test-receiver-v2`)],
  );
  await waitForConfirm(results.whitelist, "add-approved-receiver");
  console.log();

  // ── Step 5: Fund reserve with testnet STX ────────────────────────────────
  const reserveSTX = RESERVE_AMOUNT / 1_000_000;
  console.log(`Step 5 — Fund flashstack-stx-core-v2 reserve with ${reserveSTX} testnet STX`);
  results.fund = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-stx-core-v2", "deposit-reserve",
    [Cl.uint(RESERVE_AMOUNT)],
    200_000,
  );
  await waitForConfirm(results.fund, "deposit-reserve");
  console.log();

  // ── Step 6: Seed the receiver so it can pay the flash loan fee ──────────
  const seedSTX = RECEIVER_SEED_AMOUNT / 1_000_000;
  console.log(`Step 6 — Seed stx-test-receiver-v2 with ${seedSTX} testnet STX`);
  console.log("  (Receiver repays principal + 0.05% fee from its own balance; without");
  console.log("   this, a fresh receiver has 0 STX and the flash loan fails with err u500)");
  results.seed = await transferStx(
    privateKey, nonce++,
    `${DEPLOYER}.stx-test-receiver-v2`,
    RECEIVER_SEED_AMOUNT,
  );
  await waitForConfirm(results.seed, "seed stx-test-receiver-v2");
  console.log();

  // ── Step 7: Execute test flash loan ──────────────────────────────────────
  // Borrow 10 STX (10_000_000 microSTX) via stx-test-receiver-v2
  const LOAN_AMOUNT = 10_000_000; // 10 STX
  console.log(`Step 7 — Execute flash loan: borrow ${LOAN_AMOUNT / 1_000_000} STX via stx-test-receiver-v2`);
  console.log("  (This is the testnet evidence txid — atomic borrow + repay in one tx)");
  results.flashLoan = await callContract(
    privateKey, nonce++,
    DEPLOYER, "flashstack-stx-core-v2", "flash-loan",
    [
      Cl.uint(LOAN_AMOUNT),
      Cl.principal(`${DEPLOYER}.stx-test-receiver-v2`),
    ],
    200_000,
  );
  await waitForConfirm(results.flashLoan, "flash-loan (testnet evidence)");
  console.log();

  nonce = await proveBC1(privateKey, DEPLOYER, nonce, results);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║           TESTNET DEPLOYMENT COMPLETE                ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Deployer: ${DEPLOYER.padEnd(42)} ║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  Contracts:                                          ║");
  console.log(`  stx-flash-receiver-trait: ${EXPLORER}/${results.trait}?chain=testnet`);
  console.log(`  flashstack-stx-core-v2:   ${EXPLORER}/${results.core}?chain=testnet`);
  console.log(`  stx-test-receiver-v2:     ${EXPLORER}/${results.receiver}?chain=testnet`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  Actions:                                            ║");
  console.log(`  Whitelist receiver:       ${EXPLORER}/${results.whitelist}?chain=testnet`);
  console.log(`  Fund reserve (${reserveSTX} STX):  ${EXPLORER}/${results.fund}?chain=testnet`);
  console.log(`  Seed receiver (${seedSTX} STX):    ${EXPLORER}/${results.seed}?chain=testnet`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  TESTNET FLASH LOAN EVIDENCE:                        ║");
  console.log(`  Flash loan (10 STX):      ${EXPLORER}/${results.flashLoan}?chain=testnet`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  BC1 EVIDENCE (two-step admin transfer, state asserted): ║");
  console.log(`  transfer-admin (to OTHER):  ${EXPLORER}/${results.proposeOther}?chain=testnet`);
  console.log(`  transfer-admin (re-to self):${EXPLORER}/${results.proposeAdmin}?chain=testnet`);
  console.log(`  accept-admin:               ${EXPLORER}/${results.acceptAdmin}?chain=testnet`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  Address activity (all txids):                       ║");
  console.log(`  https://explorer.hiro.so/address/${DEPLOYER}?chain=testnet`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();
  console.log("Next steps:");
  console.log("  1. Add testnet txids to docs/TESTNET_STAGING.md as staging evidence");
  console.log("  2. Security & Contract Lead review of the recorded evidence (gate step 6)");
  console.log("  3. Follow-up deploy: flashstack-stx-pool-v3 (own receiver needed — see");
  console.log("     stx-test-receiver-v2.clar's header for why one contract can't cover both)");
  console.log("  4. Follow-up deploy: flashstack-pool-v3 + flashstack-sbtc-core-v2 (generic");
  console.log("     multi-asset line — now stageable per #55's sBTC TESTNET_EQUIVALENT work)");
}

main().catch(e => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
