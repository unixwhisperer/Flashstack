import { describe, expect, it, vi, afterEach } from "vitest";
import { Cl, cvToHex } from "@stacks/transactions";
// @ts-expect-error — plain .mjs helper, no types
import {
  decodeReadOnlyResult,
  assertEqual,
  callReadOnly,
} from "../scripts/lib/testnet-readonly.mjs";

/**
 * Guards the two functions that turn a testnet deploy into EVIDENCE rather than
 * a list of txids (docs/TESTNET_STAGING.md §6).
 *
 * These were inline in scripts/deploy-testnet.mjs, which process.exit(1)s at
 * import without TESTNET_MNEMONIC — so nothing could test them. That is a bad
 * place for assertEqual in particular: its failure mode is silent. An
 * assertEqual that never throws turns every staging assertion into "the
 * transaction did not revert", which is precisely the gap review found in the
 * original Step 8, and the same shape as F-7.
 *
 * Wire formats below are real, verified against live testnet reads of
 * ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT.flashstack-stx-core-v2 and
 * ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token on 2026-09-18.
 */

const DEPLOYER = "ST3XQ5DMH4BRXVZWAHKJFBNND17CPCSAYMV4T0NFT";
const OTHER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

afterEach(() => vi.unstubAllGlobals());

describe("decodeReadOnlyResult", () => {
  it("unwraps (ok principal) to a bare comparable principal", () => {
    expect(decodeReadOnlyResult(cvToHex(Cl.ok(Cl.principal(DEPLOYER))))).toBe(DEPLOYER);
  });

  it("renders (ok (some principal)) the way the call sites compare it", () => {
    // Step 8 asserts against the literal `(some ST…)`, so this format is load-bearing.
    expect(decodeReadOnlyResult(cvToHex(Cl.ok(Cl.some(Cl.principal(OTHER)))))).toBe(`(some ${OTHER})`);
  });

  it("renders (ok none) as \"none\"", () => {
    expect(decodeReadOnlyResult(cvToHex(Cl.ok(Cl.none())))).toBe("none");
  });

  it("unwraps (ok uint) — the reserve-balance / fee-bp shape", () => {
    expect(decodeReadOnlyResult(cvToHex(Cl.ok(Cl.uint(50005000))))).toBe("u50005000");
  });

  it("THROWS on (err ...) instead of returning something falsy", () => {
    // If this returned undefined, a downstream assertEqual comparing two
    // undefineds would pass and the evidence would be worthless.
    expect(() => decodeReadOnlyResult(cvToHex(Cl.error(Cl.uint(309))), "core.get-admin"))
      .toThrow(/core\.get-admin returned \(err u309\)/);
  });

  it("distinguishes two different principals", () => {
    // The whole BC1 assertion rests on this. A decoder that collapsed both to
    // the same string would report "admin unchanged" even after it moved.
    expect(decodeReadOnlyResult(cvToHex(Cl.ok(Cl.principal(DEPLOYER)))))
      .not.toBe(decodeReadOnlyResult(cvToHex(Cl.ok(Cl.principal(OTHER)))));
  });
});

describe("assertEqual", () => {
  it("passes when equal", () => {
    expect(() => assertEqual("admin unchanged", DEPLOYER, DEPLOYER)).not.toThrow();
  });

  it("THROWS on mismatch, naming what was being proven", () => {
    expect(() => assertEqual("admin after propose (must NOT have moved)", OTHER, DEPLOYER))
      .toThrow(/ASSERTION FAILED — admin after propose \(must NOT have moved\)/);
  });

  it("is strict — no coercion between undefined, null and empty string", () => {
    expect(() => assertEqual("pending cleared", undefined, "none")).toThrow();
    expect(() => assertEqual("pending cleared", null, "none")).toThrow();
    expect(() => assertEqual("pending cleared", "", "none")).toThrow();
  });
});

describe("callReadOnly", () => {
  it("throws when the node reports okay:false rather than decoding garbage", async () => {
    vi.stubGlobal("fetch", async () => ({
      json: async () => ({ okay: false, cause: 'RuntimeCheck(UndefinedFunction("get-paused"))' }),
    }));
    await expect(
      callReadOnly("https://api.testnet.hiro.so", DEPLOYER, DEPLOYER, "flashstack-stx-core-v2", "get-paused"),
    ).rejects.toThrow(/callReadOnly flashstack-stx-core-v2\.get-paused failed/);
  });

  it("decodes a successful response through decodeReadOnlyResult", async () => {
    vi.stubGlobal("fetch", async () => ({
      json: async () => ({ okay: true, result: cvToHex(Cl.ok(Cl.principal(DEPLOYER))) }),
    }));
    await expect(
      callReadOnly("https://api.testnet.hiro.so", DEPLOYER, DEPLOYER, "flashstack-stx-core-v2", "get-admin"),
    ).resolves.toBe(DEPLOYER);
  });
});

describe("the BC1 property these functions exist to establish", () => {
  // The bug this whole review thread was about: Step 8 originally proposed the
  // admin transfer to ITSELF and accepted, so admin was the deployer before and
  // after. That sequence cannot tell a correct two-step contract apart from a
  // broken one-step one — both emit successful txids. Pinned here so it cannot
  // come back the next time someone edits the script inline.

  const adminAfterProposeOn = (contract: "two-step" | "one-step", proposed: string, current: string) =>
    // A two-step contract records the proposal and leaves admin alone.
    // A one-step contract applies it immediately.
    decodeReadOnlyResult(cvToHex(Cl.ok(Cl.principal(contract === "two-step" ? current : proposed))));

  it("FAILS against a one-step implementation", () => {
    const admin = adminAfterProposeOn("one-step", OTHER, DEPLOYER);
    expect(() => assertEqual("admin after propose (must NOT have moved)", admin, DEPLOYER))
      .toThrow(/ASSERTION FAILED/);
  });

  it("PASSES against the correct two-step implementation", () => {
    const admin = adminAfterProposeOn("two-step", OTHER, DEPLOYER);
    expect(() => assertEqual("admin after propose (must NOT have moved)", admin, DEPLOYER))
      .not.toThrow();
  });

  it("would NOT have caught the bug if the proposal went to self — the original flaw", () => {
    // Proposing to self: both implementations leave admin reading as DEPLOYER,
    // so the assertion passes either way and proves nothing. This is why Step 8
    // must propose to a principal the signing key does not control.
    const twoStep = adminAfterProposeOn("two-step", DEPLOYER, DEPLOYER);
    const oneStep = adminAfterProposeOn("one-step", DEPLOYER, DEPLOYER);
    expect(twoStep).toBe(oneStep);
    expect(() => assertEqual("admin unchanged", oneStep, DEPLOYER)).not.toThrow();
  });
});
