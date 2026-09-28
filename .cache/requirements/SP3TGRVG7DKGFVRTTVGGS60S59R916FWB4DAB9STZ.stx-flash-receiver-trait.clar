;; STX Flash Receiver Trait
;; Interface all STX flash loan receivers must implement

(define-trait stx-flash-receiver-trait
  (
    ;; Called by flashstack-stx-core after transferring STX to receiver.
    ;; Receiver must repay amount + fee back to core before this returns.
    (execute-stx-flash (uint principal) (response bool uint))
  )
)
