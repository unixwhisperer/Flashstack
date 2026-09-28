import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * Mainnet fidelity guard.
 *
 * Several contracts in contracts/test/ are declared in Clarinet.toml to be localized
 * copies of immutable mainnet deployments — the ONLY permitted difference is address
 * localization (trait / token / pool refs pointed at simnet contracts). Those copies
 * are what the "deployed behavior" suites assert against, so if one silently acquires
 * a fix that mainnet does not have, the suite starts proving things about a contract
 * that does not exist.
 *
 * That is exactly what happened to flashstack-stx-core: the BC1 two-step admin
 * transfer was applied in place to the copy of the deployed contract, so the suite
 * exercised an accept-admin step that mainnet has never had.
 *
 * These tests pin the ACTUAL deployed shape. They are deliberately uncomfortable:
 * they assert the presence of a known weakness. They should fail the day the
 * corresponding contract is REDEPLOYED with the fix — at which point the fix moves
 * into the copy and these assertions are updated in the same change.
 *
 * Verified against mainnet 2026-09-15 via
 *   GET https://api.hiro.so/v2/contracts/interface/<principal>/<name>
 */

// Every live core/pool exposes one-step admin transfer and NO accept step.
// name -> the transfer function it actually deploys.
const LIVE_ONE_STEP: Array<[string, string]> = [
  ["flashstack-stx-core", "transfer-admin"],
  ["flashstack-sbtc-core", "set-admin"],
  ["flashstack-stx-pool-v2", "transfer-admin"],
  ["flashstack-sbtc-pool-v2", "transfer-admin"],
  ["flashstack-stx-pool", "transfer-admin"],
  ["flashstack-sbtc-pool", "transfer-admin"],
];

describe("mainnet fidelity: localized copies must match the deployed contract", () => {
  let deployer: string;
  beforeEach(() => { deployer = simnet.getAccounts().get("deployer")!; });

  for (const [name, transferFn] of LIVE_ONE_STEP) {
    it(`${name}: still one-step (${transferFn}, no accept-admin) — matches mainnet`, () => {
      const iface = simnet.getContractsInterfaces().get(`${deployer}.${name}`);
      expect(iface, `${name} must be registered in Clarinet.toml`).toBeDefined();

      const fns = iface!.functions.filter((f: any) => f.access === "public").map((f: any) => f.name);
      expect(fns, `${name} should expose ${transferFn}`).toContain(transferFn);

      // The load-bearing assertion: mainnet has no second step, so neither may the copy.
      expect(fns, `${name} must NOT carry an undeployed accept-admin — put the fix in a successor`)
        .not.toContain("accept-admin");
    });
  }

  it("flashstack-stx-core: transfer-admin takes effect IMMEDIATELY, as deployed", () => {
    const CORE = "flashstack-stx-core";
    const other = simnet.getAccounts().get("wallet_1")!;

    expect(simnet.callReadOnlyFn(CORE, "get-admin", [], deployer).result).toBeOk(Cl.principal(deployer));
    expect(simnet.callPublicFn(CORE, "transfer-admin", [Cl.principal(other)], deployer).result)
      .toBeOk(Cl.bool(true));
    // No accept step exists: admin has already changed.
    expect(simnet.callReadOnlyFn(CORE, "get-admin", [], deployer).result).toBeOk(Cl.principal(other));
    // ...and the previous admin is immediately locked out.
    expect(simnet.callPublicFn(CORE, "set-paused", [Cl.bool(true)], deployer).result).toBeErr(Cl.uint(300));
  });

  it("flashstack-stx-core: calculate-fee(u0) returns ok u1, as deployed (does NOT reject u0)", () => {
    // The hardened successor adds an (asserts! (> amount u0)) here. The deployed
    // contract does not, and receivers integrate against the deployed behavior.
    expect(simnet.callReadOnlyFn("flashstack-stx-core", "calculate-fee", [Cl.uint(0)], deployer).result)
      .toBeOk(Cl.uint(1));
  });

  it("flashstack-stx-core-v2: the successor DOES have the two-step fix", () => {
    const iface = simnet.getContractsInterfaces().get(`${deployer}.flashstack-stx-core-v2`);
    expect(iface).toBeDefined();
    const fns = iface!.functions.filter((f: any) => f.access === "public").map((f: any) => f.name);
    expect(fns).toContain("transfer-admin");
    expect(fns).toContain("accept-admin");
  });
});
