# AWS Deployment Validation

## Validation summary

Two real AWS validation cycles were completed in `eu-west-1`.

| Cycle | Validated commit | Terraform-managed resources | Evidence |
| --- | --- | ---: | --- |
| Synchronous baseline | `c904ea2` | 58 | `01`-`05` |
| Async processing extension | `30f14d4` | 87 final state | `06`-`12` |

The async validation evidence records the final deployed Terraform state containing `87` managed resources. It does not mean all `87` resources were created by one uninterrupted Apply.

## Cycle 1 - Synchronous baseline

### Scope

The first validation cycle covered the original synchronous API in AWS region `eu-west-1` at commit `c904ea2`.

Terraform managed `58` resources for API Gateway, the CRUD Lambda functions, DynamoDB tables, IAM, CloudWatch Logs, metric filters, and CloudWatch alarms.

### Runtime scenarios

The deployed API was validated for:

- CRUD API behavior
- Idempotent create replay
- Idempotency conflict
- Optimistic locking
- Structured logs
- Original CloudWatch alarms

An IAM defect in the create Lambda DynamoDB policy was discovered during runtime validation. The policy was corrected, regression coverage was added, and the smoke test was rerun successfully.

### Evidence

Evidence `01`-`05` records the synchronous deployment summary, smoke test result, structured logs, CloudWatch alarms, and destroy completion.

### Teardown

Terraform destroy completed for the synchronous validation environment. The Terraform state resource count became zero after teardown.

## Cycle 2 - Async processing extension

### Deployment scope

The second validation cycle covered the async processing architecture at commit `30f14d4`:

```text
POST /items
-> Items DynamoDB Table with Streams
-> Dispatcher Lambda
-> SQS Standard Queue
-> Worker Lambda
-> conditional update to processingStatus = COMPLETED

Repeated failures
-> DLQ
-> investigation
-> redrive to main queue
```

The public API remained:

```text
POST /items
GET /items/{id}
PUT /items/{id}
DELETE /items/{id}
```

The final Terraform-managed state contained `87` resources in `eu-west-1`.

### Partial Apply and recovery

The first async Apply stopped when AWS rejected the Worker Lambda reserved-concurrency configuration.

Observed facts:

- AWS regional Lambda concurrency limit: `10`
- Original Worker reserved concurrency: `5`
- Terraform state contained `77` managed resources when the first Apply stopped
- The Worker Lambda existed, was `Active`, and had no reserved concurrency configured
- Terraform marked the Worker resource as tainted because resource creation did not complete cleanly

The repository removed Worker reserved concurrency. The SQS event source mapping kept `maximum_concurrency = 2`.

Before recovery, the live Lambda and Terraform state were inspected. The Worker was then untainted. The recovery plan was `10 add, 0 change, 0 destroy`, and the final Terraform-managed state contained `87` resources.

The engineering decision was to rely on SQS event-source maximum concurrency for this path. It limits consumption for this queue without reserving part of the account-wide Lambda concurrency pool.

This was an account-limit and Terraform recovery event, not an AWS outage or application-code failure.

### Happy-path processing

The async happy path was validated:

- `POST /items` returned `201`
- The item reached `processingStatus = COMPLETED`
- `processedEventId` matched `item.created.v1:<itemId>`
- `processedAt` existed
- `creationMetadata` was created

### Structured logs

Dispatcher and Worker logs were reviewed.

Observed application events included:

- `item_created_dispatched`
- `item_processing_completed`

### Duplicate-event idempotency

A duplicate event was delivered to the Worker.

The Worker emitted `duplicate_event_ignored`. Duplicate processing did not change `processedAt`, `processedEventId`, or `version`.

### Retry, DLQ, and alarm

Retryable DynamoDB failures were observed. After repeated failures, a message reached the DLQ.

The DLQ CloudWatch alarm reached `ALARM`.

### Configuration restoration and redrive

Worker configuration was restored. Terraform drift returned to zero.

DLQ redrive was started. The affected item recovered from `PENDING` to `COMPLETED`.

After processing completed, the main queue and DLQ became empty.

### Synchronous regression smoke test

The existing synchronous smoke test passed against the async deployment, confirming that the public CRUD API behavior still worked after the async extension was added.

### Teardown

Terraform destroyed the `87` managed resources. Terraform state became empty.

API Gateway, Lambda, DynamoDB, the main queue, and the DLQ were confirmed removed.

## Evidence

| File | Validation cycle | What it proves |
| --- | --- | --- |
| [`01-deployment-summary.png`](evidence/01-deployment-summary.png) | Synchronous baseline | Commit `c904ea2`, region `eu-west-1`, and `58` managed resources for the baseline deployment |
| [`02-smoke-test-pass.png`](evidence/02-smoke-test-pass.png) | Synchronous baseline | CRUD, idempotency replay, idempotency conflict, optimistic locking, and delete behavior passed after correction |
| [`03-structured-logs.png`](evidence/03-structured-logs.png) | Synchronous baseline | Structured application logs for idempotency and item creation behavior |
| [`04-cloudwatch-alarms.png`](evidence/04-cloudwatch-alarms.png) | Synchronous baseline | Original CloudWatch alarms were present and reviewed |
| [`05-destroy-complete.png`](evidence/05-destroy-complete.png) | Synchronous baseline | Baseline validation resources were destroyed and state became empty |
| [`06-async-deployment-summary.png`](evidence/06-async-deployment-summary.png) | Async processing extension | Commit `30f14d4`, region `eu-west-1`, and final deployed Terraform state containing `87` managed resources |
| [`07-async-processing-completed.png`](evidence/07-async-processing-completed.png) | Async processing extension | Created item reached `COMPLETED` with expected `processedEventId`, `processedAt`, and `creationMetadata` |
| [`08-async-structured-logs.png`](evidence/08-async-structured-logs.png) | Async processing extension | Dispatcher and Worker emitted expected structured events |
| [`09-duplicate-event-ignored.png`](evidence/09-duplicate-event-ignored.png) | Async processing extension | Duplicate event was ignored without changing `processedAt`, `processedEventId`, or `version` |
| [`10-async-dlq-alarm.png`](evidence/10-async-dlq-alarm.png) | Async processing extension | Retryable failures reached the DLQ and the DLQ alarm reached `ALARM` |
| [`11-async-redrive-recovery.png`](evidence/11-async-redrive-recovery.png) | Async processing extension | After restoration and redrive, the item recovered from `PENDING` to `COMPLETED` and queues emptied |
| [`12-async-destroy-complete.png`](evidence/12-async-destroy-complete.png) | Async processing extension | Async validation resources were destroyed, state became empty, and core resources were confirmed removed |

## Current environment status

The validation environment was destroyed.

The API and async queues are no longer publicly available.

## v1.0 Live AWS Validation Checklist

Pending post-travel validation in a fresh, disposable environment with synthetic data. Record new evidence with its own commit and Region.

- [ ] Review the Terraform plan with provider `5.100.0`. Confirm the disposable account, Region, regional API Gateway settings, mapping start position, and expected resource changes before deployment. Stop if the plan replaces an existing mapping or affects unrelated resources.
- [ ] Run the CRUD smoke test, including create replay and stale-version conflict. Create a separate item and verify the INSERT reaches SQS and the Worker completes processing.
- [ ] In the disposable deployment, induce a persistent Dispatcher send failure for a valid synthetic INSERT. Verify retry exhaustion, archive metadata, and the intact original Stream payload. Restore dispatch and check that subsequent records progress. In a separate controlled exercise, verify behavior when a record exceeds the one-hour age limit while it remains in the Stream.
- [ ] Briefly deny archive writes for a separate synthetic failure, then verify `DestinationDeliveryFailures` and the alarm state. Restore permission, confirm a subsequent failure can be archived, and resolve any missing payload while the Stream record is available. Check notification delivery if alarm actions are configured.
- [ ] Follow the [manual recovery procedure](operations.md#stream-failure-archive-and-recovery). Verify an empty `batchItemFailures` list and Worker completion. Replay the same archived record again and confirm `processedEventId`, `processedAt`, and public `version` remain stable.
- [ ] Exercise the existing Worker DLQ and redrive on a separate item. Verify that the DLQ holds the domain event and the item completes after restoring Worker access and redriving.
- [ ] Verify S3 public access blocking, ACL disabling, encryption, TLS policy, scoped Dispatcher permissions, and the 30-day lifecycle rule. Review costs for CloudWatch, S3, and test traffic. Keep raw payloads out of published evidence.
- [ ] Follow the [teardown procedure](operations.md#cleanup-and-teardown). Confirm mapping detachment or removal before disposing of approved archive contents. Verify that Terraform state and the disposable AWS resources are empty after cleanup.
