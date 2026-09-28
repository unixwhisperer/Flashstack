import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * BC1 FIX verification — two-step admin transfer neutralizes the lockout.
 *
 * For each hardened successor (flashstack-{sbtc,stx}-pool-v3, flashstack-{sbtc,stx}-core-v2):
 *  1. Proposing an uncontrolled admin does NOT change admin (no lockout) — the exact
 *     sequence that permanently bricks the one-step deployed contracts.
 *  2. The original admin retains control and can RECOVER by re-proposing a good admin.
 *  3. accept-admin actually transfers to a controlled principal.
 *  4. A non-pending principal cannot accept.
 */

const DEAD = "ST000000000000000000002AMW42H"; // no key exists — models a fat-fingered address

const CASES = [
  { name: "flashstack-sbtc-pool-v3", propose: "transfer-admin", errNotPending: 711 },
  { name: "flashstack-stx-pool-v3",  propose: "transfer-admin", errNotPending: 410 },
  { name: "flashstack-sbtc-core-v2", propose: "set-admin",      errNotPending: 312 },
  { name: "flashstack-stx-core-v2",  propose: "transfer-admin", errNotPending: 309 },
];

describe("BC1 fix: two-step admin transfer prevents the lockout", () => {
  let deployer: string, good: string, other: string;
  beforeEach(() => {
    deployer = simnet.getAccounts().get("deployer")!;
    good = simnet.getAccounts().get("wallet_1")!;
    other = simnet.getAccounts().get("wallet_2")!;
  });

  for (const { name, propose, errNotPending } of CASES) {
    it(`${name}: a bad proposal never locks out, and admin is recoverable`, () => {
      // Propose a principal nobody controls — the lockout trigger on the one-step version.
      expect(simnet.callPublicFn(name, propose, [Cl.principal(DEAD)], deployer).result).toBeOk(Cl.bool(true));

      // Admin is UNCHANGED — the mistake did not take effect.
      expect(simnet.callReadOnlyFn(name, "get-admin", [], deployer).result).toBeOk(Cl.principal(deployer));
      expect(simnet.callReadOnlyFn(name, "get-pending-admin", [], deployer).result).toBeOk(Cl.some(Cl.principal(DEAD)));

      // Original admin still governs (proof it is not bricked).
      expect(simnet.callPublicFn(name, "set-paused", [Cl.bool(true)], deployer).result).toBeOk(Cl.bool(true));

      // RECOVER: re-propose the correct admin, who then accepts.
      expect(simnet.callPublicFn(name, propose, [Cl.principal(good)], deployer).result).toBeOk(Cl.bool(true));
      expect(simnet.callPublicFn(name, "accept-admin", [], good).result).toBeOk(Cl.bool(true));
      expect(simnet.callReadOnlyFn(name, "get-admin", [], deployer).result).toBeOk(Cl.principal(good));
    });

    it(`${name}: a non-pending principal cannot accept`, () => {
      simnet.callPublicFn(name, propose, [Cl.principal(good)], deployer);
      expect(simnet.callPublicFn(name, "accept-admin", [], other).result).toBeErr(Cl.uint(errNotPending));
    });
  }
});
