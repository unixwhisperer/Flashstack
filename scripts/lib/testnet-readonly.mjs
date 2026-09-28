/**
 * Read-only contract reads + assertions for testnet staging evidence.
 *
 * Extracted verbatim from scripts/deploy-testnet.mjs (#56) — same signatures,
 * same behaviour, same output. The only change is that they now live where a
 * test can import them.
 *
 * Why that matters: deploy-testnet.mjs `process.exit(1)`s at import when
 * TESTNET_MNEMONIC is unset, so nothing could reach these two functions. That
 * is a bad place for `assertEqual` in particular, because its failure mode is
 * silent — an assertEqual that never throws turns every piece of staging
 * evidence into "the transaction did not revert", which is exactly the gap the
 * #56 review found in the original Step 8 and exactly the shape of F-7.
 *
 * A deploy script that only records txids proves transactions succeeded. It
 * does not prove the contract reached the state you wanted. For BC1 the
 * difference is the whole point: a broken one-step implementation emits the
 * same successful txids as a correct two-step one. Evidence has to read state
 * back, and the thing doing the reading has to be trustworthy.
 *
 * See docs/TESTNET_STAGING.md §6.
 */

import { cvToHex, cvToString, hexToCV } from "@stacks/transactions";

/**
 * Decode a `/v2/contracts/call-read` result hex into a clean, directly
 * comparable string — the response unwrapped, e.g. "ST3XQ5…", "(some ST3XQ5…)",
 * "none" — rather than raw hex or "(ok X)".
 *
 * Split out from callReadOnly so the decoding can be tested without a network
 * round trip. Throws on `(err ...)`: returning a falsy value there would make
 * every downstream assertEqual compare undefined to undefined and pass.
 */
export function decodeReadOnlyResult(resultHex, label = "read-only call") {
  const decoded = hexToCV(resultHex);
  if (decoded.type === "err") {
    throw new Error(`${label} returned (err ${cvToString(decoded.value)})`);
  }
  // decoded.type === "ok" for every read-only in this codebase (all wrap their
  // return in (ok ...)) -- unwrap it so callers compare a clean value.
  return cvToString(decoded.type === "ok" ? decoded.value : decoded);
}

/**
 * Call a read-only function and return its unwrapped value as a string.
 * `args` are ClarityValues (e.g. from `Cl.principal(...)`).
 */
export async function callReadOnly(api, sender, contractAddress, contractName, fn, args = []) {
  const res = await fetch(`${api}/v2/contracts/call-read/${contractAddress}/${contractName}/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args.map((a) => cvToHex(a)) }),
  });
  const data = await res.json();
  if (!data.okay) {
    throw new Error(`callReadOnly ${contractName}.${fn} failed: ${JSON.stringify(data)}`);
  }
  return decodeReadOnlyResult(data.result, `${contractName}.${fn}`);
}

/** Assert equality and say what was being proven. Throws on mismatch. */
export function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED — ${label}: expected "${expected}", got "${actual}"`);
  }
  console.log(`  OK: ${label} = ${actual}`);
}
