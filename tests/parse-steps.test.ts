import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs helper, no types
import { parseSteps } from "../scripts/lib/parse-steps.mjs";

/**
 * `--steps` is a control, not argument handling.
 *
 * It selects whether a funded key re-runs Step 8 against an existing deployment
 * or publishes the whole contract line. The original parser used
 * `argv.find(a => a.startsWith("--steps="))` with `?? "all"`, so anything not
 * starting with exactly `--steps=` fell through to the default -- and the
 * default is the expensive mode. `--steps admin` and `--step=admin` both
 * selected a full deploy.
 *
 * The sharp edge is not the wasted deploy. `assertAdminStepPreconditions` only
 * runs in admin mode, so a typo did not merely pick the wrong mode: it skipped
 * the guard entirely, in precisely the case the guard exists for. That is a
 * fail-open default on a control path, and it is what these tests pin shut.
 *
 * Weighted, like tests/testnet-preconditions.test.ts, toward the
 * passes-when-it-shouldn't direction: a parser that throws on something valid
 * costs a retype; a parser that accepts something invalid broadcasts.
 */

// parseSteps reads process.argv, so tests pass the argv[0]/argv[1] prefix.
const argv = (...args: string[]) => ["node", "scripts/deploy-testnet.mjs", ...args];

describe("parseSteps — the accepted set is exactly two spellings", () => {
  it("defaults to 'all' when no arguments are given", () => {
    expect(parseSteps(argv())).toBe("all");
  });

  it("accepts --steps=all", () => {
    expect(parseSteps(argv("--steps=all"))).toBe("all");
  });

  it("accepts --steps=admin", () => {
    expect(parseSteps(argv("--steps=admin"))).toBe("admin");
  });

  it("is case-insensitive and normalises to lowercase", () => {
    expect(parseSteps(argv("--steps=ADMIN"))).toBe("admin");
    expect(parseSteps(argv("--STEPS=Admin"))).toBe("admin");
    expect(parseSteps(argv("--steps=ALL"))).toBe("all");
  });
});

describe("parseSteps — malformed input throws instead of selecting full deploy", () => {
  // Each of these returned "all" (full deploy) under the old parser.
  const silentlyFullDeploy = [
    ["space form", "--steps", "admin"],
    ["one-letter typo", "--step=admin"],
    ["no equals", "--stepsXadmin"],
    ["unrelated argument", "--dry-run"],
    ["bare value", "admin"],
  ] as const;

  for (const [label, ...args] of silentlyFullDeploy) {
    it(`throws on ${label}: ${args.join(" ")}`, () => {
      expect(() => parseSteps(argv(...args))).toThrow(/refusing to run/i);
    });
  }

  it("throws on an empty value (--steps=)", () => {
    expect(() => parseSteps(argv("--steps="))).toThrow(/refusing to run/i);
  });

  it("throws on an unknown mode (--steps=bogus)", () => {
    expect(() => parseSteps(argv("--steps=bogus"))).toThrow(/refusing to run/i);
  });

  it("throws on duplicate flags rather than letting the first win", () => {
    // The old parser returned "all" here -- the expensive mode, chosen by
    // position, when the operator had explicitly asked for admin.
    expect(() => parseSteps(argv("--steps=all", "--steps=admin"))).toThrow(/refusing to run/i);
    expect(() => parseSteps(argv("--steps=admin", "--steps=admin"))).toThrow(/refusing to run/i);
  });

  it("throws on a valid flag followed by anything else", () => {
    expect(() => parseSteps(argv("--steps=admin", "--force"))).toThrow(/refusing to run/i);
  });
});

describe("parseSteps — the error says what it refused to do", () => {
  it("names the rejected argument, so the operator can see the typo", () => {
    expect(() => parseSteps(argv("--step=admin"))).toThrow(/--step=admin/);
  });

  it("states that it is NOT falling back to the full deploy", () => {
    // The whole failure being fixed is a silent fall-through to full deploy.
    // An error that does not say so invites the operator to shrug and re-run.
    expect(() => parseSteps(argv("--step=admin"))).toThrow(/FULL DEPLOY/);
  });

  it("names both valid spellings", () => {
    expect(() => parseSteps(argv("--steps=bogus"))).toThrow(/--steps=all/);
    expect(() => parseSteps(argv("--steps=bogus"))).toThrow(/--steps=admin/);
  });
});
