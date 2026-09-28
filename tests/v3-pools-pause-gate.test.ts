import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * F-8 regression (docs/security/FINDINGS_REGISTER.md).
 *
 * `flashstack-stx-pool-v3` and `flashstack-sbtc-pool-v3` are the v2 pool sources
 * plus the two-step admin change. v2's `deposit` checked only `amount > 0`, so a
 * paused pool still accepted deposits while `flash-loan` correctly refused loans.
 * That is pv3-F3's shape, which was fixed in `flashstack-pool-v3` only. These
 * pools now gate `deposit` on the pause flag the same way.
 *
 * Four things are pinned, because the failure modes point in opposite directions:
 *   - deposit still works when not paused   (the guard must not over-block)
 *   - deposit is refused while paused       (the actual fix), and mints nothing
 *   - withdraw is NOT blocked by pause      (LPs can always exit; over-gating here
 *                                            would strand funds)
 *   - unpausing restores deposit
 *
 * The live v2 pools have the same gap and are immutable; nothing here changes them.
 */

const POOLS = [
  { name: "flashstack-stx-pool-v3", errPaused: 405, asset: "stx" },
  { name: "flashstack-sbtc-pool-v3", errPaused: 705, asset: "sbtc" },
] as const;

const AMOUNT = 1_000_000;

describe("F-8: v3 pools gate deposit on pause, and never gate withdraw", () => {
  let deployer: string;
  let lp: string;

  beforeEach(() => {
    deployer = simnet.getAccounts().get("deployer")!;
    lp = simnet.getAccounts().get("wallet_1")!;
  });

  const fund = (asset: string, who: string) => {
    if (asset === "sbtc") {
      simnet.callPublicFn("sbtc-token", "mint", [Cl.uint(AMOUNT * 10), Cl.principal(who)], deployer);
    }
  };
  const setPaused = (pool: string, val: boolean) =>
    simnet.callPublicFn(pool, "set-paused", [Cl.bool(val)], deployer);
  const deposit = (pool: string, who: string) =>
    simnet.callPublicFn(pool, "deposit", [Cl.uint(AMOUNT)], who);
  const shares = (pool: string, who: string) =>
    Number((simnet.callReadOnlyFn(pool, "get-shares", [Cl.principal(who)], deployer).result as any).value);

  for (const { name, errPaused, asset } of POOLS) {
    describe(name, () => {
      it("baseline: deposit succeeds when the pool is not paused", () => {
        fund(asset, lp);
        expect(deposit(name, lp).result.type).toBe("ok");
        expect(shares(name, lp)).toBeGreaterThan(0);
      });

      it("deposit is REJECTED while paused, with ERR-PAUSED, and mints no shares", () => {
        fund(asset, lp);
        expect(setPaused(name, true).result).toBeOk(Cl.bool(true));

        expect(deposit(name, lp).result).toBeErr(Cl.uint(errPaused));
        expect(shares(name, lp)).toBe(0);
      });

      it("withdraw is NOT blocked by pause: an LP can always exit", () => {
        fund(asset, lp);
        expect(deposit(name, lp).result.type).toBe("ok");
        const minted = shares(name, lp);

        expect(setPaused(name, true).result).toBeOk(Cl.bool(true));

        expect(simnet.callPublicFn(name, "withdraw", [Cl.uint(minted)], lp).result).toBeOk(Cl.uint(AMOUNT));
        expect(shares(name, lp)).toBe(0);
      });

      it("unpausing restores deposit", () => {
        fund(asset, lp);
        setPaused(name, true);
        expect(deposit(name, lp).result).toBeErr(Cl.uint(errPaused));

        // set-paused returns (ok (var-set ...)), and var-set always yields true, so
        // this is (ok true) for unpause too. The deposit below is what proves it.
        expect(setPaused(name, false).result).toBeOk(Cl.bool(true));
        expect(deposit(name, lp).result.type).toBe("ok");
        expect(shares(name, lp)).toBeGreaterThan(0);
      });
    });
  }
});
