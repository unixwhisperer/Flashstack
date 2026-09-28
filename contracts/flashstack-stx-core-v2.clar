;; ============================================================================
;; BC1 FIX -- two-step admin transfer. Successor to the one-step, self-gated
;; `flashstack-stx-core`. A one-step transfer permanently bricks governance (and, on the cores,
;; strands the reserve) if admin is set to an unusable principal, with no recovery.
;; Here the update only PROPOSES; the new admin must call accept-admin. NOT DEPLOYED.
;; ============================================================================
;; FlashStack STX Core
;; STX reserve-based flash loans on Stacks mainnet.
;;
;; How it works:
;;   1. Admin deposits STX into this contract as reserve
;;   2. Anyone can call flash-loan(amount, receiver)
;;   3. Contract sends STX to receiver
;;   4. Receiver executes strategy (DEX arb, liquidation, etc.)
;;   5. Receiver repays STX + fee in the same transaction
;;   6. If repayment fails the whole transaction reverts
;;
;; This is uncollateralized from the borrower's perspective.
;; Capital comes from the protocol reserve (like Aave's pool).
;;
;; Clarity version: 3 (epoch 3.0 / Nakamoto)

(use-trait stx-flash-receiver-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

;; =============================================
;; Constants
;; =============================================

(define-constant INITIAL-ADMIN tx-sender)

(define-constant ERR-NOT-ADMIN            (err u300))
(define-constant ERR-ZERO-AMOUNT          (err u301))
(define-constant ERR-REPAY-FAILED         (err u302))
(define-constant ERR-INSUFFICIENT-RESERVE (err u303))
(define-constant ERR-EXCEEDS-LIMIT        (err u304))
(define-constant ERR-PAUSED               (err u305))
(define-constant ERR-NOT-APPROVED         (err u306))
(define-constant ERR-INVALID-FEE          (err u307))
(define-constant ERR-TRANSFER-FAILED      (err u308))
(define-constant ERR-NOT-PENDING-ADMIN    (err u309))

;; =============================================
;; Data vars
;; =============================================

(define-data-var admin             principal INITIAL-ADMIN)
(define-data-var pending-admin     (optional principal) none)
(define-data-var fee-basis-points  uint      u5)           ;; 0.05% default
(define-data-var paused            bool      false)
(define-data-var max-single-loan   uint      u500000000000) ;; 5,000 STX (microstacks)
(define-data-var total-loans       uint      u0)
(define-data-var total-volume      uint      u0)
(define-data-var total-fees        uint      u0)

;; Approved receiver whitelist
(define-map approved-receivers principal bool)

;; =============================================
;; Admin
;; =============================================

(define-public (deposit-reserve (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (unwrap! (stx-transfer? amount tx-sender (as-contract tx-sender)) ERR-TRANSFER-FAILED)
    (print { event: "deposit-reserve", amount: amount, admin: tx-sender })
    (ok true)
  )
)

(define-public (withdraw-reserve (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (unwrap! (as-contract (stx-transfer? amount tx-sender (var-get admin))) ERR-TRANSFER-FAILED)
    (print { event: "withdraw-reserve", amount: amount, admin: tx-sender })
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

(define-public (set-fee-basis-points (new-fee uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (and (>= new-fee u1) (<= new-fee u1000)) ERR-INVALID-FEE)
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

;; Step 1: propose a new admin. Requires step 2 (accept-admin) to take effect.
(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (ok (var-set pending-admin (some new-admin)))
  )
)

;; Step 2: new admin accepts the role. Prevents accidental lock-out from a typo.
(define-public (accept-admin)
  (let ((pending (unwrap! (var-get pending-admin) ERR-NOT-PENDING-ADMIN)))
    (asserts! (is-eq tx-sender pending) ERR-NOT-PENDING-ADMIN)
    (var-set admin pending)
    (var-set pending-admin none)
    (print { event: "admin-transferred", new-admin: pending })
    (ok true)
  )
)

(define-read-only (get-pending-admin)
  (ok (var-get pending-admin))
)

;; =============================================
;; Flash Loan
;; =============================================

(define-public (flash-loan
    (amount uint)
    (receiver <stx-flash-receiver-trait>)
  )
  (let (
    (receiver-principal (contract-of receiver))
    (raw-fee (/ (* amount (var-get fee-basis-points)) u10000))
    (fee (if (> raw-fee u0) raw-fee u1))
    (reserve-before (stx-get-balance (as-contract tx-sender)))
  )
    ;; Guards
    (asserts! (not (var-get paused))                                    ERR-PAUSED)
    (asserts! (> amount u0)                                             ERR-ZERO-AMOUNT)
    (asserts! (<= amount (var-get max-single-loan))                     ERR-EXCEEDS-LIMIT)
    (asserts! (default-to false (map-get? approved-receivers receiver-principal)) ERR-NOT-APPROVED)
    (asserts! (>= reserve-before amount)                                ERR-INSUFFICIENT-RESERVE)

    ;; Send STX to receiver
    ;; Use unwrap! (not try!) so the error type is always (err uint)
    ;; stx-transfer? returns (response bool string-ascii) in Clarity 4
    (unwrap! (as-contract (stx-transfer? amount tx-sender receiver-principal)) ERR-REPAY-FAILED)

    ;; Invoke receiver callback
    (try! (contract-call? receiver execute-stx-flash amount (as-contract tx-sender)))

    ;; Verify reserve grew by at least the fee
    (let ((reserve-after (stx-get-balance (as-contract tx-sender))))
      (asserts! (>= reserve-after (+ reserve-before fee)) ERR-REPAY-FAILED)

      ;; Update stats
      (var-set total-loans  (+ (var-get total-loans) u1))
      (var-set total-volume (+ (var-get total-volume) amount))
      (var-set total-fees   (+ (var-get total-fees) fee))

      (print { event: "flash-loan", receiver: receiver-principal, amount: amount, fee: fee,
               total-loans: (var-get total-loans) })
      (ok true)
    )
  )
)

;; =============================================
;; Read-only
;; =============================================

(define-read-only (get-reserve-balance)
  (stx-get-balance (as-contract tx-sender))
)

(define-read-only (get-stats)
  (ok {
    reserve:            (stx-get-balance (as-contract tx-sender)),
    total-loans:        (var-get total-loans),
    total-volume:       (var-get total-volume),
    total-fees:         (var-get total-fees),
    fee-basis-points:   (var-get fee-basis-points),
    paused:             (var-get paused),
    max-single-loan:    (var-get max-single-loan),
  })
)

(define-read-only (get-fee-basis-points)
  (ok (var-get fee-basis-points))
)

(define-read-only (get-max-single-loan)
  (ok (var-get max-single-loan))
)

(define-read-only (is-approved-receiver (receiver principal))
  (default-to false (map-get? approved-receivers receiver))
)

(define-read-only (calculate-fee (amount uint))
  (begin
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (let ((raw-fee (/ (* amount (var-get fee-basis-points)) u10000)))
      (ok (if (> raw-fee u0) raw-fee u1))
    )
  )
)

(define-read-only (get-admin)
  (ok (var-get admin))
)
