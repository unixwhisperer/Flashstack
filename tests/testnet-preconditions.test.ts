import { describe, expect, it, vi, afterEach } from "vitest";
import { Cl, cvToHex } from "@stacks/transactions";
// @ts-expect-error — plain .mjs helper, no types
import {
  contractExists,
  assertAdminStepPreconditions,
} from "../scripts/lib/testnet-preconditions.mjs";

/**
 * Guards the guard.
 *
 * `deploy-testnet.mjs --steps=admin` skips Steps 1-7, so it no longer
 * establishes the state Step 8 assumes — it inherits whatever is on chain. The
 * precondition check is the only thing standing between "re-run Step 8" and
 * "broadcast admin calls at a contract in an unknown state with a funded key".
 *
 * Its failure mode is the dangerous direction: a guard that throws when it
 * shouldn't wastes a minute, a guard that PASSES when it shouldn't lets the run
 * proceed. So the cases below are weighted toward the passes-when-it-shouldn't
 * direction — the same reasoning that put assertEqual under test in #58.
 *
 * Wire formats match live testnet reads of
 * ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT.flashstack-stx-core-v2 (2026-09-21).
 */

const API = "https://api.testnet.hiro.so";
const DEPLOYER = "ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT";
const OTHER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const CORE = "flashstack-stx-core-v2";

afterEach(() => vi.unstubAllGlobals());

/** Stub the two endpoints the guard touches. `reads` maps fn name -> ClarityValue. */
function stubChain({ published = true, reads = {} as Record<string, any> }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.includes("/v2/contracts/interface/")) return { ok: published };
    const fn = url.split("/").pop()!;
    if (!(fn in reads)) throw new Error(`test stub: unexpected read of ${fn}`);
    return { json: async () => ({ okay: true, result: cvToHex(reads[fn]) }) };
  });
  return calls;
}

const CLEAN = {
  "get-admin": Cl.ok(Cl.principal(DEPLOYER)),
  "get-pending-admin": Cl.ok(Cl.none()),
};

describe("contractExists", () => {
  it("is true when the interface endpoint answers", async () => {
    stubChain({ published: true, reads: CLEAN });
    await expect(contractExists(API, DEPLOYER, CORE)).resolves.toBe(true);
  });

  it("is false on a 404 — not truthy-by-accident", async () => {
    stubChain({ published: false, reads: CLEAN });
    await expect(contractExists(API, DEPLOYER, CORE)).resolves.toBe(false);
  });
});

describe("assertAdminStepPreconditions", () => {
  it("passes on the state §6b left behind: deployed, deployer is admin, pending clear", async () => {
    stubChain({ published: true, reads: CLEAN });
    await expect(assertAdminStepPreconditions(API, DEPLOYER, CORE)).resolves.toBeUndefined();
  });

  it("REFUSES when nothing is published there", async () => {
    stubChain({ published: false, reads: CLEAN });
    await expect(assertAdminStepPreconditions(API, DEPLOYER, CORE))
      .rejects.toThrow(/no contract at ST3XQ5DM.*\.flashstack-stx-core-v2/);
  });

  it("does not read state at all when the contract is missing", async () => {
    // Reading get-admin off a contract that isn't there returns a node error,
    // and the operator would be debugging that instead of the real problem.
    const calls = stubChain({ published: false, reads: CLEAN });
    await expect(assertAdminStepPreconditions(API, DEPLOYER, CORE)).rejects.toThrow();
    expect(calls.filter((c) => c.includes("call-read"))).toHaveLength(0);
  });

  it("REFUSES when admin has moved to someone else — the dangerous case", async () => {
    // This is the state a half-finished deploy-testnet-bc1-negative.mjs leaves.
    // transfer-admin is admin-gated, so proceeding aborts mid-sequence and can
    // strand a live pending-admin.
    stubChain({
      published: true,
      reads: { ...CLEAN, "get-admin": Cl.ok(Cl.principal(OTHER)) },
    });
    await expect(assertAdminStepPreconditions(API, DEPLOYER, CORE))
      .rejects.toThrow(/admin is ST1PQHQ.*not the signing deployer/);
  });

  it("REFUSES when a proposal is already outstanding", async () => {
    stubChain({
      published: true,
      reads: { ...CLEAN, "get-pending-admin": Cl.ok(Cl.some(Cl.principal(OTHER))) },
    });
    await expect(assertAdminStepPreconditions(API, DEPLOYER, CORE))
      .rejects.toThrow(/pending-admin is \(some ST1PQHQ.*\), expected none/);
  });

  it("does not treat a pending proposal to the deployer itself as clear", async () => {
    // `(some <deployer>)` still means an unfinished run — Step 8's own
    // re-propose-to-self leaves exactly this until accept-admin lands.
    stubChain({
      published: true,
      reads: { ...CLEAN, "get-pending-admin": Cl.ok(Cl.some(Cl.principal(DEPLOYER))) },
    });
    await expect(assertAdminStepPreconditions(API, DEPLOYER, CORE))
      .rejects.toThrow(/pending-admin is \(some ST3XQ5DM.*\), expected none/);
  });

  it("propagates an (err ...) read rather than passing the guard", async () => {
    // A read that errors must not be silently treated as "not a mismatch".
    stubChain({
      published: true,
      reads: { ...CLEAN, "get-admin": Cl.error(Cl.uint(309)) },
    });
    await expect(assertAdminStepPreconditions(API, DEPLOYER, CORE))
      .rejects.toThrow(/returned \(err u309\)/);
  });
});
