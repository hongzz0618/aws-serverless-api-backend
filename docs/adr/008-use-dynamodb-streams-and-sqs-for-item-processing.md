# 008. Use DynamoDB Streams and SQS for Item Processing

## Status

Accepted

## Context

`POST /items` already creates the durable item record and returns the public API response. The next requirement is post-create item processing that can run after the API write without making the client wait for downstream work.

The design needs to keep the public API unchanged, preserve idempotent create and optimistic-locking behavior, handle duplicate delivery, and provide operational signals for retry and DLQ investigation.

## Decision

Use DynamoDB Streams `INSERT` records from the items table as the source of item-created work.

The async path is:

```text
Items table stream
-> Dispatcher Lambda
-> SQS Standard Queue
-> Worker Lambda
-> conditional update on the item
```

The Dispatcher converts each item `INSERT` record into an SQS message. The message uses the deterministic event ID `item.created.v1:<itemId>`.

The Worker processes queue messages and conditionally updates the item with `processingStatus = COMPLETED`, `processedEventId`, `processedAt`, and `creationMetadata`. The update is conditional so the same event can be delivered more than once without changing the completed item again.

Both event source mappings use partial batch failure reporting where supported. The Worker reports `ReportBatchItemFailures` to let SQS retry only failed messages. Repeated Worker failures move a message to the DLQ. Operators investigate the DLQ message, correct the root cause, and redrive to the main queue when appropriate.

The SQS event source mapping sets `maximum_concurrency = 2`. The Worker does not use reserved concurrency.

## Alternatives considered

### Direct DynamoDB Stream to Worker

This would remove SQS from the path, but it would also couple stream retry behavior directly to processing failures. SQS adds queue depth, age, DLQ, and redrive controls for Worker failures.

### EventBridge or SNS fan-out

These services are useful when multiple independent consumers need the same event. The current design has one post-create processing consumer, so the extra routing layer is not needed.

### Step Functions

Step Functions would provide explicit workflow state and retries. The current processing step is a single conditional update, so a state machine would add more infrastructure than this phase requires.

### Transactional outbox

An outbox table can make event publication an explicit application write. DynamoDB Streams already emits the item creation record from the durable item table, so a separate outbox was not added.

### SQS FIFO

FIFO queues provide ordering and deduplication features with additional throughput and grouping considerations. The Worker is idempotent and does not require strict ordering for the current item-created event.

### Synchronous processing inside POST

Doing the work inside `POST /items` would simplify infrastructure, but it would extend request latency and couple client success to downstream processing work.

## Consequences

Create returns after the durable item and idempotency records are written. The item can be visible with `processingStatus = PENDING` until async processing completes.

The public API version is not incremented by Worker processing. The version remains tied to public API updates.

SQS Standard Queue delivery is at least once, so Worker idempotency is required. Duplicate delivery is treated as normal behavior.

Queue depth, queue age, DLQ visible messages, Worker logs, and application-level processing metrics become part of normal operations.

## Failure and retry semantics

The Dispatcher uses DynamoDB Stream batch failure reporting. A failed stream record can be retried from the failed sequence number.

The Worker uses SQS partial batch failure reporting. Retryable failures leave the message available for retry. After repeated failures, the message moves to the DLQ.

DLQ redrive should happen only after the failure category and root cause are understood and corrected. Redriven messages run through the same idempotent Worker logic.

## Operational limitations

The DynamoDB Stream mapping currently has no finite retry count and no stream on-failure destination. A poison Stream record can block shard progress until record expiry.

SQS event-source `maximum_concurrency = 2` limits consumption for this event source, but it does not reserve account-wide Lambda capacity.

The design does not add multi-consumer fan-out, cross-service workflow state, or exactly-once delivery.

This decision was validated against a deployed AWS API in `eu-west-1` at commit `30f14d4`. See [AWS Deployment Validation](../deployment-validation.md).
