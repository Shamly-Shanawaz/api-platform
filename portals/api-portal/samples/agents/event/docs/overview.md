# Payment Fraud Watcher

An event-driven agent. It doesn't take requests: publish a payment to `payments.requested`
and it publishes a verdict (`RELEASE`, `HOLD` or `BLOCK`) to `payments.scored`.

Ask the platform team for Kafka credentials for the topics above.
