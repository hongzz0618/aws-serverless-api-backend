# Operations Runbook

This runbook covers post-deployment validation, log inspection, monitoring, troubleshooting, and teardown for the serverless item API.

## Post-Deployment Validation

After `terraform apply`, retrieve the API URL:

```bash
cd terraform
terraform output -raw api_url
```

The Terraform configuration creates a `dev` API Gateway stage. The output should end with `/dev`.

## Recommended Smoke Test

The repository includes a post-deployment smoke test at:

```text
scripts/smoke-test.mjs
```

Run it against the deployed API:

```bash
cd terraform
API_URL="$(terraform output -raw api_url)"

cd ../lambdas
API_URL="$API_URL" npm run smoke:test
```

The smoke test verifies:

* Item creation
* Idempotent replay using the same key and payload
* Conflict when the same key is reused with another payload
* Initial item version
* Item retrieval
* Version-based update
* Read after update
* Stale-version conflict
* Item deletion
* `404 Not Found` after deletion
* Best-effort cleanup if a later step fails

A successful run ends with:

```text
[smoke] Passed
```

The smoke test is not part of the default GitHub Actions workflow because it requires a deployed API URL.

## Manual Idempotency Checks

Use a unique key for each manual test session.

### Create an item

```bash
curl -i -X POST "<API_URL>/items" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: item-create:00000001" \
  -d '{"name":"Laptop charger"}'
```

Expected result:

* `201 Created`
* A JSON response containing `message`, `id`, and `version: 1`

### Replay the same request

Send the same key and the same body:

```bash
curl -i -X POST "<API_URL>/items" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: item-create:00000001" \
  -d '{"name":"Laptop charger"}'
```

Expected result:

* `201 Created`
* The same item ID
* Response header `Idempotency-Replayed: true`

### Reuse the key with another payload

```bash
curl -i -X POST "<API_URL>/items" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: item-create:00000001" \
  -d '{"name":"Different item"}'
```

Expected result:

```text
409 Conflict
```

```json
{
  "error": "Idempotency key was already used with a different request"
}
```

The complete request and response contract is documented in `openapi/openapi.yaml`.

## Inspect CloudWatch Logs

Terraform creates one log group for each Lambda function:

* `/aws/lambda/<project_name>-create`
* `/aws/lambda/<project_name>-get`
* `/aws/lambda/<project_name>-update`
* `/aws/lambda/<project_name>-delete`

API Gateway access logs are written to the log group exposed by:

```bash
cd terraform
terraform output -raw api_access_log_group_name
```

Tail the API Gateway access logs with the AWS CLI:

```bash
aws logs tail "$(terraform output -raw api_access_log_group_name)" --follow
```

For Lambda failures, inspect the log group associated with the affected route.

Useful structured fields include:

* `timestamp`
* `level`
* `message`
* `service`
* `requestId`
* `route`
* `operation`
* `statusCode`
* `itemId`
* `validationError`
* `event`
* `idempotencyKeyHash`
* `recovered`
* `errorName`

Raw exception messages and stack traces are intentionally not emitted by the application logger.

## Idempotency Log Events

The create Lambda emits stable event names for idempotency behavior:

| Event                     | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `idempotency_reserved`    | A new key was reserved, or an expired reservation was recovered |
| `idempotency_replayed`    | A completed request returned its stored response                |
| `idempotency_conflict`    | The key was reused with another validated payload               |
| `idempotency_in_progress` | A request found an active reservation                           |
| `idempotency_failed`      | Reservation, completion, inspection, or cleanup failed          |

Logs include a short `idempotencyKeyHash` for correlation.

They do not include:

* The full idempotency key
* The request fingerprint
* Request bodies
* Request headers
* DynamoDB table names

## Alarms and Metrics

Terraform exposes the configured alarm names:

```bash
cd terraform
terraform output cloudwatch_alarm_names
```

Relevant signals include:

### Lambda

* `Errors` for unhandled invocation or runtime failures
* `Throttles` for each Lambda function
* Custom handled-500 metrics for failures caught by the application before returning a safe HTTP response

A caught application error can return HTTP `500` without increasing the Lambda `Errors` metric because the Lambda invocation itself completed normally.

### API Gateway

* `4XXError`
* `5XXError`
* `Latency`

The `4XXError` metric includes expected client outcomes such as validation failures, missing records, and version or idempotency conflicts. It should be interpreted together with route logs and traffic volume.

### Idempotency

Custom log metrics track:

* Replayed requests
* Conflicting key reuse
* Idempotency failures

Replay is normally expected retry behavior.

A conflict usually indicates incorrect client key reuse.

Idempotency failure events should be investigated because they indicate a reservation, storage, transaction, or recovery problem.

### DynamoDB

Terraform configures `SystemErrors` monitoring for the item-table operations represented in the current alarm definition.

Application-level idempotency failures are also surfaced through the create Lambda logs and custom idempotency metrics.

Alarm notifications are optional and controlled by the Terraform `alarm_actions` variable. Without configured actions, alarms still change state but do not notify a recipient.

## Troubleshooting

| Symptom                     | Likely cause                                                                                                       | Checks                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `400` from `POST /items`    | Missing or invalid idempotency key, invalid JSON, or invalid `name`                                                | Confirm the header is 8–128 valid characters and the body contains a non-empty string of at most 100 characters |
| `400` from an item route    | Invalid UUID or update body                                                                                        | Confirm the path ID is a UUID and `PUT` includes a positive integer `version`                                   |
| `404 Item not found`        | The item does not exist or was deleted during an update                                                            | Check the item ID and inspect the route-specific Lambda logs                                                    |
| `409` from create           | Different payload for the same key, active reservation, or rare item ID collision                                  | Inspect `event`, `idempotencyKeyHash`, and the response message                                                 |
| `409 Item version conflict` | The submitted update version is stale                                                                              | Read the current item and retry with its latest version                                                         |
| `500` response              | DynamoDB failure, missing environment configuration, IAM failure, malformed stored data, or another internal error | Correlate `requestId`, `route`, `operation`, `statusCode`, and `errorName`                                      |
| Alarm has no notification   | `alarm_actions` is empty or invalid                                                                                | Review the Terraform variable and the target SNS or notification configuration                                  |
| Smoke test cannot connect   | Incorrect API URL, destroyed deployment, region mismatch, or network issue                                         | Confirm `terraform output -raw api_url` and test a direct request                                               |

## Idempotency Recovery Behavior

A newly accepted idempotency key is stored as an `IN_PROGRESS` reservation before the item is created.

The reservation contains:

* The request fingerprint
* The generated item ID
* A short correlation hash
* An application lease timestamp
* A DynamoDB TTL cleanup timestamp

Important behavior:

* A request with the same key and payload receives `409` while the reservation lease is active.
* A request with another payload receives `409`, even after the original lease expires.
* A later request with the same key and payload can conditionally recover an expired reservation.
* Recovery reuses the stored item ID.
* Only one concurrent recovery attempt can win.
* DynamoDB TTL cleanup is asynchronous and is not used as the runtime locking mechanism.

Do not manually delete unknown idempotency records in an active environment unless the related request is understood and no client can still rely on the key.

## Ambiguous Transaction Outcomes

Item creation and idempotency completion are written in one DynamoDB transaction.

The transaction uses a deterministic `ClientRequestToken` for DynamoDB's short transaction-retry window.

If the handler receives an ambiguous transaction error:

1. It performs a strongly consistent read of the idempotency record.
2. A `COMPLETED` record returns the stored original response.
3. An unresolved `IN_PROGRESS` record remains available for lease-based recovery.
4. The handler does not blindly delete an uncertain reservation.

The idempotency table remains the business replay record for the configured retention window. DynamoDB TTL later removes expired records asynchronously.

## Environment Configuration

All four handlers require:

```text
TABLE_NAME
```

The create handler also requires:

```text
IDEMPOTENCY_TABLE_NAME
```

Terraform configures these values.

If a value is missing or changed manually, the affected route returns a safe `500` response. Verify the Lambda environment configuration in Terraform and in the deployed function.

The application logs expose `errorName`, but intentionally do not expose the raw exception message.

## Cleanup and Teardown

Remove the Terraform-managed resources with:

```bash
cd terraform
terraform destroy
```

Review the destroy plan before confirming.

After teardown:

* Confirm the API Gateway API is gone.
* Confirm the Lambda functions are gone.
* Confirm the two DynamoDB tables are gone.
* Confirm Terraform-managed CloudWatch log groups and alarms were removed.
* Check for manually created or externally managed resources that were not part of the Terraform state.

## Known Operational Limitations

* API Gateway routes are unauthenticated.
* CORS and `OPTIONS` routes are not configured.
* There is no WAF integration.
* There is no per-client quota or usage-plan enforcement.
* There is no distributed tracing.
* There is no CloudWatch dashboard or dedicated log analytics layer.
* Alarm notifications require optional `alarm_actions`.
* Terraform uses local state unless a backend is configured outside this repository.
* GitHub Actions validates and packages the project but does not deploy it.
* The post-deployment smoke test is not run automatically in CI.
* DynamoDB monitoring does not provide dedicated system-error alarms for every idempotency-table and transaction-specific operation.
* Significant changes to the idempotency implementation or related CloudWatch metrics should be revalidated against a deployed environment.

## Related Documentation

* [OpenAPI contract](../openapi/openapi.yaml)
* [AWS deployment validation](deployment-validation.md)
* [ADR 005: Conditional item creation](adr/005-use-conditional-writes-for-item-creation.md)
* [ADR 006: Optimistic locking](adr/006-use-optimistic-locking-for-item-updates.md)
* [ADR 007: Idempotency keys](adr/007-use-idempotency-keys-for-item-creation.md)
