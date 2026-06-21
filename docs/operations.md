# Operations Runbook

This runbook covers basic validation, troubleshooting, and cleanup for the serverless item API reference project.

## Validate After Deployment

After `terraform apply`, get the deployed API URL:

```bash
cd terraform
terraform output api_url
```

Use the output value as `<API_URL>`.

Create an item:

```bash
curl -X POST "<API_URL>/items" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: item-create:00000001" \
  -d '{"name":"Laptop charger"}'
```

Expected result: `201 Created` with a JSON body containing `message`, `id`, and `version: 1`.

Replay the same create request with the same key and body:

```bash
curl -i -X POST "<API_URL>/items" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: item-create:00000001" \
  -d '{"name":"Laptop charger"}'
```

Expected result: `201 Created`, the same item ID, and `Idempotency-Replayed: true`.

Reuse the same key with a different body:

```bash
curl -X POST "<API_URL>/items" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: item-create:00000001" \
  -d '{"name":"Different item"}'
```

Expected result: `409 Conflict` with `{"error":"Idempotency key was already used with a different request"}`.

Read the item:

```bash
curl -X GET "<API_URL>/items/<ITEM_ID>"
```

Expected result: `200 OK` with the item fields, including `version: 1`.

Update the item:

```bash
curl -X PUT "<API_URL>/items/<ITEM_ID>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Laptop charger - spare","version":1}'
```

Expected result: `200 OK` with the updated name and `version: 2`.

Repeat the update with stale version `1`:

```bash
curl -X PUT "<API_URL>/items/<ITEM_ID>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Stale update","version":1}'
```

Expected result: `409 Conflict` with `{"error":"Item version conflict"}`.

Delete the item:

```bash
curl -X DELETE "<API_URL>/items/<ITEM_ID>"
```

Expected result: `200 OK` with the deleted item ID.

Read the deleted item:

```bash
curl -X GET "<API_URL>/items/<ITEM_ID>"
```

Expected result: `404 Not Found` with `{"error":"Item not found"}`.

## Optional Smoke Test

The repository includes an optional post-deployment helper at `scripts/smoke-test.mjs`. It creates an item with an idempotency key, verifies exact replay, verifies same-key conflict, verifies the initial version, updates it, verifies the incremented version, checks that a stale update returns `409`, deletes the item, verifies a later read returns `404`, and attempts cleanup if a later step fails.

Run it from the `lambdas` directory with `API_URL` set to the Terraform output:

```bash
cd lambdas
API_URL="<API_URL>" npm run smoke:test
```

The smoke test is not part of the default GitHub Actions workflow because it requires a deployed API URL.

## Inspect CloudWatch Logs

Lambda handlers emit structured JSON logs. Terraform creates these Lambda log groups:

- `/aws/lambda/<project_name>-create`
- `/aws/lambda/<project_name>-get`
- `/aws/lambda/<project_name>-update`
- `/aws/lambda/<project_name>-delete`

API Gateway access logs are written to the log group exposed by Terraform:

```bash
cd terraform
terraform output api_access_log_group_name
```

Use the AWS console or AWS CLI to inspect recent events. If the AWS CLI is available, the API access log group can be tailed with:

```bash
aws logs tail "$(terraform output -raw api_access_log_group_name)" --follow
```

For Lambda logs, inspect the function-specific log group for the route being tested. Look for `requestId`, `route`, `operation`, `statusCode`, `errorName`, and `errorMessage` fields.

For idempotent create behavior, inspect the create Lambda log group for these stable event values:

- `idempotency_reserved`: a new key was reserved.
- `idempotency_replayed`: a completed key returned the stored original response.
- `idempotency_conflict`: a key was reused with a different validated payload.
- `idempotency_in_progress`: a concurrent request found an active reservation.
- `idempotency_failed`: idempotency storage, completion, or cleanup failed.

The logs include `idempotencyKeyHash`, a short correlation hash. They do not include the full idempotency key, request fingerprint, request body, or headers.

## Relevant Alarms And Metrics

Terraform exposes configured alarm names:

```bash
cd terraform
terraform output cloudwatch_alarm_names
```

Relevant CloudWatch signals:

- Lambda `Errors` for unhandled invocation or runtime failures in the create, get, update, and delete handlers.
- Custom handled-500 metrics for caught application failures where a handler logs `level: "error"` with `statusCode: 500` before returning a safe HTTP response.
- Custom idempotency metrics for create replay, conflict, and idempotency failure log events.
- Lambda `Throttles` for each handler.
- API Gateway `4XXError` for validation, not-found, conflict, and other client-side responses.
- API Gateway `5XXError` as the aggregate HTTP 5XX signal across all routes.
- API Gateway `Latency` for elevated request duration.
- DynamoDB `SystemErrors` across `PutItem`, `GetItem`, `UpdateItem`, and `DeleteItem`.

Replay and conflict counts are useful diagnostics but are not errors by themselves. Replay often means a client retried correctly. Conflict usually means client behavior needs review. Idempotency failure counts should be investigated because they indicate a storage or completion problem.

Alarm actions are optional and controlled by the Terraform `alarm_actions` variable. Without actions, alarms still exist but do not notify anyone.

## Common Failure Scenarios

Invalid request body returns `400`:

- Check that `POST /items` sends valid JSON with a non-empty `name` string of 100 characters or fewer.
- Check that `PUT /items/{id}` sends valid JSON with a valid `name` and a positive integer `version`.
- The handler should not call DynamoDB for validation failures.

Missing item returns `404`:

- Check that the path uses a valid UUID.
- A valid UUID that is not present in DynamoDB returns `{"error":"Item not found"}`.
- During an update, if the item is deleted after the initial read but before the conditional update completes, the handler performs a consistent follow-up read and returns `404`.

Missing or invalid idempotency key returns `400`:

- `POST /items` requires `Idempotency-Key`.
- The key must be 8 to 128 characters and use only letters, digits, hyphen, underscore, colon, or period.
- Header matching is case-insensitive, but clients should send `Idempotency-Key` for clarity.

Idempotent create replay returns `201`:

- Same key and same valid request body returns the original create response.
- The response includes `Idempotency-Replayed: true`.
- No second item should be created.

Idempotency key conflict returns `409`:

- Same key with a different valid request body returns `{"error":"Idempotency key was already used with a different request"}`.
- Check create Lambda logs for `event = "idempotency_conflict"` and the short `idempotencyKeyHash`.

Idempotency key in progress returns `409`:

- Same key and same valid request body can return `{"error":"Request with this idempotency key is already in progress"}` while the first request is still reserved.
- This should be temporary. Retry later with the same key and same body.

Stuck `IN_PROGRESS` idempotency records:

- The reservation uses a short application expiry and DynamoDB TTL.
- A later request can overwrite an expired `IN_PROGRESS` reservation.
- TTL deletion is not immediate, so a stale record may remain visible after expiration.
- Do not manually delete unknown records in an active environment unless the request is understood and no client can still be relying on that key.
- In the reference environment, teardown through `terraform destroy` removes the idempotency table with the rest of the stack.

Duplicate generated item ID returns `409`:

- Item creation uses a DynamoDB conditional write with `attribute_not_exists` on `id`.
- If DynamoDB reports `ConditionalCheckFailedException`, the API returns `{"error":"Item already exists"}`.

Stale update returns `409`:

- Item updates require the caller to submit the current item `version`.
- The update handler uses a DynamoDB conditional `UpdateItem` and increments the version after a successful update.
- If the item still exists but the submitted version is stale, the API returns `{"error":"Item version conflict"}`.

Unexpected DynamoDB or internal error returns safe `500`:

- Callers receive a generic error such as `{"error":"Failed to create item"}`, `{"error":"Failed to fetch item"}`, `{"error":"Failed to update item"}`, or `{"error":"Failed to delete item"}`.
- Update-specific `500` responses can come from the initial read, the conditional update, or the follow-up read used to distinguish stale versions from delete races.
- Check Lambda logs for the internal `errorName` and `errorMessage`.
- Custom handled-500 metrics identify which Lambda operation returned a caught application-level `500`.
- API Gateway `5XXError` shows the aggregate HTTP impact. Lambda `Errors` may remain unchanged for caught failures because the invocation completed successfully from the Lambda service perspective.

Missing Lambda environment variables:

- Handlers require `TABLE_NAME`.
- The create handler also requires `IDEMPOTENCY_TABLE_NAME`.
- Terraform sets `TABLE_NAME` for all four Lambda functions and `IDEMPOTENCY_TABLE_NAME` for the create function.
- If it is missing or changed manually, the API returns a safe `500`; Lambda logs include the missing environment variable error.

## Cleanup And Teardown

To remove deployed AWS resources:

```bash
cd terraform
terraform destroy
```

Review the destroy plan before confirming. After teardown, check for retained resources or CloudWatch log groups that may need manual review.

## Known Operational Limitations

- API Gateway routes are unauthenticated.
- There is no dashboard or log analytics layer.
- Alarm notifications require optional `alarm_actions`.
- There is no per-client throttling or usage plan.
- Terraform uses local state unless an operator configures a backend outside this repository.
- GitHub Actions validates and packages the project but does not deploy it.
- The smoke test is optional and is not run automatically in CI.
- Idempotency behavior and CloudWatch idempotency metrics still require a deployed API to validate end to end.
