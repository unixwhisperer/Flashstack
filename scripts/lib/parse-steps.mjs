/**
 * `--steps` parser for deploy-testnet.mjs.
 *
 * Lives here, not inline in deploy-testnet.mjs, for the reason #58 moved
 * callReadOnly/assertEqual out: that script `process.exit(1)`s at import without
 * TESTNET_MNEMONIC, so nothing defined inside it can be reached by a test.
 *
 * Why this is a control and not argument handling: `--steps` selects whether a
 * funded key re-runs Step 8 against an existing deployment, or publishes the
 * whole contract line. The previous parser was
 *
 *   (argv.find(a => a.startsWith("--steps="))?.split("=")[1] ?? "all")
 *
 * which silently fell through to the default on anything that did not start with
 * exactly `--steps=` -- and the default is the expensive mode. `--steps admin`
 * (space) and `--step=admin` (typo) both selected a full deploy. Worse, the
 * precondition guard in testnet-preconditions.mjs only runs in admin mode, so a
 * typo did not merely pick the wrong mode: it routed around the guard entirely,
 * in exactly the case the guard exists for. Fail-open on a control path.
 *
 * So this is allow-list only: exactly one argument, matching exactly
 * `--steps=all` or `--steps=admin`. Anything else throws. There is deliberately
 * no "best effort" interpretation -- guessing what the operator meant is how the
 * space form got treated as the default in the first place.
 */

const VALID = /^--steps=(all|admin)$/i;

export function parseSteps(argv) {
  const args = argv.slice(2);

  if (args.length > 1) {
    throw new Error(
      `refusing to run: expected at most one --steps argument, got ${args.length} (${args.join(" ")}). ` +
      `Use --steps=all (default, full deploy) or --steps=admin (Step 8 only).`
    );
  }

  if (args.length === 1 && !VALID.test(args[0])) {
    throw new Error(
      `refusing to run: unrecognised argument "${args[0]}". ` +
      `Not running --steps=all (the default) as a fallback, because that is the FULL DEPLOY and ` +
      `publishes the whole contract line. Use --steps=all or --steps=admin explicitly.`
    );
  }

  return (args[0]?.split("=")[1] ?? "all").toLowerCase();
}
