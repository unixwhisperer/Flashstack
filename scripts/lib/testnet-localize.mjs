/**
 * Testnet source localization.
 *
 * Contracts hardcode mainnet principals in `use-trait`, `impl-trait` and
 * `contract-call?` references. To publish on testnet those must be rewritten to
 * principals that exist there.
 *
 * Two kinds, and conflating them is how a deploy silently aborts:
 *
 *   OURS               — contracts FlashStack publishes itself. On testnet we
 *                        publish them under the testnet deployer, so every
 *                        reference rewrites to that deployer.
 *   TESTNET_EQUIVALENT — third-party contracts with a VERIFIED byte-identical
 *                        testnet deployment. Remapped to that principal, so the
 *                        staged contract exercises the real dependency rather
 *                        than a mock. Entries require a source-hash comparison.
 *   THIRD_PARTY        — live mainnet protocols (ALEX, Zest, Arkadiko, Velar,
 *                        Bitflow, StackingDAO...) with NO testnet equivalent. A
 *                        contract still referencing one after localization cannot
 *                        be staged, and must say so loudly rather than be
 *                        published against a wrong address.
 *
 * Before this module, scripts/deploy-testnet.mjs knew about exactly two
 * principals and silently left every other one in place — so the current
 * generation (which references three more) would have aborted at publish time
 * with an unresolved contract. See docs/TESTNET_STAGING.md §5.1.
 */

/** Principals FlashStack publishes itself -> rewritten to the testnet deployer. */
export const OURS = {
  SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ: "gen-1 deployer (stx-flash-receiver-trait, gen-1 receivers)",
  SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5: "gen-2 deployer (sbtc-flash-receiver-trait, live cores + v1 pools)",
  SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG: "secure admin wallet (v2 pools, oracle-v2, flashstack-v3-receiver-trait)",
  // Third-party by origin, but we carry our own copy at
  // contracts/test/sip-010-trait-ft-standard.clar and publish it first on
  // testnet, so for staging purposes it behaves as ours. Testnet has been
  // regenesised and carries no canonical copy — see TESTNET_STAGING.md §5.1.
  SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE: "SIP-010 standard trait (we publish our own copy)",
};

/**
 * Third-party mainnet contracts that have a VERIFIED byte-identical deployment on
 * testnet. These are remapped to the testnet principal — not to our deployer, and
 * not to a mock — so the staged contract exercises the real dependency.
 *
 * Every entry must be justified by a source hash comparison, not by name matching.
 * A contract that merely *looks* like the mainnet one is a mock, and belongs
 * nowhere near this table.
 */
export const TESTNET_EQUIVALENT = {
  // sBTC. All five contracts of the set verified byte-identical to
  // SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4 by SHA-256 over
  // /v2/contracts/source on both chains, 2026-09-17:
  //   sbtc-token 4,759B (sha256 8f0a0edd…), sbtc-registry 11,209B,
  //   sbtc-deposit 4,151B, sbtc-withdrawal 12,264B, sbtc-bootstrap-signers 5,801B.
  // sbtc-token's only internal dependency is .sbtc-registry, present and identical.
  // Live get-decimals() returns (ok u8), matching mainnet — so pool-v3's
  // share-scale calibration (pv3-F2) is exercised against the real value.
  //
  // CAVEAT, and it must survive into the staging evidence: ST1PQHQ… is the
  // well-known Clarinet default deployer and its key is public. The CODE is
  // provably canonical; the DEPLOYMENT is not authoritative. Acceptable on testnet
  // — nothing is at stake and this tests integration mechanics, not custody — but
  // results must read "byte-identical sBTC deployment at the public Clarinet
  // deployer address", never "canonical sBTC". See docs/TESTNET_STAGING.md §5.2.
  SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4: {
    testnet: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    what: "sBTC contract set (byte-identical; non-authoritative deployer)",
  },
};

/** Live mainnet protocols with no testnet substitute. Presence blocks staging. */
export const THIRD_PARTY = {
  SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N: "Zest Protocol",
  SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM: "ALEX Lab",
  SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1: "Velar / univ2",
  SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR: "Arkadiko",
  SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG: "StackingDAO",
  SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M: "Bitflow stableswap",
  SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG: "Hermetica (USDh)",
  SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K: "aeUSDC bridge",
  SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK: "sUSDT",
  SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7: "Granite",
  SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9: "DEX aggregator target",
  SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE: "USDCx",
};

/** Any mainnet principal literal: 'SP…, 'SM… (not testnet ST…/SN…). */
export const MAINNET_PRINCIPAL = /'S[PM][0-9A-HJKMNP-TV-Z]{37,40}/g;

/**
 * Rewrite every OURS principal to `deployer`, and every TESTNET_EQUIVALENT
 * principal to its verified testnet counterpart. THIRD_PARTY refs are left alone
 * so `residualMainnetRefs` can report them.
 */
export function localize(source, deployer) {
  let out = source;
  for (const addr of Object.keys(OURS)) out = out.replaceAll(addr, deployer);
  for (const [addr, { testnet }] of Object.entries(TESTNET_EQUIVALENT)) {
    out = out.replaceAll(addr, testnet);
  }
  return out;
}

/**
 * Mainnet principals still present after localization, deduplicated.
 * Empty array === the contract is publishable on testnet.
 */
export function residualMainnetRefs(localizedSource) {
  const found = new Set();
  for (const m of localizedSource.matchAll(MAINNET_PRINCIPAL)) found.add(m[0].slice(1));
  return [...found].sort();
}

/** Throw with a readable reason if anything is left unlocalized. */
export function assertFullyLocalized(localizedSource, label) {
  const left = residualMainnetRefs(localizedSource);
  if (left.length === 0) return;
  const lines = left.map(
    (a) => `    ${a}  — ${THIRD_PARTY[a] ?? OURS[a] ?? TESTNET_EQUIVALENT[a]?.what ?? "UNKNOWN principal"}`,
  );
  throw new Error(
    `${label} still references ${left.length} mainnet principal(s) after localization; ` +
      `publishing it on testnet would abort with an unresolved contract:\n${lines.join("\n")}\n` +
      `  If these are third-party protocols they have no testnet substitute — this contract ` +
      `cannot be staged as-is (docs/TESTNET_STAGING.md §5.2).`,
  );
}
