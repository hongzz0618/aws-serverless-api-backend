# 002. Use DynamoDB for Item Storage

## Status

Accepted

## Context

The API stores simple item records and retrieves or deletes them by a generated UUID. The current access pattern is direct lookup by item ID, not reporting, relational joins, or broad ad-hoc querying.

## Decision

Use a DynamoDB table with `id` as the partition key and on-demand billing.

## Rationale

DynamoDB matches the current access pattern well: write an item by UUID, fetch that exact item by UUID, and delete that exact item by UUID. For this scope, a single-table key-value design is simpler than operating a relational database or designing a more complex data model.

Benefits:

- Simple key-value access for the API's primary item lookup path.
- Managed scaling and availability without database server administration.
- On-demand billing keeps the demo project easy to run at low volume.
- IAM permissions can be scoped to the table and the specific actions the Lambdas need.

## Trade-Offs

- DynamoDB is not optimized for ad-hoc queries unless indexes and access patterns are designed up front.
- New query requirements may require additional indexes, duplicated attributes, or a redesigned table strategy.
- Hot partitions can become a concern if future traffic concentrates on a small set of partition keys.
- DynamoDB data modeling is access-pattern-first, which is different from relational modeling.

## Consequences

The table design is intentionally simple and appropriate for the current API. If the project grows into search, list views, filtering, reporting, or multi-tenant access patterns, the data model should be revisited before adding features.
