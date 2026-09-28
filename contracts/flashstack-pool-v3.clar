;; FlashStack Pool v3 -- Generic Multi-Asset Flash-Loan + LP Pool
;;
;; Aave-style generic core: lists any admin-approved SIP-010 token as a
;; flash-loan reserve and LP asset in ONE contract (design decision #3, LOCKED
;; 2026-07-26 in docs/02-technical/MULTI_ASSET_CORE_DESIGN.md -- no separate
;; core/pool; LP liquidity *is* the flash-loan reserve, per asset).
;;
;; Clarity cannot persist a trait reference in state, so every entry point
;; takes the token as a <sip-010-trait> parameter; per-asset state is keyed by
;; (contract-of token) (design doc section 2).
;;
;; Security model (design doc section 7):
;;   - Asset allow-list (add-asset) is LOAD-BEARING FOR SOLVENCY: only admin-
;;     vetted SIP-010 tokens are borrowable/depositable. An unlisted token --
;;     however well- or ill-behaved -- is rejected before any token call is
;;     made. This is what stops a malicious token contract (one that lies
;;     about get-balance/transfer) from ever being reachable through this pool.
;;   - Balance invariant (per asset): flash-loan measures the token balance
;;     before/after the callback and reverts unless it grew by >= fee.
;;   - Receiver whitelist: defense-in-depth during the unaudited beta
;;     (decision #1); not load-bearing for solvency.
;;   - Virtual shares/assets (F-1 fix), per asset, calibrated to each asset's
;;     own decimals (design doc section 13, finding F2).
;;   - Two-step admin transfer (decision #5, BC1 audit finding 2026-08-01):
;;     every currently-deployed governed FlashStack contract uses a one-step,
;;     self-gated admin transfer that permanently bricks governance if given a
;;     bad value, with no recovery. Ported verbatim from the proven fix in
;;     flashstack-sbtc-pool-v3 / flashstack-stx-pool-v3 / flashstack-sbtc-core-v2.
;;   - Per-asset reentrancy lock (design doc section 13, finding F1): blocks
;;     deposit/withdraw/flash-loan from reentering each other for the SAME
;;     asset mid-call. Scoped per-asset (not global) so a receiver's callback
;;     can still legitimately flash-loan a DIFFERENT asset in the same
;;     transaction -- each asset's balance invariant is independently safe
;;     (section 5), and blocking that would regress real multi-asset strategies.
;;   - Withdraw is intentionally NOT gated by asset enabled/paused status: LPs
;;     can always exit their position, matching the invariant already relied
;;     on for v1/v2 pool recovery (withdraw is never pause-gated in any
;;     deployed FlashStack pool). remove-asset soft-disables (enabled: false)
;;     rather than deleting the map entry, specifically so withdraw can keep
;;     reading share-scale/reserve for a delisted asset.
;;
;; NOT YET DEPLOYED. Deploy order: flashstack-v3-receiver-trait FIRST (fresh,
;; under the secure wallet SPR9PQ...), then this contract.
;;
;; Clarity version: 6 (migrated 2026-09-09). `as-contract` was removed in
;; Clarity 4 in favor of `as-contract?` (explicit outflow allowances) and the
;; `current-contract` keyword (for the common "get my own principal" case
;; that carries no privilege at all). Every prior `as-contract` use here was
;; a plain identity read except the two real fund outflows (withdraw's and
;; flash-loan's transfer-out), which now carry an explicit
;; `(with-ft (contract-of token) "*" amount)` allowance -- scoped to the one
;; listed token contract and the exact amount being sent, with "*" for the
;; token-name because this pool is generic across SIP-010 assets and can't
;; know each one's internal `define-fungible-token` name at compile time.
;; Deliberately not `with-all-assets-unsafe`: that grants unrestricted access
;; to every asset the contract holds, which is unnecessary here and exactly
;; the kind of over-broad allowance the SIP itself warns against when a
;; narrower one is available.

(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(use-trait flashstack-v3-receiver-trait 'SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG.flashstack-v3-receiver-trait.flashstack-v3-receiver-trait)

;; =============================================
;; Error Codes (800s -- fresh namespace, unused elsewhere in the repo)
;; =============================================

(define-constant ERR-NOT-ADMIN            (err u800))
(define-constant ERR-NOT-PENDING-ADMIN    (err u801))
(define-constant ERR-ZERO-AMOUNT          (err u802))
(define-constant ERR-PAUSED               (err u803))
(define-constant ERR-ASSET-PAUSED         (err u804))
(define-constant ERR-NOT-LISTED           (err u805))
(define-constant ERR-ALREADY-LISTED       (err u806))
(define-constant ERR-EXCEEDS-LIMIT        (err u807))
(define-constant ERR-NOT-APPROVED         (err u808))
(define-constant ERR-INSUFFICIENT-RESERVE (err u809))
(define-constant ERR-REPAY-FAILED         (err u810))
(define-constant ERR-TRANSFER-FAILED      (err u811))
(define-constant ERR-INVALID-FEE          (err u812))
(define-constant ERR-INSUFFICIENT-SHARES  (err u813))
(define-constant ERR-BALANCE-READ-FAILED  (err u814))
(define-constant ERR-REENTRANT            (err u815))
(define-constant ERR-DECIMALS-READ-FAILED (err u816))
(define-constant ERR-DECIMALS-TOO-LARGE   (err u817))

;; =============================================
;; Constants
;; =============================================

;; Hard cap on per-asset fee: admin cannot set a predatory fee (decision #4).
(define-constant MAX-FEE-BP u100) ;; 100 bp = 1%

;; Sanity cap on a listed token's own get-decimals() (F2 fix). No real SIP-010
;; exceeds this; guards the share-scale computation against a pathological value.
(define-constant MAX-DECIMALS u24)

;; F-1 fix: virtual shares + virtual assets (OpenZeppelin ERC-4626 inflation-
;; attack mitigation). VIRTUAL-ASSETS is asset-agnostic (always "1 phantom
;; base-unit"); the phantom-SHARES side is calibrated per asset via the
;; `share-scale` field on `assets` (= 10^decimals, matching how the sibling
;; single-asset v3 contracts calibrate it -- design doc section 13, F2).
(define-constant VIRTUAL-ASSETS u1)

;; =============================================
;; State
;; =============================================

(define-data-var admin         principal tx-sender)
(define-data-var pending-admin (optional principal) none)
(define-data-var paused        bool false) ;; global circuit breaker

;; Per-asset reentrancy lock (F1 fix). Keyed by asset, not global -- see the
;; header comment for why per-asset scoping matters.
(define-map asset-locked principal bool)

;; Per-asset config, keyed by the token's contract principal (contract-of token).
;; `reserve` is a CACHE of the token's live balance, refreshed at the end of
;; every deposit/withdraw/flash-loan (all of which re-measure it via the trait
;; anyway). This exists because Clarity forbids dynamic (trait-typed)
;; contract-call? inside define-read-only -- it cannot statically prove an
;; arbitrary trait implementer's function is side-effect-free, so read-only
;; oracle functions cannot take <sip-010-trait> and must read cached state
;; instead of live-querying the token. A direct donation to the contract (not
;; via deposit) will not appear in the oracle price until the next real
;; interaction refreshes the cache -- expected, not a solvency issue: the
;; balance invariant in flash-loan/withdraw still measures the live balance.
;; `share-scale` = 10^(token's own decimals), set from a live get-decimals()
;; call in add-asset (F2 fix) -- replaces a flat cross-asset constant that
;; under-calibrated the F-1 protection for higher-decimal assets like sBTC.
;; `enabled` is toggled false by remove-asset (soft-disable, not deleted) so
;; withdraw can keep reading share-scale/reserve for a delisted asset, and
;; add-asset can re-enable without losing calibration.
(define-map assets principal {
  enabled:      bool,
  fee-bp:       uint,
  max-loan:     uint,
  paused:       bool,
  reserve:      uint,
  share-scale:  uint,
  total-loans:  uint,
  total-volume: uint,
  total-fees:   uint,
})

;; Per-asset LP shares and per-asset total shares.
(define-map lp-shares    { asset: principal, lp: principal } uint)
(define-map total-shares principal uint)

;; Global receiver allowlist (decision #1: beta-only defense-in-depth; not
;; load-bearing for solvency -- the asset allow-list + balance invariant are).
(define-map approved-receivers principal bool)

;; =============================================
;; Admin -- two-step transfer (mandatory, decision #5 / BC1 fix)
;; =============================================

;; Step 1 of 2: propose a new admin. Takes effect ONLY after accept-admin.
(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set pending-admin (some new-admin)))
  )
)

;; Step 2 of 2: the proposed admin accepts. A mistyped/uncontrolled principal
;; can never call this, so a bad proposal simply never takes effect -- the
;; original admin keeps full control and can re-propose the correct address.
(define-public (accept-admin)
  (let ((pending (unwrap! (var-get pending-admin) ERR-NOT-PENDING-ADMIN)))
    (asserts! (is-eq tx-sender pending) ERR-NOT-PENDING-ADMIN)
    (var-set admin pending)
    (var-set pending-admin none)
    (print { event: "admin-transferred", new-admin: pending })
    (ok true)
  )
)

;; =============================================
;; Admin -- asset allow-list (load-bearing for solvency, section 7)
;; =============================================

;; Lists a NEW asset, or re-enables one previously delisted via remove-asset.
;; Takes the token as a trait (not a bare principal) so it can live-query
;; get-decimals() to calibrate share-scale (F2), and get-balance() to seed
;; `reserve` with whatever the pool actually holds rather than hardcoding 0
;; (hardening: a re-enabled or pre-funded asset could otherwise start with a
;; stale/wrong cached reserve).
(define-public (add-asset (token <sip-010-trait>) (fee-bp uint) (max-loan uint))
  (let (
    (asset        (contract-of token))
    (existing     (map-get? assets asset))
    (decimals     (unwrap! (contract-call? token get-decimals) ERR-DECIMALS-READ-FAILED))
    (live-balance (unwrap! (contract-call? token get-balance current-contract) ERR-BALANCE-READ-FAILED))
  )
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (not (default-to false (get enabled existing))) ERR-ALREADY-LISTED)
    (asserts! (and (> fee-bp u0) (<= fee-bp MAX-FEE-BP)) ERR-INVALID-FEE)
    (asserts! (> max-loan u0) ERR-ZERO-AMOUNT)
    (asserts! (<= decimals MAX-DECIMALS) ERR-DECIMALS-TOO-LARGE)
    (map-set assets asset {
      enabled: true, fee-bp: fee-bp, max-loan: max-loan, paused: false,
      reserve: live-balance, share-scale: (pow u10 decimals),
      total-loans: u0, total-volume: u0, total-fees: u0,
    })
    (print { event: "asset-added", token: asset, fee-bp: fee-bp, max-loan: max-loan, decimals: decimals })
    (ok true)
  )
)

(define-public (set-asset (token principal) (fee-bp uint) (max-loan uint) (asset-paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (and (> fee-bp u0) (<= fee-bp MAX-FEE-BP)) ERR-INVALID-FEE)
    (asserts! (> max-loan u0) ERR-ZERO-AMOUNT)
    (let ((cfg (unwrap! (map-get? assets token) ERR-NOT-LISTED)))
      (map-set assets token (merge cfg { fee-bp: fee-bp, max-loan: max-loan, paused: asset-paused }))
      (ok true)
    )
  )
)

;; Soft-delists the asset (blocks future deposit/flash-loan): sets
;; enabled:false rather than deleting the map entry, so withdraw can still
;; read share-scale/reserve for LPs exiting a delisted asset, and add-asset
;; can re-enable it later without recomputing calibration from scratch (though
;; it does recompute anyway, live, for safety -- see add-asset).
(define-public (remove-asset (token principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (let ((cfg (unwrap! (map-get? assets token) ERR-NOT-LISTED)))
      (asserts! (get enabled cfg) ERR-NOT-LISTED)
      (ok (map-set assets token (merge cfg { enabled: false })))
    )
  )
)

;; =============================================
;; Admin -- receiver allowlist + global pause
;; =============================================

(define-public (add-approved-receiver (receiver principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (map-set approved-receivers receiver true))
  )
)

(define-public (remove-approved-receiver (receiver principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (map-delete approved-receivers receiver))
  )
)

(define-public (set-paused (val bool))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set paused val))
  )
)

;; =============================================
;; LP Deposit / Withdraw (per asset)
;; =============================================

(define-public (deposit (token <sip-010-trait>) (amount uint))
  (let (
    (asset        (contract-of token))
    (depositor    tx-sender)
    (cfg          (unwrap! (map-get? assets asset) ERR-NOT-LISTED))
    (pool-balance (unwrap! (contract-call? token get-balance current-contract) ERR-BALANCE-READ-FAILED))
    (current-shares (default-to u0 (map-get? total-shares asset)))
    ;; shares = amount * (total_shares + share_scale) / (pool_balance + VA)
    (new-shares (/ (* amount (+ current-shares (get share-scale cfg))) (+ pool-balance VIRTUAL-ASSETS)))
  )
    ;; F1 fix: per-asset reentrancy guard, checked first.
    (asserts! (not (default-to false (map-get? asset-locked asset))) ERR-REENTRANT)
    (map-set asset-locked asset true)
    ;; F3 fix: deposit is now gated by pause, matching flash-loan. Pausing is a
    ;; circuit breaker for "something may be wrong" -- new deposits/loans stop,
    ;; but withdraw (below) is never gated, so LPs can always still exit.
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (asserts! (not (get paused cfg)) ERR-ASSET-PAUSED)
    (asserts! (get enabled cfg) ERR-NOT-LISTED)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    ;; Reject a deposit that would mint zero shares (e.g. a dust amount into
    ;; an already-large/valuable pool, rounding down to 0 via floor division).
    ;; Without this, the transfer would still succeed and the depositor would
    ;; silently lose their funds with no shares credited. Mirrors the
    ;; equivalent guard withdraw() already has on its output (amount-out > 0).
    (asserts! (> new-shares u0) ERR-ZERO-AMOUNT)
    ;; Effects before interaction (matches withdraw's ordering below): all
    ;; state is written from values already captured above, THEN the external
    ;; call is made. If the transfer subsequently fails, the whole transaction
    ;; -- including these map-sets -- reverts atomically, so this costs
    ;; nothing on the happy path. It closes a reentrancy-corruption window: if
    ;; a listed token's transfer ever called back into deposit/withdraw for
    ;; the same asset mid-call, updating state first means there is nothing
    ;; left for the outer call to overwrite afterward. (Belt-and-suspenders
    ;; with the F1 lock above, which blocks the same-asset reentry outright.)
    (map-set lp-shares { asset: asset, lp: depositor }
      (+ (default-to u0 (map-get? lp-shares { asset: asset, lp: depositor })) new-shares))
    (map-set total-shares asset (+ current-shares new-shares))
    ;; Refresh the cached reserve: this deposit is about to land `amount`
    ;; more into the contract, on top of the balance measured above.
    (map-set assets asset (merge cfg { reserve: (+ pool-balance amount) }))
    (unwrap! (contract-call? token transfer amount depositor current-contract none) ERR-TRANSFER-FAILED)
    (map-set asset-locked asset false)
    (ok new-shares)
  )
)

(define-public (withdraw (token <sip-010-trait>) (shares uint))
  (let (
    (asset            (contract-of token))
    (withdrawer       tx-sender)
    (depositor-shares (default-to u0 (map-get? lp-shares { asset: asset, lp: withdrawer })))
    (current-shares   (default-to u0 (map-get? total-shares asset)))
    ;; Guaranteed present: lp-shares can only be nonzero for an asset that was
    ;; added at least once (deposit requires the map entry to exist), and
    ;; remove-asset soft-disables rather than deleting -- so this unwrap!
    ;; never fails for a genuine withdrawer, even on a delisted asset.
    (cfg              (unwrap! (map-get? assets asset) ERR-NOT-LISTED))
    (pool-balance     (unwrap! (contract-call? token get-balance current-contract) ERR-BALANCE-READ-FAILED))
    ;; assets_out = shares * (pool_balance + VA) / (total_shares + share_scale)
    (amount-out (/ (* shares (+ pool-balance VIRTUAL-ASSETS)) (+ current-shares (get share-scale cfg))))
  )
    ;; F1 fix: per-asset reentrancy guard. Withdraw itself has no external
    ;; callback surface, but this closes the loop against a flash-loan/deposit
    ;; on the SAME asset reentering INTO a withdraw mid-call.
    (asserts! (not (default-to false (map-get? asset-locked asset))) ERR-REENTRANT)
    (map-set asset-locked asset true)
    (asserts! (> shares u0) ERR-ZERO-AMOUNT)
    (asserts! (>= depositor-shares shares) ERR-INSUFFICIENT-SHARES)
    (asserts! (> amount-out u0) ERR-ZERO-AMOUNT)
    (map-set lp-shares { asset: asset, lp: withdrawer } (- depositor-shares shares))
    (map-set total-shares asset (- current-shares shares))
    (unwrap!
      (as-contract? ((with-ft (contract-of token) "*" amount-out))
        (unwrap! (contract-call? token transfer amount-out tx-sender withdrawer none) ERR-TRANSFER-FAILED))
      ERR-TRANSFER-FAILED)
    (map-set assets asset (merge cfg { reserve: (- pool-balance amount-out) }))
    (map-set asset-locked asset false)
    (ok amount-out)
  )
)

;; =============================================
;; Flash Loan
;; =============================================

(define-public (flash-loan (token <sip-010-trait>) (amount uint) (receiver <flashstack-v3-receiver-trait>))
  (let (
    (asset              (contract-of token))
    (cfg                (unwrap! (map-get? assets asset) ERR-NOT-LISTED))
    (receiver-principal (contract-of receiver))
    (raw-fee   (/ (* amount (get fee-bp cfg)) u10000))
    (fee       (if (> raw-fee u0) raw-fee u1))
    (reserve-before (unwrap! (contract-call? token get-balance current-contract) ERR-BALANCE-READ-FAILED))
  )
    ;; F1 fix: per-asset reentrancy guard. This is what actually stops
    ;; Hillary Kibet's finding -- a receiver reentering deposit() for the SAME
    ;; asset during this callback now hits ERR-REENTRANT and the whole
    ;; transaction reverts, instead of silently corrupting total-fees/volume.
    (asserts! (not (default-to false (map-get? asset-locked asset)))         ERR-REENTRANT)
    (map-set asset-locked asset true)
    (asserts! (not (var-get paused))                                          ERR-PAUSED)
    (asserts! (get enabled cfg)                                               ERR-NOT-LISTED)
    (asserts! (not (get paused cfg))                                          ERR-ASSET-PAUSED)
    (asserts! (> amount u0)                                                   ERR-ZERO-AMOUNT)
    (asserts! (<= amount (get max-loan cfg))                                  ERR-EXCEEDS-LIMIT)
    (asserts! (default-to false (map-get? approved-receivers receiver-principal)) ERR-NOT-APPROVED)
    (asserts! (>= reserve-before amount)                                      ERR-INSUFFICIENT-RESERVE)

    ;; Send the asset to the receiver.
    (unwrap!
      (as-contract? ((with-ft (contract-of token) "*" amount))
        (unwrap! (contract-call? token transfer amount tx-sender receiver-principal none) ERR-TRANSFER-FAILED))
      ERR-TRANSFER-FAILED)

    ;; Invoke the receiver callback. It must repay amount + fee before returning.
    (try! (contract-call? receiver execute-flash token amount current-contract))

    ;; INVARIANT: this asset's reserve must have grown by >= fee. Measured, not
    ;; trusted -- identical safety to the single-asset cores, applied per token.
    (let ((reserve-after (unwrap! (contract-call? token get-balance current-contract) ERR-BALANCE-READ-FAILED)))
      (asserts! (>= reserve-after (+ reserve-before fee)) ERR-REPAY-FAILED)
      (map-set assets asset (merge cfg {
        reserve:      reserve-after,
        total-loans:  (+ (get total-loans cfg) u1),
        total-volume: (+ (get total-volume cfg) amount),
        total-fees:   (+ (get total-fees cfg) (- reserve-after reserve-before)),
      }))
      (map-set asset-locked asset false)
      (print { event: "flash-loan", asset: asset, receiver: receiver-principal, amount: amount, fee: fee })
      (ok true)
    )
  )
)

;; =============================================
;; Read-only
;; =============================================

(define-read-only (get-admin) (ok (var-get admin)))
(define-read-only (get-pending-admin) (ok (var-get pending-admin)))
(define-read-only (get-paused) (ok (var-get paused)))

(define-read-only (get-asset (token principal))
  (map-get? assets token)
)

;; "Listed" means an entry exists AND is currently enabled -- a soft-removed
;; (delisted) asset is not listed, even though its map entry still exists so
;; withdraw can keep reading it.
(define-read-only (is-listed (token principal))
  (default-to false (get enabled (map-get? assets token)))
)

;; Hardening (design doc section 13): errors for a token that was never
;; listed, instead of silently returning a plausible-looking zero/default --
;; a caller checking collateral value for an unlisted token should get a
;; clear error, not a value that looks like a valid (if tiny) price.
(define-read-only (get-reserve (token principal))
  (let ((cfg (unwrap! (map-get? assets token) ERR-NOT-LISTED)))
    (ok (get reserve cfg))
  )
)

(define-read-only (is-approved-receiver (receiver principal))
  (default-to false (map-get? approved-receivers receiver))
)

(define-read-only (get-shares (token principal) (lp principal))
  (default-to u0 (map-get? lp-shares { asset: token, lp: lp }))
)

(define-read-only (get-total-shares (token principal))
  (default-to u0 (map-get? total-shares token))
)

;; Current value of one pool share for `token`, scaled by the asset's own
;; share-scale (F2 fix: was a flat cross-asset constant, now calibrated to
;; the token's decimals). Well-defined at zero shares (F-2-original fix:
;; virtual-offset formula, no special case). Reads the cached reserve (see
;; `assets` map comment) rather than a live contract-call -- dynamic trait
;; dispatch is not allowed in read-only fns. Errors for an unlisted token
;; (hardening, section 13) instead of a plausible-looking default.
(define-read-only (get-share-price (token principal))
  (let (
    (cfg            (unwrap! (map-get? assets token) ERR-NOT-LISTED))
    (pool-balance   (get reserve cfg))
    (scale          (get share-scale cfg))
    (current-shares (default-to u0 (map-get? total-shares token)))
  )
    (ok (/ (* (+ pool-balance VIRTUAL-ASSETS) scale) (+ current-shares scale)))
  )
)

;; Current value of an LP's position in `token`'s base units (cached reserve).
;; Errors for an unlisted token (hardening, section 13).
(define-read-only (get-lp-value (token principal) (lp principal))
  (let (
    (cfg            (unwrap! (map-get? assets token) ERR-NOT-LISTED))
    (shares         (default-to u0 (map-get? lp-shares { asset: token, lp: lp })))
    (pool-balance   (get reserve cfg))
    (scale          (get share-scale cfg))
    (current-shares (default-to u0 (map-get? total-shares token)))
  )
    (if (is-eq shares u0)
      (ok u0)
      (ok (/ (* shares (+ pool-balance VIRTUAL-ASSETS)) (+ current-shares scale)))
    )
  )
)

(define-read-only (calculate-fee (token principal) (amount uint))
  (let ((cfg (unwrap! (map-get? assets token) ERR-NOT-LISTED)))
    (let ((raw-fee (/ (* amount (get fee-bp cfg)) u10000)))
      (ok (if (> raw-fee u0) raw-fee u1))
    )
  )
)
