import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Canonical-source drift guard (CONTRACT_INVENTORY.md §5 D6, §7.3).
 *
 * Clarinet keys contracts by name, so `Clarinet.toml` can register only ONE file
 * per contract name. For every funds-bearing contract it registers the localized
 * simnet copy under contracts/test/ — which means `clarinet check` and the whole
 * test suite compile the COPY, and the canonical contracts/*.clar source (the file
 * an auditor reads and a deployment publishes) is compiled by nothing.
 *
 * That is only safe while the copy really is the canonical source with addresses
 * localized and nothing else. Until now nothing enforced that: F-7 is exactly the
 * failure it allows — contracts/test/flashstack-stx-core.clar silently acquired the
 * BC1 two-step admin fix, so the "deployed core" suite spent weeks proving things
 * about a contract that does not exist on mainnet.
 *
 * tests/mainnet-fidelity.test.ts pins the *behavioral shape* of 6 live contracts
 * against what is actually deployed. This test is the complementary half: textual
 * equivalence for all 14 canonical/copy pairs, so a logic change to either side
 * fails CI rather than going unnoticed.
 *
 * THE RULE: the localized copy must equal the canonical source after
 *   (a) stripping `;;` comments and blank lines, and
 *   (b) rewriting every absolute contract reference 'SP…\.name to .name
 * Any other difference — a changed guard, an added function, a different
 * constant — is drift, and fails here.
 *
 * If a difference is legitimate, the contract is not a localized copy: give it its
 * own name as a successor (the pattern flashstack-stx-core-v2 already follows).
 */

const CANON_DIR = "contracts";
const COPY_DIR = join("contracts", "test");

// Stacks c32 principal, e.g. 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core
const ABSOLUTE_CONTRACT_REF = /'S[0-9A-HJKMNP-TV-Z]{38,41}\./g;

function normalize(path: string): string[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.replace(/;;.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "")
    .map((line) => line.replace(ABSOLUTE_CONTRACT_REF, "."));
}

/** Every contracts/test/*.clar that mirrors a same-named contracts/*.clar. */
const PAIRS = readdirSync(COPY_DIR)
  .filter((f) => f.endsWith(".clar"))
  .filter((f) => existsSync(join(CANON_DIR, f)))
  .sort();

describe("localized simnet copies must not drift from their canonical source", () => {
  it("finds the expected number of canonical/copy pairs", () => {
    // Guards against the pair set silently shrinking — a copy being deleted, or a
    // canonical source being renamed, would otherwise just reduce the loop below
    // to nothing and pass. Bump this deliberately when a pair is added or removed.
    expect(PAIRS.length, `pairs found: ${PAIRS.join(", ")}`).toBe(14);
  });

  for (const file of PAIRS) {
    it(`${file}: differs from contracts/${file} by address localization only`, () => {
      const canonical = normalize(join(CANON_DIR, file));
      const copy = normalize(join(COPY_DIR, file));

      expect(
        copy.length,
        `contracts/test/${file} has ${copy.length} code lines, contracts/${file} has ${canonical.length} — ` +
          `a localized copy must be line-for-line identical once comments are stripped`,
      ).toBe(canonical.length);

      for (let i = 0; i < canonical.length; i++) {
        expect(
          copy[i],
          `drift at code line ${i + 1} of ${file}:\n` +
            `  contracts/${file}:      ${canonical[i]}\n` +
            `  contracts/test/${file}: ${copy[i]}\n` +
            `A localized copy may only rewrite 'SP….name to .name. If this difference is ` +
            `intentional, it is a successor contract, not a copy — give it its own name.`,
        ).toBe(canonical[i]);
      }
    });
  }
});
