;; Cross-Pool stSTX Arbitrage Receiver -- DRAFT, NOT YET DEPLOYED
;;
;; Flash-borrowed cross-pool arbitrage between the TWO live Bitflow STX/stSTX
;; stableswap pools (v-1-1 and v-1-2). Unlike the single-pool round-trip
;; (bitflow-arb-receiver), this captures a genuine price gap: buy stSTX cheap in
;; one pool, sell it dear in the other, in ONE atomic transaction.
;;
;; Flow (one atomic tx, two transactions to run):
;;   tx1  arm(amount, direction, min-ststx, min-stx-back)  -- owner-only. Operator
;;        quotes both pools' get-dy off-chain and sets REAL min-outs (never u1).
;;        One-shot, expires in ~10 blocks.
;;   tx2  flashstack-stx-core.flash-loan(amount, .crosspool-ststx-receiver)
;;        `- core sends STX -> execute-stx-flash:
;;              leg 1  swap-x-for-y (STX -> stSTX) in the CHEAP pool, min-ststx
;;              leg 2  swap-y-for-x (stSTX -> STX) in the RICH pool, min-stx-back
;;              repay amount + fee to core; profit stays in this receiver
;;
;; direction parameterises which pool is cheap (either can be):
;;   u0 -> buy on v-1-1, sell on v-1-2
;;   u1 -> buy on v-1-2, sell on v-1-1
;;
;; Discipline (ported from deepstack-rebalance-receiver, proven on mainnet):
;;   - min-outs are REQUIRED armed params from fresh off-chain quotes, never u1
;;     floors -- both swap legs enforce them, so a bad gap reverts on the swap,
;;     not only on the repay assert.
;;   - min-stx-back must be >= amount + fee: the sell leg alone must cover the loan.
;;   - one-shot arming with a block-height TTL: a stale quote cannot be replayed.
;;   - strict auth: callback only from the core, only on an operator-initiated loan.
;;   - amount capped small (<= 100 STX) -- the busier pool does ~$1.9k/day.
;;   - trait/target principals are INLINE LITERALS: define-constant principals fail
;;     Clarity static analysis in trait-argument position (BUILD_A_RECEIVER.md rule 3).
;;
;; BEFORE DEPLOYING (operator checklist):
;;   1. DO NOT deploy or whitelist yet -- wait for DeepStack scanner v2 to show, over
;;      a week+, that the inter-pool gap clears BOTH pools' fees.
;;   2. Deploy FROM THE OPERATOR wallet (CONTRACT-OWNER binds to the deployer).
;;   3. Whitelist on flashstack-stx-core (add-approved-receiver, admin call).
;;   4. First live run: tiny amount, Allow-mode post-conditions on the STX outflow.

(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

;; =============================================
;; Constants -- all mainnet, verified live 2026-07-19
;; =============================================

;; The operator wallet. Deliberately no transfer path: it can't be bricked by a
;; typo'd transfer-admin, but a lost operator key permanently strands whatever
;; the rescue hatches hold. Fine at the 100 STX cap; decide before raising it.
(define-constant CONTRACT-OWNER tx-sender)

;; Used for the caller check only (a bare principal is fine here). Contract-call
;; targets and trait arguments below are written as inline literals on purpose.
(define-constant FLASHSTACK-CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)

(define-constant ARM-TTL-BLOCKS u10)        ;; a quoted min-out goes stale fast
(define-constant MAX-ARM        u100000000) ;; 100 STX cap while the gap is unproven

(define-constant ERR-NOT-OWNER       (err u400))
(define-constant ERR-NOT-ARMED       (err u401))
(define-constant ERR-ARM-EXPIRED     (err u402))
(define-constant ERR-UNAUTHORIZED    (err u403))
(define-constant ERR-AMOUNT-MISMATCH (err u404))
(define-constant ERR-BAD-PARAMS      (err u405))
(define-constant ERR-FEE-READ        (err u406))
(define-constant ERR-SWAP-FAILED     (err u407))
(define-constant ERR-REPAY-FAILED    (err u408))
(define-constant ERR-TRANSFER-FAILED (err u409))

;; =============================================
;; One-shot armed trade
;; =============================================

(define-data-var pending
  (optional { amount: uint, direction: uint, min-ststx: uint, min-stx-back: uint, expires: uint })
  none)

;; Arm the next arb. min-ststx and min-stx-back MUST come from fresh off-chain
;; get-dy quotes on each pool minus the slippage budget. min-stx-back >= amount is
;; enforced here; the callback additionally enforces min-stx-back >= amount + fee.
(define-public (arm (amount uint) (direction uint) (min-ststx uint) (min-stx-back uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (asserts! (and (> amount u0) (<= amount MAX-ARM)) ERR-BAD-PARAMS)
    (asserts! (or (is-eq direction u0) (is-eq direction u1)) ERR-BAD-PARAMS)
    (asserts! (and (> min-ststx u0) (> min-stx-back u0)) ERR-BAD-PARAMS)
    (asserts! (>= min-stx-back amount) ERR-BAD-PARAMS)
    (ok (var-set pending (some {
      amount: amount,
      direction: direction,
      min-ststx: min-ststx,
      min-stx-back: min-stx-back,
      expires: (+ stacks-block-height ARM-TTL-BLOCKS)
    })))
  )
)

(define-public (disarm)
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (ok (var-set pending none))
  )
)

;; =============================================
;; Flash loan callback
;; =============================================

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    (trade (unwrap! (var-get pending) ERR-NOT-ARMED))
  )
    ;; One-shot: consumed now; a reverted tx rolls this back, so a failed attempt
    ;; stays armed until it succeeds, expires, or is disarmed.
    (var-set pending none)

    ;; Auth: only the FlashStack core, mid-loan, on a loan the operator initiated.
    (asserts! (is-eq contract-caller FLASHSTACK-CORE) ERR-UNAUTHORIZED)
    (asserts! (is-eq tx-sender CONTRACT-OWNER)        ERR-UNAUTHORIZED)
    (asserts! (is-eq amount (get amount trade))       ERR-AMOUNT-MISMATCH)
    (asserts! (<= stacks-block-height (get expires trade)) ERR-ARM-EXPIRED)

    (let (
      (fee-bp (unwrap! (contract-call? 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core
                         get-fee-basis-points) ERR-FEE-READ))
      (raw-fee (/ (* amount fee-bp) u10000))
      (fee (if (> raw-fee u0) raw-fee u1))
      (total-owed (+ amount fee))
      (dir (get direction trade))
      (min-ststx (get min-ststx trade))
      (min-stx-back (get min-stx-back trade))
    )
      ;; The sell leg alone must cover the loan, so the repay assert is a backstop,
      ;; not the only guard.
      (asserts! (>= min-stx-back total-owed) ERR-BAD-PARAMS)

      ;; Execute the two legs in the armed direction (literal-target branches).
      (if (is-eq dir u0)
        (try! (do-arb-1to2 amount min-ststx min-stx-back))
        (try! (do-arb-2to1 amount min-ststx min-stx-back)))

      ;; Repay principal + fee from this contract's balance (the round-trip returned
      ;; STX here). Whatever remains above total-owed is profit and stays put.
      (let ((bal (stx-get-balance (as-contract tx-sender))))
        (asserts! (>= bal total-owed) ERR-REPAY-FAILED)
        (unwrap! (as-contract (stx-transfer? total-owed tx-sender core)) ERR-REPAY-FAILED)
        ;; `profit` is the whole residual balance above total-owed, not this trade's
        ;; gain -- it over-reports once profit accumulates or anyone sends STX here.
        ;; Analytics only, not per-trade P&L; a losing trade reverts on the swap legs.
        (print {
          event: "crosspool-arb",
          borrowed: amount,
          fee: fee,
          direction: dir,
          profit: (- bal total-owed)
        })
        (ok true)
      )
    )
  )
)

;; =============================================
;; Arb legs -- literal targets, one per direction
;; =============================================

;; direction u0: buy stSTX in v-1-1 (cheap), sell in v-1-2 (rich)
(define-private (do-arb-1to2 (amount uint) (min-ststx uint) (min-stx-back uint))
  (let ((bought (unwrap! (as-contract (contract-call?
          'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stableswap-stx-ststx-v-1-1 swap-x-for-y
          'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token
          'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stx-ststx-lp-token-v-1-1
          amount min-ststx)) ERR-SWAP-FAILED)))
    (unwrap! (as-contract (contract-call?
      'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stableswap-stx-ststx-v-1-2 swap-y-for-x
      'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token
      'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stx-ststx-lp-token-v-1-2
      bought min-stx-back)) ERR-SWAP-FAILED)
    (ok true)
  )
)

;; direction u1: buy stSTX in v-1-2 (cheap), sell in v-1-1 (rich)
(define-private (do-arb-2to1 (amount uint) (min-ststx uint) (min-stx-back uint))
  (let ((bought (unwrap! (as-contract (contract-call?
          'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stableswap-stx-ststx-v-1-2 swap-x-for-y
          'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token
          'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stx-ststx-lp-token-v-1-2
          amount min-ststx)) ERR-SWAP-FAILED)))
    (unwrap! (as-contract (contract-call?
      'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stableswap-stx-ststx-v-1-1 swap-y-for-x
      'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token
      'SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stx-ststx-lp-token-v-1-1
      bought min-stx-back)) ERR-SWAP-FAILED)
    (ok true)
  )
)

;; =============================================
;; Escape hatches -- owner only
;; =============================================

(define-public (rescue-stx (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (unwrap! (as-contract (stx-transfer? amount tx-sender to)) ERR-TRANSFER-FAILED)
    (ok true)
  )
)

(define-public (rescue-ststx (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (unwrap! (as-contract (contract-call?
      'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token
      transfer amount tx-sender to none)) ERR-TRANSFER-FAILED)
    (ok true)
  )
)

;; =============================================
;; Read-only
;; =============================================

(define-read-only (get-pending) (ok (var-get pending)))
(define-read-only (get-owner)   (ok CONTRACT-OWNER))
(define-read-only (get-max-arm) (ok MAX-ARM))
