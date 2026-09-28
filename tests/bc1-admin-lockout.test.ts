import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

/**
 * BC1 — self-gated, one-step admin transfer with no recovery path.
 *
 * Demonstrated against flashstack-sbtc-pool-v2 (the local copy is byte-identical
 * to the mainnet deployment, verified: deployed interface exposes transfer-admin
 * but NO accept-admin/pending-admin). The same shape is deployed on
 * flashstack-stx-core, flashstack-sbtc-core (set-admin), and flashstack-stx-pool-v2.
 *
 * Trigger: only the CURRENT admin can call transfer-admin, so an arbitrary
 * attacker cannot reach this — it is a trusted-operator footgun. But a single bad
 * value permanently bricks every privileged function with no on-chain recovery.
 */

const POOL = "flashstack-sbtc-pool-v2";
const ERR_NOT_ADMIN = 700;
// A standard principal with no known key (testnet boot address) — nobody can ever
// sign as it, so setting admin to it is unrecoverable (models a fat-fingered address).
const DEAD_PRINCIPAL = "ST000000000000000000002AMW42H";

describe("BC1: one-step self-gated admin transfer is permanently unrecoverable", () => {
  let deployer: string;
  beforeEach(() => { deployer = simnet.getAccounts().get("deployer")!; });

  it("transfer-admin to an uncontrolled principal bricks every admin function", () => {
    // Baseline: deployer is admin and governance works.
    expect(simnet.callReadOnlyFn(POOL, "get-admin", [], deployer).result).toBeOk(Cl.principal(deployer));
    expect(simnet.callPublicFn(POOL, "set-paused", [Cl.bool(true)], deployer).result).toBeOk(Cl.bool(true));

    // One-step transfer takes effect IMMEDIATELY — no accept step to catch a mistake.
    expect(simnet.callPublicFn(POOL, "transfer-admin", [Cl.principal(DEAD_PRINCIPAL)], deployer).result)
      .toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(POOL, "get-admin", [], deployer).result).toBeOk(Cl.principal(DEAD_PRINCIPAL));

    // The original admin is now locked out of EVERY privileged function...
    expect(simnet.callPublicFn(POOL, "set-paused", [Cl.bool(false)], deployer).result).toBeErr(Cl.uint(ERR_NOT_ADMIN));
    expect(simnet.callPublicFn(POOL, "add-approved-receiver", [Cl.principal(deployer)], deployer).result).toBeErr(Cl.uint(ERR_NOT_ADMIN));
    expect(simnet.callPublicFn(POOL, "set-fee-basis-points", [Cl.uint(10)], deployer).result).toBeErr(Cl.uint(ERR_NOT_ADMIN));
    expect(simnet.callPublicFn(POOL, "set-max-single-loan", [Cl.uint(1000)], deployer).result).toBeErr(Cl.uint(ERR_NOT_ADMIN));

    // ...and can NEVER reclaim it: transfer-admin itself is gated by the (now dead) admin.
    expect(simnet.callPublicFn(POOL, "transfer-admin", [Cl.principal(deployer)], deployer).result).toBeErr(Cl.uint(ERR_NOT_ADMIN));

    // There is no accept-admin, timelock, or alternate admin. DEAD_PRINCIPAL can never
    // sign a tx, so governance (pause, fee, receiver allowlist) is bricked forever.
    // (LP funds remain withdrawable — the pool `withdraw` path is not admin-gated.)
  });

  it("CONTRAST: a two-step transfer would NOT lock out — the mistaken admin never accepts", () => {
    // flashstack-stx-core-v2 is the BC1 successor: transfer-admin + accept-admin.
    // NOT flashstack-stx-core — that is the faithful copy of the one-step mainnet
    // contract and must keep the deployed behavior.
    const CORE = "flashstack-stx-core-v2";
    const registered = simnet.getContractsInterfaces().has(`${deployer}.${CORE}`);
    if (!registered) { console.log("  (flashstack-stx-core-v2 not registered in this simnet — skipping contrast)"); return; }

    // Propose a dead admin. With two-step, admin does NOT change until accept-admin.
    expect(simnet.callPublicFn(CORE, "transfer-admin", [Cl.principal(DEAD_PRINCIPAL)], deployer).result).toBeOk(Cl.bool(true));
    // Original admin is STILL in control — recoverable by re-proposing the correct one.
    expect(simnet.callReadOnlyFn(CORE, "get-admin", [], deployer).result).toBeOk(Cl.principal(deployer));
    expect(simnet.callPublicFn(CORE, "set-paused", [Cl.bool(true)], deployer).result).toBeOk(Cl.bool(true));
  });
});
