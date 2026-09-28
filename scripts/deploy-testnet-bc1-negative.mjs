/**
 * FlashStack — BC1 Negative-Path Proof (two-signer)
 *
 * §6a and #56's Step 8 both only ever used one signer, so they could prove
 * the happy path (propose-then-accept from the same key succeeds) but not
 * the actual property BC1 exists for: that accept-admin from a NON-pending
 * principal is rejected on-chain, not merely "not attempted". Flagged by
 * Hillary on #57 as the next genuinely separate piece of evidence needed.
 *
 * Targets the already-deployed flashstack-stx-core-v2 at the existing
 * testnet deployer's address (docs/TESTNET_STAGING.md §6a) — does NOT
 * redeploy anything, no new contracts.
 *
 * Contract logic being tested (contracts/flashstack-stx-core-v2.clar):
 *   accept-admin: (asserts! (is-eq tx-sender pending) ERR-NOT-PENDING-ADMIN)
 *   — the old admin, having just proposed someone else, is by definition not
 *   the pending admin, so its own accept-admin call must abort on-chain.
 *
 * Setup — two independent keys, neither ever written to a file:
 *   1. TESTNET_MNEMONIC   = the original deployer (current admin)
 *   2. TESTNET_MNEMONIC_2 = a second, freshly generated testnet-only wallet,
 *      funded via the faucet (https://explorer.hiro.so/sandbox/faucet?chain=testnet)
 *   Run:
 *      read -rs TESTNET_MNEMONIC   && export TESTNET_MNEMONIC
 *      read -rs TESTNET_MNEMONIC_2 && export TESTNET_MNEMONIC_2
 *      node scripts/deploy-testnet-bc1-negative.mjs
 *
 * Sequence:
 *   1. transfer-admin(second key) as DEPLOYER — propose
 *   2. assert admin unchanged, pending-admin = (some second key)
 *   3. accept-admin as DEPLOYER (old admin, NOT pending) — MUST abort on-chain
 *   4. assert admin still unchanged after the rejected attempt
 *   5. accept-admin as SECOND KEY (the real pending admin) — must succeed
 *   6. assert admin now = second key
 *   7. Restore: transfer-admin(deployer) as second key, accept as deployer
 *   8. assert admin back to deployer, pending-admin none
 *
 * Ends with the contract back in its original admin state so later runs and
 * docs can keep assuming DEPLOYER = admin.
 *
 * WARNING — not idempotent mid-run: between step 3 (second key accepts) and
 * the end of step 4 (transferred back), the contract's admin genuinely IS
 * the second key, not the deployer. If the script dies in that window
 * (timeout, fee too low, a dropped tx), flashstack-stx-core-v2 is left with
 * an admin that §6a and every later run assume is the deployer. It's
 * recoverable — the second key can still propose back — but only while
 * TESTNET_MNEMONIC_2 still exists. If this aborts after step 3 completes,
 * check get-admin before doing anything else, and re-run the restore
 * (transfer-admin back to deployer, then accept-admin as deployer) using
 * MNEMONIC_2 before any other script touches this contract.
 *
 * callReadOnly/assertEqual come from scripts/lib/testnet-readonly.mjs (#58),
 * which has tests pinning both directions — this script previously carried its
 * own untestable copies of both.
 */

import {
  makeContractCall,
  PostConditionMode,
  Cl,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import networkPkg from "@stacks/network";
const { STACKS_TESTNET } = networkPkg;
import walletPkg from "@stacks/wallet-sdk";
const { generateWallet } = walletPkg;
import { callReadOnly as callReadOnlyRaw, assertEqual } from "./lib/testnet-readonly.mjs";

const MNEMONIC   = process.env.TESTNET_MNEMONIC;
const MNEMONIC_2 = process.env.TESTNET_MNEMONIC_2;
const API        = "https://api.testnet.hiro.so";
const EXPLORER   = "https://explorer.hiro.so/txid";
const network    = STACKS_TESTNET;
const CONTRACT   = "flashstack-stx-core-v2";

if (!MNEMONIC || !MNEMONIC_2) {
  console.error("ERROR: Set both TESTNET_MNEMONIC (original deployer) and TESTNET_MNEMONIC_2 (second key).");
  console.error("");
  console.error("  read -rs TESTNET_MNEMONIC   && export TESTNET_MNEMONIC");
  console.error("  read -rs TESTNET_MNEMONIC_2 && export TESTNET_MNEMONIC_2");
  console.error("  node scripts/deploy-testnet-bc1-negative.mjs");
  process.exit(1);
}

async function keyAndAddress(mnemonic) {
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const privateKey = wallet.accounts[0].stxPrivateKey;
  const address = getAddressFromPrivateKey(privateKey, STACKS_TESTNET);
  return { privateKey, address };
}

async function getNonce(address) {
  const res  = await fetch(`${API}/v2/accounts/${address}?proof=0`);
  const data = await res.json();
  if (!data.nonce && data.nonce !== 0) {
    throw new Error(`Could not fetch nonce for ${address}. Is it funded?\n  Fund at: https://explorer.hiro.so/sandbox/faucet?chain=testnet`);
  }
  return data.nonce;
}

// expectedRejection: null means the tx must succeed. A string (e.g.
// "(err u309)") means the tx must abort with EXACTLY that tx_result repr --
// not just any abort. Rejected isn't the same as rejected for the right
// reason: an unrelated runtime error, or a future refactor that changes the
// guard, must not silently pass as "the BC1 negative case, proven".
async function waitForConfirm(txid, label, expectedRejection = null) {
  process.stdout.write(`  Waiting for "${label}"`);
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 8000));
    const res  = await fetch(`${API}/extended/v1/tx/0x${txid}`);
    const data = await res.json();
    if (data.tx_status === "success") {
      if (expectedRejection) {
        console.log(" succeeded.");
        throw new Error(`"${label}" was expected to be REJECTED on-chain (${expectedRejection}) but succeeded — the BC1 negative case is broken`);
      }
      console.log(" confirmed.");
      return data;
    }
    if (data.tx_status?.startsWith("abort")) {
      const reason = data.tx_result?.repr ?? "unknown";
      if (expectedRejection) {
        console.log(`\n  Rejected on-chain: ${reason}`);
        console.log(`  Tx: ${EXPLORER}/${txid}?chain=testnet`);
        assertEqual(`"${label}" rejection reason`, reason, expectedRejection);
        return data;
      }
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

async function callContract(privateKey, nonce, contractAddress, contractName, fn, args, fee = 100_000) {
  const tx = await makeContractCall({
    contractAddress, contractName, functionName: fn, functionArgs: args,
    senderKey: privateKey, network, postConditionMode: PostConditionMode.Allow,
    anchorMode: 1, fee, nonce,
  });
  const txid = await broadcast(tx);
  console.log(`  Broadcast: ${txid}`);
  console.log(`  Explorer:  ${EXPLORER}/${txid}?chain=testnet`);
  return txid;
}

// Binds API so call sites keep their original signature (same wrapper as
// deploy-testnet.mjs).
const callReadOnly = (sender, contractAddress, contractName, fn, args = []) =>
  callReadOnlyRaw(API, sender, contractAddress, contractName, fn, args);

async function main() {
  const deployer = await keyAndAddress(MNEMONIC);
  const second   = await keyAndAddress(MNEMONIC_2);

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║     FlashStack — BC1 Negative-Path Proof             ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Deployer (current admin): ${deployer.address}`);
  console.log(`  Second key:                ${second.address}`);
  console.log(`  Target:                    ${deployer.address}.${CONTRACT}`);
  console.log();

  const startAdmin = await callReadOnly(deployer.address, deployer.address, CONTRACT, "get-admin");
  assertEqual("starting admin", startAdmin, deployer.address);
  const startPending = await callReadOnly(deployer.address, deployer.address, CONTRACT, "get-pending-admin");
  assertEqual("starting pending-admin", startPending, "none");
  console.log();

  let deployerNonce = await getNonce(deployer.address);
  let secondNonce   = await getNonce(second.address);

  const results = {};

  console.log("Step 1 — transfer-admin(second key) as DEPLOYER (propose)");
  results.propose = await callContract(
    deployer.privateKey, deployerNonce++,
    deployer.address, CONTRACT, "transfer-admin", [Cl.principal(second.address)],
  );
  await waitForConfirm(results.propose, "transfer-admin (propose second key)");

  const adminAfterPropose = await callReadOnly(deployer.address, deployer.address, CONTRACT, "get-admin");
  assertEqual("admin after propose (must NOT have moved)", adminAfterPropose, deployer.address);
  const pendingAfterPropose = await callReadOnly(deployer.address, deployer.address, CONTRACT, "get-pending-admin");
  assertEqual("pending-admin after propose", pendingAfterPropose, `(some ${second.address})`);
  console.log();

  console.log("Step 2 — accept-admin as DEPLOYER (NOT the pending admin) — MUST be rejected on-chain");
  results.wrongAccept = await callContract(
    deployer.privateKey, deployerNonce++,
    deployer.address, CONTRACT, "accept-admin", [],
  );
  await waitForConfirm(results.wrongAccept, "accept-admin (wrong caller — expect rejection)", "(err u309)");

  const adminAfterWrongAccept = await callReadOnly(deployer.address, deployer.address, CONTRACT, "get-admin");
  assertEqual("admin after rejected accept (must be unchanged)", adminAfterWrongAccept, deployer.address);
  console.log();

  console.log("Step 3 — accept-admin as SECOND KEY (the real pending admin) — must succeed");
  results.rightAccept = await callContract(
    second.privateKey, secondNonce++,
    deployer.address, CONTRACT, "accept-admin", [],
  );
  await waitForConfirm(results.rightAccept, "accept-admin (correct pending admin)");

  const adminAfterRightAccept = await callReadOnly(deployer.address, deployer.address, CONTRACT, "get-admin");
  assertEqual("admin after correct accept (must have moved)", adminAfterRightAccept, second.address);
  console.log();

  console.log("Step 4 — Restore: transfer-admin(deployer) as SECOND KEY, accept as DEPLOYER");
  results.proposeBack = await callContract(
    second.privateKey, secondNonce++,
    deployer.address, CONTRACT, "transfer-admin", [Cl.principal(deployer.address)],
  );
  await waitForConfirm(results.proposeBack, "transfer-admin (propose back to deployer)");

  results.acceptBack = await callContract(
    deployer.privateKey, deployerNonce++,
    deployer.address, CONTRACT, "accept-admin", [],
  );
  await waitForConfirm(results.acceptBack, "accept-admin (restore deployer)");

  const finalAdmin = await callReadOnly(deployer.address, deployer.address, CONTRACT, "get-admin");
  assertEqual("final admin (restored)", finalAdmin, deployer.address);
  const finalPending = await callReadOnly(deployer.address, deployer.address, CONTRACT, "get-pending-admin");
  assertEqual("final pending-admin (restored)", finalPending, "none");
  console.log();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   BC1 NEGATIVE-PATH PROOF COMPLETE                   ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`  1. Propose (deployer -> second):   ${EXPLORER}/${results.propose}?chain=testnet`);
  console.log(`  2. REJECTED accept (wrong caller): ${EXPLORER}/${results.wrongAccept}?chain=testnet`);
  console.log(`  3. Accepted (correct caller):      ${EXPLORER}/${results.rightAccept}?chain=testnet`);
  console.log(`  4. Propose back:                   ${EXPLORER}/${results.proposeBack}?chain=testnet`);
  console.log(`  5. Accept back (restored):         ${EXPLORER}/${results.acceptBack}?chain=testnet`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();
  console.log("Add these 5 txids to docs/TESTNET_STAGING.md §6b as the negative-path proof,");
  console.log("and tick off: \"accept-admin from a non-pending principal fails\".");
}

main().catch(e => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
