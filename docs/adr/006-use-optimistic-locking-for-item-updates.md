# 006. Use Optimistic Locking for Item Updates

## Status

Accepted

## Context

The item API supports updates through `PUT /items/{id}`. Without a concurrency check, two clients can read the same item version, submit different updates, and allow the later write to silently overwrite the earlier one.

The API stores a numeric `version` attribute on new items. Legacy records may exist without this attribute because earlier item records did not require version tracking.

## Decision

Use version-based optimistic locking for item updates.

The update handler requires callers to submit the item version they last read. DynamoDB enforces the check with a conditional `UpdateItem` expression:

- If the submitted version matches the stored version, the update succeeds.
- A successful update writes the new name and increments `version` by one.
- If the submitted version is stale and the item still exists, the API returns `409 Conflict`.
- If the item has been deleted, the API returns `404 Not Found`.

For compatibility with legacy records, an item without a stored `version` can be updated when the caller submits `version: 1`. That update writes `version: 2`, bringing the record into the current shape.

## Rationale

Optimistic locking keeps the API small while preventing silent lost updates. DynamoDB conditional expressions are a direct fit because the version check runs in the same storage operation as the write.

The handler uses consistent reads for update pre-reads and for the follow-up read after a conditional update failure. This reduces ambiguity around recently changed or deleted records. When `UpdateItem` reports `ConditionalCheckFailedException`, the handler performs a follow-up `GetItem`:

- If the item is missing, the request is reported as `404`.
- If the item is present, the request is reported as `409`.

This keeps missing-item behavior distinct from stale-version behavior, including the race where another request deletes the item between the initial read and the conditional update.

## Trade-Offs

- Each update performs a pre-read before the conditional write.
- Conditional failures require one extra read to distinguish delete races from stale versions.
- `ConsistentRead` can use more DynamoDB read capacity than eventually consistent reads.
- Clients must preserve and submit the latest version for updates.
- The behavior is still scoped to one item at a time; it does not provide multi-item transactions or broader workflow coordination.

## Test Coverage

Unit tests cover successful version increments, stale-version conflicts, legacy records without a version attribute, missing items, delete races that return `404`, and safe `500` responses when the follow-up read fails.

The optional deployed smoke test covers the lifecycle through create, read, update, read-after-update, stale update conflict, delete, and read-after-delete.

## Consequences

The API now has explicit update concurrency semantics without adding services or changing the table design. The cost is a slightly more complex update handler and additional read operations on update paths, especially when conflicts occur.
