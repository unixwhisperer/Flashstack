import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helper, no types
import {
  localize,
  residualMainnetRefs,
  OURS,
  THIRD_PARTY,
  TESTNET_EQUIVALENT,
} from "../scripts/lib/testnet-localize.mjs";

/**
 * Guards the testnet address localizer (docs/TESTNET_STAGING.md §5.1).
 *
 * scripts/deploy-testnet.mjs rewrites hardcoded mainnet principals to the
 * testnet deployer before publishing. It used to know about exactly TWO
 * principals, while the current generation references three more — so a
 * current-gen deploy would have been broadcast with an unresolved contract
 * reference and aborted at publish time, burning the contract name permanently
 * at that address (the same way the live system ended up with -v2/-v3 suffixes).
 *
 * These tests pin which contracts are stageable and which are not, so the answer
 * is mechanical rather than a claim in a document.
 */

const DEPLOYER = "ST2X1GBHA2WJXREWP231EEQXZ1GDYZEEXYRAD1PA8"; // shape-valid testnet principal

const read = (p: string) => readFileSync(join("contracts", p), "utf-8");

/**
 * The full current-generation testnet staging set.
 *
 * The sBTC pair was previously listed as NOT stageable: canonical sBTC is
 * mainnet-only, so staging meant a mock. That turned out to be wrong — a
 * byte-identical sBTC deployment exists on testnet (TESTNET_STAGING.md §5.2), so
 * they localize cleanly via TESTNET_EQUIVALENT and are stageable faithfully.
 */
const STAGEABLE = [
  "stx-flash-receiver-trait.clar",
  "flashstack-stx-core-v2.clar",
  "flashstack-stx-pool-v3.clar",
  "flashstack-v3-receiver-trait.clar",
  "flashstack-pool-v3.clar",
  "test/sip-010-trait-ft-standard.clar",
  "flashstack-sbtc-core-v2.clar",
  "flashstack-sbtc-pool-v3.clar",
];

/** Genuinely unstageable: real DeFi integrations with no testnet counterpart. */
const NOT_STAGEABLE: Array<[string, string]> = [
  ["zest-liquidation-receiver.clar", "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N"], // Zest
  ["zest-v2-liquidation-receiver.clar", "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR"], // Arkadiko
  ["alex-arb-receiver-v5.clar", "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM"], // ALEX
];

describe("testnet localizer", () => {
  it("the three principal sets are mutually disjoint", () => {
    const ours = Object.keys(OURS);
    const eq = Object.keys(TESTNET_EQUIVALENT);
    const third = Object.keys(THIRD_PARTY);
    expect(ours.filter((a) => a in THIRD_PARTY), "ours vs third-party").toEqual([]);
    expect(ours.filter((a) => a in TESTNET_EQUIVALENT), "ours vs testnet-equivalent").toEqual([]);
    expect(eq.filter((a) => a in THIRD_PARTY), "testnet-equivalent vs third-party").toEqual([]);
    expect(third.length).toBeGreaterThan(0);
  });

  it("every TESTNET_EQUIVALENT target is a testnet principal, not a mainnet one", () => {
    for (const [mainnet, { testnet }] of Object.entries(TESTNET_EQUIVALENT) as any) {
      expect(mainnet, `${mainnet} should be a mainnet principal`).toMatch(/^S[PM]/);
      expect(testnet, `${testnet} should be a testnet principal`).toMatch(/^S[TN]/);
    }
  });

  describe("current-generation contracts localize completely", () => {
    for (const file of STAGEABLE) {
      it(`${file}: no mainnet principal survives localization`, () => {
        const left = residualMainnetRefs(localize(read(file), DEPLOYER));
        expect(
          left,
          `${file} would abort at publish time on unresolved contract(s): ${left.join(", ")}`,
        ).toEqual([]);
      });
    }
  });

  describe("sBTC is remapped to its verified testnet deployment, not to us and not to a mock", () => {
    const SBTC_MAINNET = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
    const SBTC_TESTNET = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

    for (const file of ["flashstack-sbtc-core-v2.clar", "flashstack-sbtc-pool-v3.clar"]) {
      it(`${file}: sBTC points at the testnet deployment, NOT at the deployer`, () => {
        const out = localize(read(file), DEPLOYER);
        expect(out, "mainnet sBTC must not survive").not.toContain(SBTC_MAINNET);
        expect(out, "sBTC must resolve to the verified testnet set").toContain(SBTC_TESTNET);
        // The load-bearing assertion: remapping sBTC to OUR deployer would make the
        // contract publish successfully against a token we invented, which is the
        // mock outcome §5.2 exists to avoid. It must resolve elsewhere.
        expect(out.includes(`'${DEPLOYER}.sbtc-token`), "sBTC must not be aliased to our own deployer").toBe(false);
      });
    }
  });

  describe("contracts with real DeFi integrations are still correctly blocked", () => {
    for (const [file, principal] of NOT_STAGEABLE) {
      it(`${file}: still references a mainnet protocol, so is not stageable`, () => {
        const left = residualMainnetRefs(localize(read(file), DEPLOYER));
        expect(left).toContain(principal);
      });
    }
  });

  it("catches the exact regression that motivated this: the old two-principal list", () => {
    // What the previous patcher did — gen-1 and gen-2 deployers only.
    const OLD = ["SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ", "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5"];
    let src = read("flashstack-pool-v3.clar");
    for (const a of OLD) src = src.replaceAll(a, DEPLOYER);

    // pool-v3's two references are to NEITHER of those, so the old patcher was a no-op.
    expect(residualMainnetRefs(src).sort()).toEqual([
      "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
      "SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG",
    ]);
    // The new localizer handles both.
    expect(residualMainnetRefs(localize(read("flashstack-pool-v3.clar"), DEPLOYER))).toEqual([]);
  });
});
