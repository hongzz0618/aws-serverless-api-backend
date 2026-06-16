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
  -d '{"name":"Laptop charger"}'
```

Expected result: `201 Created` with a JSON body containing `message` and `id`.

Read the item:

```bash
curl -X GET "<API_URL>/items/<ITEM_ID>"
```

Expected result: `200 OK` with the item fields.

Delete the item:

```bash
curl -X DELETE "<API_URL>/items/<ITEM_ID>"
```

Expected result: `200 OK` with the deleted item ID.

## Optional Smoke Test

The repository includes an optional post-deployment helper at `scripts/smoke-test.mjs`. It creates an item, reads it back, deletes it, and attempts cleanup if a later step fails.

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

## Relevant Alarms And Metrics

Terraform exposes configured alarm names:

```bash
cd terraform
terraform output cloudwatch_alarm_names
```

Relevant CloudWatch signals:

- Lambda `Errors` for create, get, and delete handlers.
- Lambda `Throttles` for each handler.
- API Gateway `4XXError` for validation, not-found, conflict, and other client-side responses.
- API Gateway `5XXError` for unexpected backend failures.
- API Gateway `Latency` for elevated request duration.
- DynamoDB `SystemErrors` across `PutItem`, `GetItem`, and `DeleteItem`.

Alarm actions are optional and controlled by the Terraform `alarm_actions` variable. Without actions, alarms still exist but do not notify anyone.

## Common Failure Scenarios

Invalid request body returns `400`:

- Check that `POST /items` sends valid JSON with a non-empty `name` string of 100 characters or fewer.
- The handler should not call DynamoDB for validation failures.

Missing item returns `404`:

- Check that the path uses a valid UUID.
- A valid UUID that is not present in DynamoDB returns `{"error":"Item not found"}`.

Duplicate item create returns `409`:

- Item creation uses a DynamoDB conditional write with `attribute_not_exists` on `id`.
- If DynamoDB reports `ConditionalCheckFailedException`, the API returns `{"error":"Item already exists"}`.

Unexpected DynamoDB or internal error returns safe `500`:

- Callers receive a generic error such as `{"error":"Failed to create item"}`, `{"error":"Failed to fetch item"}`, or `{"error":"Failed to delete item"}`.
- Check Lambda logs for the internal `errorName` and `errorMessage`.
- API Gateway `5XXError`, Lambda `Errors`, or DynamoDB `SystemErrors` may also show related signals.

Missing Lambda environment variables:

- Handlers require `TABLE_NAME`.
- Terraform sets `TABLE_NAME` for all three Lambda functions.
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
