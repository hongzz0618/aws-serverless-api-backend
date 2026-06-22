# AWS Serverless API Backend

## Project Summary

This repository implements a small AWS serverless backend for managing inventory or asset records. It exposes a REST-style API through API Gateway, runs TypeScript Lambda handlers, stores records in DynamoDB, and provisions the cloud infrastructure with Terraform.

The project is designed as a cloud/backend engineering reference implementation: realistic enough to discuss architecture, validation, IAM, observability, CI, and trade-offs, while still intentionally scoped as a learning-oriented architecture lab rather than a complete service baseline.

## Real-World Use Case

The API can be viewed as the backend for a simple internal inventory or asset registry. A team could use this pattern to create, look up, and remove item records without operating servers, containers, or a relational database.

Example scenarios:

- Tracking lightweight internal assets by ID
- Supporting a small admin tool or internal dashboard
- Prototyping a serverless item-management workflow
- Demonstrating a DynamoDB key-value access pattern behind an HTTP API

## Architecture Diagram

![AWS Serverless API Diagram](diagram/serverless-api-backend.png)

## Architecture Overview

```text
Client
  -> API Gateway REST API
  -> Lambda handler
  -> DynamoDB table
  -> Lambda handler
  -> API Gateway response
  -> Client
```

| Component | Role in this project |
| --- | --- |
| API Gateway | Public HTTP entry point for `POST /items`, `GET /items/{id}`, `PUT /items/{id}`, and `DELETE /items/{id}` |
| AWS Lambda | Runs separate TypeScript handlers for create, read, update, and delete operations |
| DynamoDB | Stores versioned item records using `id` as the partition key, plus short-lived idempotency records for replay-safe creates |
| IAM | Allows API Gateway to invoke Lambda and scopes Lambda data access to the project DynamoDB tables |
| CloudWatch Logs | Receives structured Lambda logs and API Gateway access logs with configurable retention |
| CloudWatch Alarms | Provides basic alarms for Lambda errors/throttles, API Gateway 4XX/5XX responses, API latency, and DynamoDB system errors |
| Terraform | Defines the DynamoDB table, IAM role and policy, Lambda functions, API Gateway resources, deployment stage, operational settings, and output URL |
| GitHub Actions CI | Runs Lambda checks, packages deployment artifacts, and validates Terraform formatting/configuration |

## API Endpoints

The API is deployed to the `dev` API Gateway stage.

| Method | Route | Purpose | Success response |
| --- | --- | --- | --- |
| `POST` | `/items` | Create an item with a generated UUID, timestamp, and required idempotency key | `201 Created` |
| `GET` | `/items/{id}` | Fetch an item by UUID | `200 OK` |
| `PUT` | `/items/{id}` | Update an item using version-based optimistic locking | `200 OK` |
| `DELETE` | `/items/{id}` | Delete an item by UUID | `200 OK` |

## API Contract

The OpenAPI contract lives at `openapi/openapi.yaml` and describes the currently implemented API Gateway routes and Lambda handler behavior. It uses OpenAPI 3.0.3 for broad validator compatibility and stable JSON Schema handling.

The contract covers the four implemented routes, JSON request and response bodies, validation errors, idempotent create semantics, replay headers, and optimistic locking/version-conflict behavior. It intentionally does not define authentication, CORS, OPTIONS routes, generated SDKs, or endpoints that are not present in Terraform.

OpenAPI is a human-readable and CI-validated contract in this repository. API Gateway deployment is still defined by Terraform; the OpenAPI file is not imported by API Gateway and is not a deployment source of truth.

### Contract Validation

Run contract checks locally from `lambdas/`:

```bash
npm run contract:validate
npm run test:contract
```

`contract:validate` parses and validates the OpenAPI file, resolves `$ref` values, checks unique operation IDs, compares OpenAPI method/path pairs with the Terraform API Gateway methods, verifies key request/response contract details, and confirms CI runs the contract checks. `test:contract` exercises representative handler responses and validates them against the OpenAPI response schemas.

These checks do not require AWS credentials, a deployed API, or network access after dependencies are installed. Live AWS behavior still requires the optional post-deployment smoke test with an explicit `API_URL`.

## Lambda Artifact Assurance

The official Lambda packages are created by `scripts/package-lambdas.sh` and verified by `npm run artifacts:verify` from the `lambdas/` directory. The verification step checks the final ZIP files that Terraform references, not only TypeScript source or `dist/` output.

The verifier confirms that the packaged handler module and exported `handler` function can be loaded, runtime dependencies resolve from inside each extracted artifact, dev-only tooling is absent, and Terraform `filename`, `handler`, `runtime`, and `source_code_hash` wiring matches the generated ZIPs. It also writes a generated `lambdas/artifacts-manifest.json` containing SHA-256 checksums, sizes, handlers, runtimes, and file counts for the final artifacts. The manifest and ZIP files are generated build outputs and remain ignored by Git.

Artifact verification is an integrity check for CI-produced ZIP contents. It does not deploy the Lambda functions, invoke them in AWS, or prove live API behavior.

### Validation Behavior

Request validation is implemented in the Lambda application layer with Zod.

For `POST /items`:

- `Idempotency-Key` header is required.
- The key must be 8 to 128 characters.
- Allowed key characters are letters, digits, hyphen, underscore, colon, and period.
- Request body must be valid JSON.
- `name` is required.
- `name` must be a string.
- `name` is trimmed before storage.
- Empty or whitespace-only names are rejected.
- `name` must be 100 characters or fewer.

For `PUT /items/{id}`:

- `id` is required and must be a valid UUID.
- Request body must be valid JSON.
- `name` follows the same validation rules as `POST /items`.
- `version` is required.
- `version` must be a positive integer.

For `GET /items/{id}` and `DELETE /items/{id}`:

- `id` is required.
- `id` must be a valid UUID.

Invalid requests return `400` JSON error responses. Missing items return `404`. Stale update versions return `409`.

### Idempotent Create Behavior

`POST /items` requires callers to provide a client-generated `Idempotency-Key` header. The key is not inferred from the request body.

The create handler computes a stable fingerprint from the validated and normalized create request. For the current schema, the fingerprint includes the trimmed `name` value only.

Behavior:

- First request with a new key and valid body creates the item and returns `201 Created`.
- Replaying the same key with the same valid body returns the original `201 Created` response, including the same item ID, and adds `Idempotency-Replayed: true`.
- Reusing the same key with a different valid body returns `409 Conflict`.
- Reusing the same key while the first request is still in progress returns `409 Conflict`.
- Internal DynamoDB errors return safe `500` responses without exposing request fingerprints, table names, AWS request IDs, or stack traces.

The idempotency table keeps a short `IN_PROGRESS` lease for recovery and uses DynamoDB TTL only for asynchronous cleanup. Completed records are retained for a limited replay window. This supports retry-safe item creation within that window, but deployed behavior still needs validation against a real AWS API before stronger runtime claims are made.

## Example Requests

Replace `<API_URL>` with the Terraform output value:

```bash
terraform output api_url
```

Create an item:

```bash
curl -X POST "<API_URL>/items" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: item-create:00000001" \
  -d '{"name":"Laptop charger"}'
```

Example response:

```json
{
  "message": "Item created",
  "id": "00000000-0000-4000-8000-000000000001",
  "version": 1
}
```

Get an item:

```bash
curl -X GET "<API_URL>/items/<ITEM_ID>"
```

Update an item:

```bash
curl -X PUT "<API_URL>/items/<ITEM_ID>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Laptop charger - spare","version":1}'
```

Example response:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Laptop charger - spare",
  "createdAt": "2026-05-14T10:00:00.000Z",
  "version": 2
}
```

If another update has already changed the item version, the stale update returns `409 Conflict`:

```json
{
  "error": "Item version conflict"
}
```

Delete an item:

```bash
curl -X DELETE "<API_URL>/items/<ITEM_ID>"
```

## Engineering Quality Signals

This project includes several backend engineering practices beyond the minimum required to make a tutorial API work:

- TypeScript strict mode for Lambda handlers and shared utilities
- Shared utility modules for HTTP responses, environment variable handling, JSON parsing, logging, and validation
- Zod request validation for request bodies and path parameters
- Unit tests with Vitest for success paths, validation failures, not-found responses, and DynamoDB error handling
- DynamoDB conditional writes, idempotency-key handling for create, and version-based optimistic updates
- GitHub Actions CI for install, typecheck, tests, build, production dependency audit, Lambda packaging, Terraform formatting, and Terraform validation
- `npm audit --omit=dev` included in CI for production dependency vulnerability checks
- Structured JSON logging from Lambda handlers
- API Gateway access logging, CloudWatch method metrics, and basic throttling configured with Terraform
- CloudWatch alarms for common API, Lambda, and DynamoDB failure signals
- Terraform-managed AWS infrastructure instead of manual console setup
- Lambda deployment packages generated by `scripts/package-lambdas.sh`

## Security Considerations

This project intentionally keeps API security simple so the core serverless architecture is easy to inspect.

Current state:

- API Gateway methods currently use `authorization = "NONE"`.
- The deployed API is publicly reachable unless additional controls are added.
- API Gateway throttling is configured to reduce accidental abuse and cost risk, but it is not a substitute for authentication or WAF protections.
- Lambda invoke permissions are scoped to the API Gateway routes that call each function.
- Lambda DynamoDB permissions are scoped to the project tables and limited to the actions used by the handlers, including `TransactWriteItems` for idempotent create completion.
- Lambda log permissions are defined inline and scoped to the Terraform-managed Lambda log groups; API Gateway logging uses an explicit CloudWatch Logs action allowlist.
- GitHub Actions uses a read-only repository token, does not receive AWS credentials, and does not deploy infrastructure.
- Production dependencies are checked with `npm audit --omit=dev`; dev-only audit findings should be reviewed separately before broadening use.
- No secrets should be committed to the repository, Terraform files, Lambda source, or local configuration.

CORS and OPTIONS preflight handling are not configured in this reference implementation. The current examples assume direct API usage with tools such as curl or backend clients. Browser-based clients should add explicit CORS headers and OPTIONS routes with a specific allowed origin rather than using permissive defaults. CORS is not an authentication mechanism.

Before broader use, the API should add an authentication and authorization layer such as Amazon Cognito, a JWT authorizer, IAM authorization, or another identity-aware gateway pattern. Public APIs should also add abuse protection appropriate to the use case.

Authentication and access-control options are discussed in [ADR 004](docs/adr/004-authentication-and-access-control-options.md). Authentication is not implemented in this batch; the ADR documents the current risk and the likely next options.

## Observability

The Lambda handlers emit structured JSON logs to CloudWatch Logs. These logs are designed to be readable by humans and queryable by log tooling.

Logged fields include:

- Timestamp
- Log level
- Service name
- AWS request ID when Lambda context is available
- Route
- Operation name
- HTTP status code for completed outcomes
- Safe item ID values for item-level operations
- Short idempotency key correlation hashes for create retry diagnostics
- Error name for unexpected failures

The handlers do not log full request bodies, full idempotency keys, request fingerprints, arbitrary exception messages, or sensitive headers. That keeps potentially sensitive user-submitted data, such as item names, and internal resource details out of application logs.

API Gateway access logs are also enabled for the `dev` stage. They include request metadata such as request ID, source IP, HTTP method, resource path, status, response length, and integration error message when API Gateway provides one. They intentionally do not include request bodies, authorization headers, sensitive headers, or environment variables.

The API Gateway stage enables CloudWatch method metrics and uses basic throttling defaults of 20 requests per second with a burst limit of 40 requests. These values are intentionally modest for a demo project and can be adjusted with Terraform variables.

CloudWatch alarms are created by default for Lambda errors, Lambda throttles, API Gateway 4XX/5XX responses, API Gateway average latency, and DynamoDB system errors. These use conservative example thresholds for a small reference backend. The alarms do not require SNS setup; provide `alarm_actions` if notification actions should be attached.

The create handler also emits stable idempotency events for replay, conflict, in-progress, reservation, and failure paths. Terraform creates log metric filters for replay, conflict, and idempotency failure counts. Replay is expected retry behavior and is not alarmed by default. Conflict is usually client behavior and is also not alarmed by default.

Current observability gaps:

- No distributed tracing yet
- No dashboard yet
- No per-route or per-client alarm tuning yet
- No alarm notification destination unless `alarm_actions` is configured
- Idempotency metrics still require deployed CloudWatch log events to prove live matching

## Cost Awareness

The architecture uses a low-operational-overhead serverless model:

- API Gateway charges mainly by request volume.
- Lambda charges by invocation count and duration.
- DynamoDB is configured with on-demand billing.
- CloudWatch Logs can still create cost through ingestion and retention.
- API Gateway access logs add a small CloudWatch Logs ingestion and storage cost.
- CloudWatch alarms add a small monthly monitoring cost while enabled.
- API Gateway throttling helps reduce accidental request spikes and abuse-related cost risk.

Terraform configures Lambda and API Gateway access log groups with 7-day retention by default to reduce long-lived log storage cost. After demos or testing, run `terraform destroy` to avoid leaving AWS resources active.

## Deployment

Prerequisites:

- AWS account and credentials configured locally
- Terraform `>= 1.5.0`
- Node.js and npm
- Bash-compatible shell
- `zip` available on `PATH`

Install and validate Lambda code:

```bash
cd lambdas
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
cd ..
```

Package Lambda functions from the repository root:

```bash
bash scripts/package-lambdas.sh
```

The packaging script installs dependencies, compiles the TypeScript handlers, installs production dependencies for the packages, and creates the Lambda zip files expected by Terraform:

- `lambdas/createItem.zip`
- `lambdas/getItem.zip`
- `lambdas/updateItem.zip`
- `lambdas/deleteItem.zip`

Configure local Terraform variables:

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Then edit terraform.tfvars with local values.
```

Validate Terraform:

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

Deploy:

```bash
terraform apply
terraform output api_url
```

Use the `api_url` output as `<API_URL>` in the example requests.

### Optional Smoke Test

After deployment, the repository includes a small smoke test helper for the item lifecycle. It creates an item with an idempotency key, replays the same create request and verifies the same item ID, checks that the same key with a different payload returns `409`, verifies version `1`, updates it, verifies version `2`, checks that a stale update returns `409`, deletes the item, and confirms a later read returns `404`. It calls the deployed HTTP API directly and does not require AWS credentials.

Run it from the `lambdas` directory with `API_URL` set to the Terraform output value:

```bash
cd lambdas
API_URL="<API_URL>" npm run smoke:test
```

The smoke test is a post-deployment validation helper. It is not part of automatic deployment or the default GitHub Actions workflow because it requires a deployed API URL.

For deployment validation, logs, alarms, common failures, and cleanup notes, see the [operations runbook](docs/operations.md).

### Deployment Safety and State Strategy

GitHub Actions validates the Lambda code, packages deployment artifacts, and checks the Terraform configuration, but it does not automatically deploy to AWS. This is intentional for the current reference scope. Automatic deployment would need account-specific credentials, state management, approval rules, and rollback behavior that should be designed before being wired into CI.

The Terraform configuration currently uses local state unless the operator configures a backend outside this repository. Local state is simple for a single-machine demo, but it is not a good coordination model for shared environments because state can be lost, duplicated, or changed concurrently. A safer path would add a remote backend with locking, then split configuration by environment such as `dev`, `staging`, and `prod`.

Before broader use, deployment automation should add:

- Remote Terraform state with locking
- Separate variables and state per environment
- Manual approval before applying infrastructure changes
- Smoke tests against the deployed API URL after apply
- A rollback or recovery strategy for failed deployments
- Clear ownership for secrets, credentials, and AWS account boundaries

## CI Validation

GitHub Actions runs two jobs:

- Lambda checks: `npm ci`, `npm run typecheck`, `npm test`, OpenAPI contract checks, `npm run build`, `npm audit --omit=dev`, Lambda packaging, and artifact verification
- Terraform checks: artifact download, `terraform fmt -check -recursive`, `terraform init -backend=false`, and `terraform validate`

The CI workflow validates the application and infrastructure definitions, but it does not currently deploy to AWS.

## Repository Structure

| Path | Purpose |
| --- | --- |
| `lambdas/createItem.ts` | Lambda handler for `POST /items` |
| `lambdas/getItem.ts` | Lambda handler for `GET /items/{id}` |
| `lambdas/updateItem.ts` | Lambda handler for `PUT /items/{id}` |
| `lambdas/deleteItem.ts` | Lambda handler for `DELETE /items/{id}` |
| `lambdas/src/utils/` | Shared Lambda utilities |
| `lambdas/src/validation/` | Zod request validation |
| `lambdas/src/idempotency.ts` | Idempotency reservation, replay, conflict, and completion logic for `POST /items` |
| `lambdas/src/requestFingerprint.ts` | Stable request fingerprint and key-correlation hashing |
| `lambdas/__tests__/` | Vitest unit tests |
| `scripts/package-lambdas.sh` | Build and packaging script for Lambda zip artifacts |
| `scripts/smoke-test.mjs` | Optional post-deployment API smoke test |
| `terraform/` | Terraform configuration for AWS resources |
| `.github/workflows/ci.yml` | GitHub Actions CI workflow |
| `diagram/` | Architecture diagram source and rendered image |
| `images/` | Demo screenshots |

## Demo Screenshots

These screenshots show the deployed API being exercised and the backend resources/results visible during testing.

![Demo Screenshot 1](images/demo1.png)
![Demo Screenshot 2](images/demo2.png)
![Demo Screenshot 3](images/demo3.png)

## Limitations

This project is intentionally limited. The main limitations are:

- No authentication or authorization yet
- Basic API Gateway throttling is configured, but there is no per-client usage plan or API key strategy
- Basic API Gateway access logs are configured, but there is no dashboard or log analytics layer yet
- Basic CloudWatch alarms are configured, but notifications require optional `alarm_actions`
- No separate `dev`, `staging`, and `prod` environments
- No Terraform remote state backend
- No automated smoke tests against a deployed API in CI
- No CI/CD deployment pipeline
- Single-table DynamoDB design is intentionally simple and only supports lookup by `id`
- `POST /items` uses an idempotency table for replay-safe creates, but deployed runtime behavior and CloudWatch metric matching still need live validation
- Optimistic locking protects item updates from stale versions, but it is still a small single-item workflow rather than a complete domain concurrency model

## Architecture Trade-Offs

Why serverless for this project:

- Lower operational overhead than managing EC2 instances or containers
- Natural fit for low-to-moderate traffic APIs and internal tools
- Usage-based cost model for small workloads
- Clear separation between HTTP routing, compute, and persistence

Trade-offs:

- Cold starts and Lambda limits need to be considered for latency-sensitive workloads.
- API Gateway and Lambda behavior can be less transparent than a traditional long-running service.
- DynamoDB requires access-pattern-first data modeling and is not a drop-in replacement for relational querying.
- Broader use would need additional work around auth, throttling, monitoring, deployment safety, and environment separation.

## Architecture Decisions

Lightweight ADRs capture the main design choices and trade-offs behind this project:

- [001. Use API Gateway, Lambda, and DynamoDB for the serverless item API](docs/adr/001-use-serverless-api-gateway-lambda-dynamodb.md)
- [002. Use DynamoDB for Item Storage](docs/adr/002-use-dynamodb-for-item-storage.md)
- [003. Add Validation, Structured Logs, and Basic Operability Controls](docs/adr/003-operability-validation-and-observability.md)
- [004. Evaluate Authentication and Access-Control Options](docs/adr/004-authentication-and-access-control-options.md)
- [005. Use Conditional Writes for Item Creation](docs/adr/005-use-conditional-writes-for-item-creation.md)
- [006. Use Optimistic Locking for Item Updates](docs/adr/006-use-optimistic-locking-for-item-updates.md)
- [007. Use Idempotency Keys for Item Creation](docs/adr/007-use-idempotency-keys-for-item-creation.md)

## Architecture Discussion Notes

This project demonstrates:

- Serverless API design using API Gateway, Lambda, and DynamoDB
- Terraform infrastructure as code for a focused AWS backend reference
- DynamoDB key-value access using `id` as the primary lookup pattern
- DynamoDB conditional creates and conditional updates for no-overwrite and optimistic-locking behavior
- Idempotency-key handling for replay-safe create requests and retry ambiguity
- Input validation with Zod before calling DynamoDB
- CI quality gates for TypeScript, tests, builds, dependency audit, packaging, and Terraform validation
- Structured JSON logging for operational debugging
- Least-privilege thinking for Lambda access to DynamoDB
- Clear operational trade-offs rather than overstating readiness

Good discussion prompts:

- How would authentication be added with Cognito or JWT authorizers?
- Where should throttling, access logs, and alarms be configured?
- When would DynamoDB be a good fit, and when would RDS be better?
- How should stale updates, deleted records, and retry behavior be represented in an API contract?
- What failure windows remain when idempotency uses a reservation plus transaction model?
- How would the Terraform be split for multiple environments?
- What smoke tests would be valuable after deployment?
- How would CI evolve into safe deployment automation?

## Future Improvements

Priority improvements:

- Add Cognito, JWT authorizer, IAM auth, or another authorization layer
- Add API Gateway usage plans, API keys, or WAF if the API needs stronger public abuse controls
- Add CloudWatch dashboards and tune or expand alarm coverage, such as DynamoDB throttling or per-client API signals
- Introduce environment separation for `dev`, `staging`, and `prod`
- Add Terraform remote state and locking
- Expand ADR coverage for future design changes
- Wire the smoke test into a controlled post-deployment workflow
- Add a controlled deployment workflow after validation passes
- Validate idempotent create behavior and CloudWatch idempotency metrics in a deployed environment

## Cleanup

To remove deployed AWS resources:

```bash
cd terraform
terraform destroy
```

Review the destroy plan before confirming. After cleanup, check for any retained resources or CloudWatch log groups that may need manual review.

## Related Reference Hub

This repository is part of a broader AWS architecture reference hub and focuses specifically on the serverless API backend pattern.

Reference hub:

[AWS Architecture Labs](https://github.com/hongzz0618/aws-architecture-labs)
