;; STX Test Receiver v2
;; Simplest possible flash loan receiver - borrows STX and repays immediately.
;; Targets flashstack-stx-core-v2 (BC1 two-step-admin successor), not the
;; deployed v1 core. stx-test-receiver.clar hardcodes .flashstack-stx-core by
;; name -- Clarity requires a statically-known contract-call? target, so a
;; receiver can't dynamically call the `core` principal it's handed in the
;; callback. That's a real dependency, not a naming choice, so this is a new
;; contract rather than an edit to the v1 receiver.

(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

(define-constant ERR-REPAY (err u500))

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    (fee-bp (unwrap! (contract-call? .flashstack-stx-core-v2 get-fee-basis-points) ERR-REPAY))
    (raw-fee (/ (* amount fee-bp) u10000))
    (fee (if (> raw-fee u0) raw-fee u1))
    (total-owed (+ amount fee))
  )
    ;; Repay principal + fee to core
    (unwrap! (as-contract (stx-transfer? total-owed tx-sender core)) ERR-REPAY)
    (ok true)
  )
)
