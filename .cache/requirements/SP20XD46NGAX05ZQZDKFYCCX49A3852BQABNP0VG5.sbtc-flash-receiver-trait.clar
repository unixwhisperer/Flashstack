;; sBTC Flash Receiver Trait
;; Interface all sBTC flash loan receivers must implement

(define-trait sbtc-flash-receiver-trait
  (
    ;; Called by flashstack-sbtc-core after transferring sBTC to receiver.
    ;; Receiver must repay amount + fee back to core before this returns.
    (execute-sbtc-flash (uint principal) (response bool uint))
  )
)
