;; ============================================================================
;; BC1 FIX -- two-step admin transfer. Successor to the one-step, self-gated
;; `flashstack-sbtc-pool-v2`. A one-step transfer permanently bricks governance (and, on the cores,
;; strands the reserve) if admin is set to an unusable principal, with no recovery.
;; Here the update only PROPOSES; the new admin must call accept-admin. NOT DEPLOYED.
;; F-8 FIX -- deposit is also gated by pause now (v2's deposit was not; flash-loan was).
;; See docs/security/FINDINGS_REGISTER.md. withdraw stays ungated so LPs can always exit.
;; ============================================================================
;; FlashStack sBTC Pool v2 (HARDENED)
;;
;; v2 vs deployed flashstack-sbtc-pool: adds virtual shares + virtual assets to
;; close the first-depositor / donation inflation vector (Finding F-1), applied
;; consistently through the built-in oracle (also fixes F-2). Not yet deployed;
;; deploy in place of the v1 sBTC pool, migrating v1 liquidity, before opening
;; real LP deposits.
;;
;; LP pool for canonical sBTC flash loans.
;; Depositors earn sBTC yield from every flash loan fee.
;; Share value is denominated in sats  -  appreciates with BTC.
;;
;; Share model (identical to flashstack-stx-pool but in sats):
;;   shares_minted = deposit * total_shares / pool_balance
;;   sats_on_withdraw = shares * pool_balance / total_shares
;;   As fees accumulate, pool_balance grows, shares stay constant
;;   => each share worth more sBTC over time
;;
;; Collateral oracle:
;;   get-share-price returns sats per share (scaled by SHARE-PRECISION)
;;   Lending protocols can call this directly  -  no external oracle needed
;;   Flash loan manipulation-resistant: reserve invariant guarantees
;;   pool balance only ever grows by >= fee per loan
;;
;; Security model:
;;   - Receiver whitelist prevents arbitrary contracts from borrowing
;;   - Repayment verified by reserve balance before/after
;;   - Admin cannot drain pool  -  only set parameters

(use-trait sbtc-flash-receiver-trait .sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)

;; =============================================
;; Error Codes
;; =============================================

(define-constant ERR-NOT-ADMIN            (err u700))
(define-constant ERR-ZERO-AMOUNT          (err u701))
(define-constant ERR-REPAY-FAILED         (err u702))
(define-constant ERR-INSUFFICIENT-RESERVE (err u703))
(define-constant ERR-EXCEEDS-LIMIT        (err u704))
(define-constant ERR-PAUSED               (err u705))
(define-constant ERR-NOT-APPROVED         (err u706))
(define-constant ERR-INVALID-FEE          (err u707))
(define-constant ERR-NO-SHARES            (err u708))
(define-constant ERR-INSUFFICIENT-SHARES  (err u709))
(define-constant ERR-TRANSFER-FAILED      (err u710))

;; =============================================
;; State
;; =============================================

(define-data-var admin           principal tx-sender)
(define-data-var pending-admin (optional principal) none)
(define-constant ERR-NOT-PENDING-ADMIN (err u711))
(define-data-var fee-basis-points uint     u5)           ;; 0.05% fee
(define-data-var paused          bool      false)
(define-data-var max-single-loan uint      u10000000)    ;; 0.1 BTC default cap
(define-data-var total-shares    uint      u0)
(define-data-var total-loans     uint      u0)
(define-data-var total-volume    uint      u0)
(define-data-var total-fees      uint      u0)

(define-constant SHARE-PRECISION u100000000) ;; 1e8  -  matches sBTC sat precision

;; F-1 fix (v2): virtual shares + virtual assets (OpenZeppelin ERC-4626
;; inflation-attack mitigation). A permanent phantom position absorbs
;; donation/first-depositor manipulation. Applied consistently to deposit,
;; withdraw, and the built-in oracle (which also fixes the F-2 launch-price
;; scale mismatch: the offset formula is well-defined at zero shares).
(define-constant VIRTUAL-SHARES u100000000) ;; 1e8 phantom shares (matches SHARE-PRECISION)
(define-constant VIRTUAL-ASSETS u1)         ;; 1 phantom sat

(define-map approved-receivers principal bool)
(define-map lp-shares          principal uint)

;; =============================================
;; LP Deposit / Withdraw
;; =============================================

(define-public (deposit (amount uint))
  (let (
    (depositor    tx-sender)
    (pool-balance (unwrap! (contract-call? .sbtc-token
                    get-balance (as-contract tx-sender)) ERR-TRANSFER-FAILED))
    (current-shares (var-get total-shares))
    ;; shares = amount * (total_shares + VIRTUAL-SHARES) / (pool_balance + VIRTUAL-ASSETS)
    (new-shares (/ (* amount (+ current-shares VIRTUAL-SHARES)) (+ pool-balance VIRTUAL-ASSETS)))
  )
    ;; F-8 fix: deposit is gated by pause, matching flash-loan and pool-v3's pv3-F3 fix.
    ;; withdraw is deliberately never gated, so LPs can always still exit.
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (unwrap!
      (contract-call? .sbtc-token
        transfer amount depositor (as-contract tx-sender) none)
      ERR-TRANSFER-FAILED)
    (map-set lp-shares depositor
      (+ (default-to u0 (map-get? lp-shares depositor)) new-shares))
    (var-set total-shares (+ current-shares new-shares))
    (ok new-shares)
  )
)

(define-public (withdraw (shares uint))
  (let (
    (withdrawer       tx-sender)
    (depositor-shares (default-to u0 (map-get? lp-shares withdrawer)))
    (current-shares   (var-get total-shares))
    (pool-balance     (unwrap! (contract-call? .sbtc-token
                        get-balance (as-contract tx-sender)) ERR-TRANSFER-FAILED))
    (sats-amount      (/ (* shares (+ pool-balance VIRTUAL-ASSETS)) (+ current-shares VIRTUAL-SHARES)))
  )
    (asserts! (> shares u0) ERR-ZERO-AMOUNT)
    (asserts! (>= depositor-shares shares) ERR-INSUFFICIENT-SHARES)
    (asserts! (> sats-amount u0) ERR-ZERO-AMOUNT)
    (map-set lp-shares withdrawer (- depositor-shares shares))
    (var-set total-shares (- current-shares shares))
    (unwrap!
      (as-contract (contract-call? .sbtc-token
        transfer sats-amount tx-sender withdrawer none))
      ERR-TRANSFER-FAILED)
    (ok sats-amount)
  )
)

;; =============================================
;; Flash Loan
;; =============================================

(define-public (flash-loan
    (amount uint)
    (receiver <sbtc-flash-receiver-trait>)
  )
  (let (
    (receiver-principal (contract-of receiver))
    (raw-fee   (/ (* amount (var-get fee-basis-points)) u10000))
    (fee       (if (> raw-fee u0) raw-fee u1))
    (reserve-before (unwrap!
      (contract-call? .sbtc-token
        get-balance (as-contract tx-sender))
      ERR-REPAY-FAILED))
  )
    (asserts! (not (var-get paused))                                              ERR-PAUSED)
    (asserts! (> amount u0)                                                       ERR-ZERO-AMOUNT)
    (asserts! (<= amount (var-get max-single-loan))                               ERR-EXCEEDS-LIMIT)
    (asserts! (default-to false (map-get? approved-receivers receiver-principal)) ERR-NOT-APPROVED)
    (asserts! (>= reserve-before amount)                                          ERR-INSUFFICIENT-RESERVE)

    ;; Send sBTC to receiver
    (unwrap!
      (as-contract (contract-call? .sbtc-token
        transfer amount tx-sender receiver-principal none))
      ERR-TRANSFER-FAILED)

    ;; Invoke receiver callback
    (try! (contract-call? receiver execute-sbtc-flash amount (as-contract tx-sender)))

    ;; Verify repayment  -  reserve must have grown by >= fee
    (let ((reserve-after (unwrap!
            (contract-call? .sbtc-token
              get-balance (as-contract tx-sender))
            ERR-REPAY-FAILED)))
      (asserts! (>= reserve-after (+ reserve-before fee)) ERR-REPAY-FAILED)

      (var-set total-loans  (+ (var-get total-loans) u1))
      (var-set total-volume (+ (var-get total-volume) amount))
      (var-set total-fees   (+ (var-get total-fees) (- reserve-after reserve-before)))
      (ok true)
    )
  )
)

;; =============================================
;; Admin
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

(define-public (set-fee-basis-points (new-fee uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (and (>= new-fee u1) (<= new-fee u100)) ERR-INVALID-FEE)
    (ok (var-set fee-basis-points new-fee))
  )
)

(define-public (set-paused (val bool))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set paused val))
  )
)

(define-public (set-max-single-loan (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (ok (var-set max-single-loan amount))
  )
)

;; Step 1 of 2: propose a new admin. Takes effect ONLY after accept-admin.
;; (BC1 fix: a one-step self-gated transfer can permanently brick governance if
;; admin is set to a principal nobody controls.)
(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set pending-admin (some new-admin)))
  )
)

;; Step 2 of 2: the proposed admin accepts. A mistyped/uncontrolled principal can
;; never accept, so admin is never set to an unusable value.
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
;; Read-only  -  including collateral oracle
;; =============================================

;; Current value of one pool share in sats, scaled by SHARE-PRECISION (1e8).
;; Divide result by 1e8 to get sats per share.
;; At launch: 1e8 (= 1 sat per share)
;; Over time: increases as flash loan fees accumulate
;;
;; This is the primary function lending protocols should consume.
;; Manipulation-resistant: pool balance only increases via the fee invariant.
(define-read-only (get-share-price)
  (let (
    (pool-balance (unwrap-panic (contract-call? .sbtc-token
                    get-balance (as-contract tx-sender))))
    (current-shares (var-get total-shares))
  )
    ;; Virtual-offset price is well-defined at zero shares (no special case).
    (ok (/ (* (+ pool-balance VIRTUAL-ASSETS) SHARE-PRECISION) (+ current-shares VIRTUAL-SHARES)))
  )
)

;; STX value of a specific LP's position in sats.
;; Call this with an LP principal to get their collateral value.
(define-read-only (get-lp-value (lp principal))
  (let (
    (shares       (default-to u0 (map-get? lp-shares lp)))
    (pool-balance (unwrap-panic (contract-call? .sbtc-token
                    get-balance (as-contract tx-sender))))
    (current-shares (var-get total-shares))
  )
    (if (is-eq shares u0)
      (ok u0)
      (ok (/ (* shares (+ pool-balance VIRTUAL-ASSETS)) (+ current-shares VIRTUAL-SHARES)))
    )
  )
)

(define-read-only (get-pool-balance)
  (contract-call? .sbtc-token
    get-balance (as-contract tx-sender))
)

(define-read-only (get-shares (lp principal))
  (default-to u0 (map-get? lp-shares lp))
)

(define-read-only (get-stats)
  (ok {
    pool-balance:      (unwrap-panic (contract-call? .sbtc-token
                          get-balance (as-contract tx-sender))),
    total-shares:      (var-get total-shares),
    total-loans:       (var-get total-loans),
    total-volume:      (var-get total-volume),
    total-fees:        (var-get total-fees),
    fee-basis-points:  (var-get fee-basis-points),
    paused:            (var-get paused),
    max-single-loan:   (var-get max-single-loan),
  })
)

(define-read-only (get-collateral-snapshot)
  (let (
    (pool-balance   (unwrap-panic (contract-call? .sbtc-token
                      get-balance (as-contract tx-sender))))
    (current-shares (var-get total-shares))
  )
    (ok {
      share-price:   (/ (* (+ pool-balance VIRTUAL-ASSETS) SHARE-PRECISION) (+ current-shares VIRTUAL-SHARES)),
      total-shares:  current-shares,
      pool-balance:  pool-balance,
      yield-accrued: (var-get total-fees),
      total-loans:   (var-get total-loans),
      is-healthy:    (> pool-balance u0),
      asset:         "sBTC",
    })
  )
)

(define-read-only (get-fee-basis-points)
  (ok (var-get fee-basis-points))
)

(define-read-only (is-approved-receiver (receiver principal))
  (default-to false (map-get? approved-receivers receiver))
)

(define-read-only (calculate-fee (amount uint))
  (let ((raw-fee (/ (* amount (var-get fee-basis-points)) u10000)))
    (ok (if (> raw-fee u0) raw-fee u1))
  )
)

(define-read-only (get-admin)
  (ok (var-get admin))
)

(define-read-only (get-pending-admin) (ok (var-get pending-admin)))
