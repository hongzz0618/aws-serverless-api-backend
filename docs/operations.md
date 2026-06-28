# Operations Runbook

This runbook covers post-deployment validation, log inspection, monitoring, troubleshooting, and teardown for the serverless item API.

## Post-Deployment Validation

After `terraform apply`, retrieve the API URL:

```bash
cd terraform
terraform output -raw api_url
```

The Terraform configuration creates a `dev` API Gateway stage. The output should end with `/dev`.

## API Gateway Account Setting Warning

Terraform manages `aws_api_gateway_account`, which controls a regional account-level API Gateway CloudWatch role. Applying this configuration may replace the API Gateway CloudWatch role configured for the AWS account and region.

Destroying with `reset_on_delete = true` clears that configured role. This repository was validated in a disposable controlled environment. In a shared account or region, inspect the existing API Gateway account configuration before Apply or Destroy.

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
* `/aws/lambda/<project_name>-item-created-dispatcher`
* `/aws/lambda/<project_name>-item-processing-worker`

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

## Async Architecture Summary

The asynchronous item-processing path is:

```text
POST /items
-> Items DynamoDB Stream
-> Dispatcher Lambda
-> SQS standard queue
-> Worker Lambda
-> Item processingStatus = COMPLETED
-> repeated failures reach the DLQ
```

The `creationMetadata` field is a snapshot derived from the item name at creation time. Later `PUT` requests do not recalculate that snapshot, and the worker does not modify the public API `version` field.

## Async Post-Deployment Validation

After deploying to AWS, retrieve the outputs needed for async validation:

```bash
cd terraform

API_URL="$(terraform output -raw api_url)"
ITEMS_TABLE="$(terraform output -raw items_table_name)"
QUEUE_URL="$(terraform output -raw item_processing_queue_url)"
DLQ_URL="$(terraform output -raw item_processing_dlq_url)"
```

Create a test item with a unique idempotency key:

```bash
curl -sS -X POST "$API_URL/items" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: async-validation-<unique-value>" \
  -d '{"name":"Async Validation Item"}'
```

Record the item ID from the JSON response. Poll DynamoDB directly until the worker has completed processing:

```bash
aws dynamodb get-item \
  --table-name "$ITEMS_TABLE" \
  --key '{"id":{"S":"<ITEM_ID>"}}' \
  --consistent-read
```

Expected internal state:

* `processingStatus` is `COMPLETED`
* `processedEventId` is `item.created.v1:<ITEM_ID>`
* `processedAt` exists
* `creationMetadata.normalizedName` is `async validation item`
* `creationMetadata.nameLength` matches the original creation name

Do not use the public `GET /items/{id}` API to validate internal processing fields; that route intentionally exposes the public item contract only.

## Inspect Async Logs

Tail the dispatcher and worker log groups:

```bash
aws logs tail "$(terraform output -raw item_created_dispatcher_log_group_name)" --follow
```

```bash
aws logs tail "$(terraform output -raw item_processing_worker_log_group_name)" --follow
```

Key async events:

| Event                          | Meaning                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `item_created_dispatched`      | Dispatcher sent an item-created event to SQS                  |
| `item_created_dispatch_failed` | Dispatcher could not transform a record or send it to SQS     |
| `item_processing_completed`    | Worker completed metadata processing for an item              |
| `duplicate_event_ignored`      | Worker saw an event already processed for that item           |
| `item_processing_skipped`      | Item was deleted before the worker processed it               |
| `item_processing_failed`       | Worker could not process a message and returned a failure     |

Useful correlation fields include:

* `requestId`
* `eventId`
* `itemId`
* `messageId`
* `attempt`
* `failureCategory`
* `retryable`

## Queue and DLQ Inspection

Inspect the main queue:

```bash
aws sqs get-queue-attributes \
  --queue-url "$(terraform output -raw item_processing_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

Inspect the DLQ:

```bash
aws sqs get-queue-attributes \
  --queue-url "$(terraform output -raw item_processing_dlq_url)" \
  --attribute-names ApproximateNumberOfMessages
```

SQS queue counts are approximate and should not be treated as strict real-time counters.

## DLQ Investigation

Do not immediately redrive messages just because the DLQ is non-empty. First identify the failure category and root cause, then fix configuration, IAM, event-contract, runtime, or data-state issues before moving messages back to the main queue.

Do not delete DLQ messages before investigation. Receiving a message temporarily changes its visibility timeout, so use a short visibility timeout for inspection:

```bash
aws sqs receive-message \
  --queue-url "$(terraform output -raw item_processing_dlq_url)" \
  --max-number-of-messages 1 \
  --visibility-timeout 30 \
  --attribute-names All
```

Examples should not print real sensitive payloads. Demo events contain only item ID and name, but production operators should still handle message bodies carefully.

## DLQ Redrive

Only redrive after the root cause is understood and fixed. Retrieve the queue ARNs from Terraform outputs:

```bash
DLQ_ARN="$(terraform output -raw item_processing_dlq_arn)"
QUEUE_ARN="$(terraform output -raw item_processing_queue_arn)"
```

Start a move task:

```bash
aws sqs start-message-move-task \
  --source-arn "$DLQ_ARN" \
  --destination-arn "$QUEUE_ARN"
```

Redrive triggers the worker again. The worker's idempotent logic ignores the same event if it has already been successfully processed. Validate redrive behavior in a non-production environment first, then re-check the DLQ, worker logs, and item state after the move task runs.

## Async Failure Troubleshooting

| Symptom                             | Possible cause                                            | Checks                                                     |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Item remains `PENDING`              | Stream, dispatcher, IAM, SQS, or worker failure           | Check dispatcher logs, queue depth, worker logs, and IAM   |
| Dispatcher failure metric increases | Invalid stream record, configuration, or SQS send failure | Inspect `failureCategory` and dispatcher request logs      |
| Worker retryable failures increase  | Temporary DynamoDB or runtime dependency failure          | Check `retryable`, `attempt`, and DynamoDB service health  |
| Worker permanent failure increases  | Invalid event or conflicting stored state                 | Inspect the event ID, item ID, and stored processing state |
| `item_processing_skipped` increases | Item deleted before worker processed it                   | Confirm deletes are expected for the affected item IDs     |
| Queue age increases                 | Worker blocked, throttled, disabled, or failing           | Check worker throttles, errors, and queue visibility       |
| Iterator age increases              | Dispatcher cannot progress through a stream shard         | Check dispatcher failures and DynamoDB stream records      |
| DLQ contains messages               | Message failed repeatedly and needs investigation         | Inspect DLQ messages before any redrive                    |

## DynamoDB Stream Retry Semantics

The dispatcher event-source mapping uses `ReportBatchItemFailures`. DynamoDB Streams uses the lowest failed sequence number as the retry checkpoint. Records after that checkpoint may be delivered again even if they already succeeded, so the dispatcher may send the same event more than once.

The worker uses a stable `eventId` and conditional writes to keep item processing idempotent.

## Worker Concurrency

The Worker does not use reserved concurrency. The SQS event source mapping currently limits maximum concurrency to `2`.

This limits consumption for this event source without reserving account-wide Lambda capacity. See [AWS deployment validation](deployment-validation.md) for the partial Apply and recovery record.

## Known Stream Limitation

The DynamoDB Stream mapping currently has no finite retry count and no stream on-failure destination. A poison record that keeps failing can block its shard until the record expires. IteratorAge and dispatcher handled-failure alarms are the operational signals for this trade-off.

This first async version accepts that limitation to keep the service count small. Do not add a second failure queue unless the architecture is intentionally changed in a later phase.

## Async Alarm Interpretation

CloudWatch Lambda `Errors` measure failed invocations. Handled record failures emitted through `batchItemFailures` can occur while the Lambda invocation itself completes successfully, so they do not always increase Lambda `Errors`.

The async log-based metrics added for dispatcher and worker failures provide earlier application-level signals. Queue age and DLQ alarms are final protection signals and should not be the only early warning mechanism.

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

Create requires:

```text
TABLE_NAME
IDEMPOTENCY_TABLE_NAME
```

Get, update, and delete require:

```text
TABLE_NAME
```

Dispatcher requires:

```text
ITEM_PROCESSING_QUEUE_URL
```

Worker requires:

```text
TABLE_NAME
```

Terraform configures these values.

For CRUD handlers, missing configuration produces a safe HTTP `500` response.

For the Dispatcher or Worker, missing configuration is logged and the affected records are returned as batch failures for retry. Dispatcher configuration failures affect DynamoDB Stream batch processing. Worker configuration failures affect SQS batch processing. Neither async component returns an HTTP response.

Verify the Lambda environment configuration in Terraform and in the deployed function.

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
* [ADR 008: DynamoDB Streams and SQS item processing](adr/008-use-dynamodb-streams-and-sqs-for-item-processing.md)
