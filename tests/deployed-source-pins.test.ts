import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * D7 (docs/security/CONTRACT_INVENTORY.md §5): these are VERBATIM copies of
 * immutable contracts deployed at SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ. They
 * were checked byte-for-byte against the deployed source on 2026-09-21.
 *
 * A repo copy of an immutable contract can only ever be wrong by changing, which is
 * exactly how F-7 happened: a file described as a copy of the deployed contract was
 * edited and the tests spent weeks proving things about a contract that does not
 * exist on mainnet. These contracts contain mock placeholders and a no-op
 * `remove-vault` stub that look tempting to "fix". Fixing them here would only
 * create drift from what is on chain. If a change is ever legitimate, it is a new
 * contract under a new name, not an edit to these files.
 *
 * Offline on purpose. To re-verify against the chain:
 *   curl -s https://api.hiro.so/v2/contracts/source/SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ/<name> \
 *     | jq -j .source | shasum -a 256
 * (-j: no trailing newline; the API returns the source without one.)
 * *.clar is forced to LF by .gitattributes, so the hash is stable across checkouts.
 */
const PINS = [
  {
    file: "contracts/snp-flashstack-receiver.clar",
    bytes: 3270,
    sha256: "0722955560dbd791d5c3a29c84e1787e4a250df88db5ece6d27be768a0b920ea",
  },
  {
    file: "contracts/snp-flashstack-receiver-v3.clar",
    bytes: 5396,
    sha256: "2560814d0e0103d2e8fcb337fc560cdbc5c39215828b81606712ab82ffb3fdec",
  },
] as const;

describe("verbatim copies of deployed contracts must not change", () => {
  for (const { file, bytes, sha256 } of PINS) {
    it(`${file} still matches the deployed source it was verified against`, () => {
      const raw = readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
      expect(Buffer.byteLength(raw), "size changed").toBe(bytes);
      expect(createHash("sha256").update(raw).digest("hex"), "content changed").toBe(sha256);
    });
  }
});
