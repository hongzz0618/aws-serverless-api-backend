# 005. Use Conditional Writes for Item Creation

## Status

Accepted

## Amendment

The no-overwrite decision in this ADR remains active.

The earlier version of this ADR stated that retry idempotency was outside the project scope. That part was superseded by [ADR 007](007-use-idempotency-keys-for-item-creation.md), which introduced client-provided idempotency keys, request reservations, and response replay.

## Context

`POST /items` generates a UUID for each new item and stores it as the DynamoDB partition key.

An unconditional DynamoDB write can overwrite an existing record when the same ID is written again. UUID collisions are unlikely, but silently replacing an existing item would still be incorrect and could become more relevant if IDs are generated differently or supplied by callers in the future.

The API therefore needs an explicit storage-level guarantee that item creation cannot replace an existing record.

## Decision

Create item records with a DynamoDB conditional write using:

```text
attribute_not_exists(id)
```

In the current implementation, the item write is part of a `TransactWriteItems` operation that also marks the associated idempotency record as completed.

If the item condition fails, the API returns:

```text
409 Conflict
```

with the safe response:

```json
{
  "error": "Item already exists"
}
```

Unexpected DynamoDB or internal failures return a generic `500` response without exposing table names, request fingerprints, AWS request IDs, or stack traces.

## Relationship to Request Idempotency

This decision protects the uniqueness of an item ID. It does not, by itself, make retries of `POST /items` safe.

Request-level retry behavior is handled separately by ADR 007:

- The client supplies an `Idempotency-Key`.
- The server reserves that key before creating the item.
- The completed response is stored for later replay.
- Reusing the key with another payload returns `409 Conflict`.
- Replaying the same key and payload returns the original response.

Both controls remain useful because they protect different boundaries:

- The idempotency record protects a logical create request.
- The conditional item write protects the item key in DynamoDB.

## Rationale

A storage-level condition is safer than checking for an item before writing it. A separate read followed by a write would leave a race window in which two requests could both observe that the item is absent.

DynamoDB evaluates the condition as part of the write operation, so concurrent attempts for the same item ID cannot both succeed.

The condition also keeps the API behavior explicit: item creation either stores a new record or reports a conflict. It never silently replaces an existing item.

## Trade-offs

- The create flow must distinguish an item condition failure from other transaction failures.
- Transaction cancellation reasons must be interpreted carefully before mapping a failure to `409`.
- Generated UUID collisions are extremely unlikely, so this protection is mainly a correctness boundary rather than a common runtime path.
- Conditional item creation does not replace request-level idempotency.
- The create path is more complex than a basic `PutItem`, but the resulting behavior is safer and easier to reason about.

## Test Coverage

Tests cover:

- Successful item creation returning `201 Created`.
- Item ID conflicts returning a safe `409 Conflict`.
- Unexpected DynamoDB failures returning a safe `500` response.
- Idempotency replay and conflict behavior through the separate ADR 007 flow.

The tests assert public API behavior rather than depending on unnecessary AWS SDK implementation details.

## Consequences

Item creation cannot silently overwrite an existing item with the same ID.

The current create flow combines:

1. An idempotency-key reservation.
2. A conditional item write.
3. Atomic completion of the idempotency record.

If IDs later become caller-provided, imported, or derived from another system, the conditional no-overwrite rule should remain in place.
