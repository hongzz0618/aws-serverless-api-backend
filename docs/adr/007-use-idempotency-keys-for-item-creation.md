# 007. Use Idempotency Keys for Item Creation

## Status

Accepted

## Context

`POST /items` creates a new item ID inside the Lambda handler. Before this decision, a client retry after a timeout or network failure could run a second Lambda invocation, generate a second UUID, and create a second item.

The existing conditional write protects a generated item ID from overwrite. It does not make the create request replay-safe because the client has no stable request token.

## Problem

Create requests need a server-side idempotency contract so clients can retry an uncertain `POST /items` result without accidentally creating duplicate items.

The design must also handle concurrent submissions using the same token, avoid storing raw request bodies, keep internal records out of the public item namespace, and remain small enough for this reference API.

## Decision

Require callers to send `Idempotency-Key` on `POST /items`.

The key must be client-generated, 8 to 128 characters, and contain only letters, digits, hyphen, underscore, colon, or period. Header lookup is case-insensitive to match API Gateway event behavior.

The handler validates and normalizes the request body first, then computes a SHA-256 fingerprint over the validated create fields. For the current schema, the fingerprint is based only on the trimmed `name` value in a fixed field order. The raw body, headers, and full key are not stored in logs.

## API semantics

- Missing or invalid `Idempotency-Key`: `400 Bad Request`.
- First valid key and payload: create the item and return `201 Created`.
- Same key and same payload after completion: return the original `201 Created` response with the same item ID and `Idempotency-Replayed: true`.
- Same key with a different valid payload: return `409 Conflict`.
- Same key and same payload while the original request is still reserved: return `409 Conflict` with a safe in-progress message.
- Unexpected idempotency storage or item creation failures: return a safe `500`.

## DynamoDB model

Use a separate DynamoDB table named `<project>-idempotency` instead of mixing internal records into the public items table.

The table uses `idempotencyKey` as the partition key and stores:

- request fingerprint
- status
- item ID
- saved response body
- safe key correlation hash
- created and updated timestamps
- expiration timestamp for TTL

The table uses on-demand billing, server-side encryption, and TTL on `expiresAt`. Point-in-time recovery is not enabled because the existing reference environment does not enable PITR for the items table and the idempotency records are short-lived operational records.

## Concurrency model

The handler first writes an `IN_PROGRESS` reservation with a conditional `PutItem`. If another request with the same key arrives before completion, it reads the existing record consistently.

Completion uses `TransactWriteItems` to atomically:

- create the item with `attribute_not_exists(id)`
- mark the idempotency record `COMPLETED`
- store the final response needed for replay

This keeps item creation and completed replay state together once the request reaches the completion step.

## Failure windows

If Lambda creates the reservation but fails before the transaction, no item is created. The handler attempts to delete the reservation when it catches an item creation or completion failure.

If Lambda exits unexpectedly after reservation but before transaction, the `IN_PROGRESS` record can remain until its short reservation expiry. A later request can overwrite an expired `IN_PROGRESS` reservation, and DynamoDB TTL eventually removes stale records.

If the transaction succeeds but the client times out before receiving the response, replay returns the stored original response.

## Alternatives considered

### Use only generated UUIDs

Rejected. Generated UUIDs prevent practical ID collision, but they do not connect client retries to the original create request.

### Use API Gateway cache

Rejected. API Gateway caching is not a write idempotency mechanism and would not atomically coordinate DynamoDB writes.

### Client retries without server idempotency

Rejected. Clients cannot know whether a timed-out request created an item unless the server stores a stable request token and response.

### Use only a transaction without reservation

Rejected for this API contract because concurrent same-key requests would have no explicit `IN_PROGRESS` state to return. The reservation makes in-flight behavior clear and testable.

### Reservation, create, then complete without a transaction

Rejected because item creation could succeed while idempotency completion fails, leaving an orphan item that cannot be replayed from the key. The chosen transaction narrows that window by coupling item creation and completion.

## Operational consequences

Structured logs include stable events:

- `idempotency_reserved`
- `idempotency_replayed`
- `idempotency_conflict`
- `idempotency_in_progress`
- `idempotency_failed`

Logs include a short hash of the key for correlation, not the full key. Terraform adds log metric filters for replay, conflict, and failed idempotency operations. Replay and conflict are not alarmed by default because replay is expected and conflict is usually client behavior.

## Limitations

The idempotency contract is scoped to `POST /items`; it does not change `GET`, `PUT`, or `DELETE`.

The record TTL is not immediate deletion. Operators should treat stuck records carefully and avoid deleting unknown records in active environments.

This decision has not been validated against a deployed AWS API in this batch. Deployment validation should verify first create, exact replay, same-key conflict, normal item lifecycle, and CloudWatch metric behavior.
