;; FlashStack sBTC Core
;; Flash loan engine for canonical sBTC (SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
;;
;; Flow:
;;   1. Admin deposits canonical sBTC into this contract (the reserve)
;;   2. Borrower calls flash-loan(amount, receiver)
;;   3. Core transfers sBTC to receiver
;;   4. Core calls receiver.execute-sbtc-flash(amount, core-principal)
;;   5. Receiver does whatever it wants (DEX swap, arbitrage, liquidation)
;;   6. Receiver transfers amount + fee back to core
;;   7. Core verifies reserve grew by at least the fee
;;
;; Security model:
;;   - Receiver whitelist prevents arbitrary contracts from borrowing
;;   - Repayment verified by comparing reserve balance before/after
;;   - Admin cannot mint or manipulate loans - only deposit/withdraw reserve

(use-trait sbtc-flash-receiver-trait 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)

;; =============================================
;; Error Codes
;; =============================================

(define-constant ERR-PAUSED               (err u300))
(define-constant ERR-ZERO-AMOUNT          (err u301))
(define-constant ERR-REPAY-FAILED         (err u302))
(define-constant ERR-INSUFFICIENT-RESERVE (err u303))
(define-constant ERR-EXCEEDS-LIMIT        (err u304))
(define-constant ERR-NOT-APPROVED         (err u306))
(define-constant ERR-NOT-ADMIN            (err u310))
(define-constant ERR-TRANSFER-FAILED      (err u311))

;; =============================================
;; State
;; =============================================

(define-data-var admin principal tx-sender)
(define-data-var paused bool false)
(define-data-var fee-basis-points uint u5)       ;; 0.05% fee
(define-data-var max-single-loan uint u10000000) ;; 0.1 BTC default cap (10M sats)

(define-data-var total-loans uint u0)
(define-data-var total-volume uint u0)
(define-data-var total-fees-collected uint u0)

(define-map approved-receivers principal bool)

;; =============================================
;; Flash Loan
;; =============================================

(define-public (flash-loan
    (amount uint)
    (receiver <sbtc-flash-receiver-trait>)
  )
  (let (
    (receiver-principal (contract-of receiver))
    (raw-fee (/ (* amount (var-get fee-basis-points)) u10000))
    (fee (if (> raw-fee u0) raw-fee u1))
    (reserve-before (unwrap!
      (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance (as-contract tx-sender))
      ERR-REPAY-FAILED))
  )
    (asserts! (not (var-get paused))                                             ERR-PAUSED)
    (asserts! (> amount u0)                                                      ERR-ZERO-AMOUNT)
    (asserts! (<= amount (var-get max-single-loan))                              ERR-EXCEEDS-LIMIT)
    (asserts! (default-to false (map-get? approved-receivers receiver-principal)) ERR-NOT-APPROVED)
    (asserts! (>= reserve-before amount)                                         ERR-INSUFFICIENT-RESERVE)

    ;; Send sBTC to receiver
    (unwrap!
      (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount tx-sender receiver-principal none))
      ERR-TRANSFER-FAILED)

    ;; Invoke receiver callback
    (try! (contract-call? receiver execute-sbtc-flash amount (as-contract tx-sender)))

    ;; Verify repayment: reserve must have grown by at least fee
    (let ((reserve-after (unwrap!
        (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance (as-contract tx-sender))
        ERR-REPAY-FAILED)))
      (asserts! (>= reserve-after (+ reserve-before fee)) ERR-REPAY-FAILED)

      (var-set total-loans  (+ (var-get total-loans) u1))
      (var-set total-volume (+ (var-get total-volume) amount))
      (var-set total-fees-collected (+ (var-get total-fees-collected) (- reserve-after reserve-before)))
      (ok true)
    )
  )
)

;; =============================================
;; Admin - Reserve Management
;; =============================================

(define-public (deposit-reserve (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (unwrap!
      (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount tx-sender (as-contract tx-sender) none)
      ERR-TRANSFER-FAILED)
    (ok true)
  )
)

(define-public (withdraw-reserve (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (unwrap!
      (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount tx-sender to none))
      ERR-TRANSFER-FAILED)
    (ok true)
  )
)

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

(define-public (set-paused (p bool))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set paused p))
  )
)

(define-public (set-fee-basis-points (new-fee uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (<= new-fee u100) ERR-NOT-ADMIN)
    (ok (var-set fee-basis-points new-fee))
  )
)

(define-public (set-max-single-loan (new-max uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set max-single-loan new-max))
  )
)

(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set admin new-admin))
  )
)

;; =============================================
;; Read-only
;; =============================================

(define-read-only (get-reserve-balance)
  (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance (as-contract tx-sender))
)

(define-read-only (get-fee-basis-points)
  (ok (var-get fee-basis-points))
)

(define-read-only (get-max-single-loan)
  (ok (var-get max-single-loan))
)

(define-read-only (get-admin)
  (ok (var-get admin))
)

(define-read-only (get-stats)
  (ok {
    total-loans:          (var-get total-loans),
    total-volume:         (var-get total-volume),
    total-fees-collected: (var-get total-fees-collected),
    paused:               (var-get paused),
  })
)

(define-read-only (is-approved-receiver (receiver principal))
  (ok (default-to false (map-get? approved-receivers receiver)))
)

(define-read-only (calculate-fee (amount uint))
  (let ((raw-fee (/ (* amount (var-get fee-basis-points)) u10000)))
    (ok (if (> raw-fee u0) raw-fee u1))
  )
)
