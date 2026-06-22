# AWS Serverless API Backend

A TypeScript serverless API for managing simple inventory or asset records on AWS.

The project uses API Gateway, Lambda, DynamoDB, Terraform, and GitHub Actions. Its main focus is reliable request handling, explicit API contracts, retry-safe writes, concurrency control, observability, and infrastructure validation.

## Highlights

- Four REST-style endpoints implemented with TypeScript Lambda handlers
- Idempotency keys for retry-safe item creation
- Optimistic locking for concurrent item updates
- Zod request validation and consistent JSON error responses
- OpenAPI contract validation in CI
- Structured Lambda logs, API Gateway access logs, metrics, and alarms
- Terraform-managed infrastructure and scoped IAM permissions
- Reproducible Lambda packaging with final artifact verification
- Unit, contract, packaging, Terraform, and optional deployment smoke tests

## Architecture

![AWS Serverless API Diagram](diagram/serverless-api-backend.png)

| Component | Responsibility |
| --- | --- |
| API Gateway | Exposes the HTTP API and forwards requests to Lambda |
| Lambda | Runs separate TypeScript handlers for create, read, update, and delete |
| DynamoDB | Stores versioned items and short-lived idempotency records |
| IAM | Restricts API Gateway invocation and Lambda access to project resources |
| CloudWatch | Stores application/access logs, metrics, filters, and alarms |
| Terraform | Defines the AWS infrastructure and operational configuration |
| GitHub Actions | Validates, tests, packages, and checks the application and infrastructure |

## API

| Method | Route | Behavior |
| --- | --- | --- |
| `POST` | `/items` | Creates an item using a required `Idempotency-Key` |
| `GET` | `/items/{id}` | Retrieves an item by UUID |
| `PUT` | `/items/{id}` | Updates an item using version-based optimistic locking |
| `DELETE` | `/items/{id}` | Deletes an item by UUID |

The API is deployed to the `dev` API Gateway stage.

### Request behavior

`POST /items` requires a client-generated `Idempotency-Key`.

- A new key creates the item and returns `201 Created`.
- Replaying the same key and payload returns the original response.
- Reusing the key with another payload returns `409 Conflict`.
- Concurrent requests using an active reservation return `409 Conflict`.

`PUT /items/{id}` requires the current item version.

- A valid version updates the item and increments its version.
- A stale version returns `409 Conflict`.
- Missing items return `404 Not Found`.

Invalid request bodies, path parameters, and idempotency keys return `400 Bad Request`.

## API contract and validation

Request validation is implemented with Zod before data is sent to DynamoDB.

The OpenAPI 3.0.3 contract is stored at:

```text
openapi/openapi.yaml
````

CI checks that:

* The OpenAPI document is valid
* Operation IDs are unique
* Documented method and route pairs match Terraform
* Representative Lambda responses match the response schemas

The contract is documentation and a CI validation source. Terraform remains the deployment source for API Gateway.

Run the contract checks from `lambdas/`:

```bash
npm run contract:validate
npm run test:contract
```

## Idempotency and concurrency

Item creation uses a separate DynamoDB idempotency table.

The handler stores a stable request fingerprint, reserves the key before creating the item, and retains the completed response for a limited replay window. DynamoDB TTL is used for asynchronous record cleanup.

Item updates use DynamoDB conditional writes and an integer `version` field to reject stale updates.

The related decisions are documented in:

* [Conditional item creation](docs/adr/005-use-conditional-writes-for-item-creation.md)
* [Optimistic locking](docs/adr/006-use-optimistic-locking-for-item-updates.md)
* [Idempotency keys](docs/adr/007-use-idempotency-keys-for-item-creation.md)

## CI and artifact verification

GitHub Actions runs two main groups of checks:

**Application**

* Dependency installation
* TypeScript type checking
* Unit and contract tests
* Application build
* Production dependency audit
* Lambda packaging
* Final ZIP artifact verification

**Infrastructure**

* Packaged artifact download
* Terraform formatting
* Terraform initialization without a backend
* Terraform validation

The packaging script creates the Lambda ZIP files referenced by Terraform:

```bash
bash scripts/package-lambdas.sh
```

The verifier checks the final ZIP contents, exported handlers, runtime dependencies, and Terraform artifact wiring:

```bash
cd lambdas
npm run artifacts:verify
```

CI validates the repository but does not automatically deploy infrastructure to AWS.

## Deployment

### Prerequisites

* AWS account and local credentials
* Terraform `>= 1.5.0`
* Node.js and npm
* Bash-compatible shell
* `zip` available on `PATH`

### Validate the application

```bash
cd lambdas
npm ci
npm run typecheck
npm test
npm run contract:validate
npm run test:contract
npm run build
npm audit --omit=dev
cd ..
```

### Package and validate Terraform

```bash
bash scripts/package-lambdas.sh

cd lambdas
npm run artifacts:verify
cd ../terraform

cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with local values.

terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

### Deploy

```bash
terraform apply
terraform output -raw api_url
```

### Run the API smoke test

The smoke test exercises create, replay, conflict, read, update, stale update, delete, and not-found behavior against a deployed API.

```bash
cd ../lambdas
API_URL="<API_URL>" npm run smoke:test
```

For detailed validation, logs, alarms, failure scenarios, and cleanup guidance, see the [operations runbook](docs/operations.md).

## Observability and security

The Lambda handlers emit structured JSON logs without logging full request bodies, idempotency keys, request fingerprints, or sensitive headers.

Terraform also configures:

* API Gateway access logs
* Lambda and API Gateway metrics
* Basic API throttling
* Lambda error and throttle alarms
* API Gateway 4XX, 5XX, and latency alarms
* DynamoDB system-error alarms
* Log metric filters for idempotency replay, conflict, and failure events
* Configurable log retention and optional alarm actions

IAM permissions are restricted to the API routes, Lambda log groups, and DynamoDB tables used by this project. GitHub Actions uses a read-only repository token and does not receive AWS credentials.

The current API does not include authentication, authorization, CORS, or WAF protection. It should not be exposed for broader use without an identity and abuse-protection strategy.

Authentication options are discussed in [ADR 004](docs/adr/004-authentication-and-access-control-options.md).

## Deployment evidence

<details>
<summary>View deployment screenshots</summary>

### API request and stored DynamoDB item

![API request and DynamoDB item](images/demo1.png)

### API Gateway resources

![API Gateway resources](images/demo2.png)

### Additional deployment validation

![Additional deployment validation](images/demo3.png)

</details>

## Current limitations and trade-offs

* Authentication and authorization are not implemented
* Browser CORS and OPTIONS handling are not configured
* Terraform uses local state unless an external backend is configured
* There is no separate `dev`, `staging`, and `prod` environment structure
* CI validates and packages the project but does not deploy it
* Alarm notifications require optional `alarm_actions`
* There is no CloudWatch dashboard or distributed tracing
* DynamoDB access is intentionally limited to lookup by item ID
* Idempotency behavior and metric filters should be revalidated after future infrastructure or application changes

The serverless design reduces infrastructure management and fits small or irregular workloads. The trade-off is greater dependence on managed-service behavior, Lambda limits, API Gateway configuration, and access-pattern-driven DynamoDB modeling.

## Architecture decisions

<details>
<summary>View architecture decision records</summary>

* [001. Use API Gateway, Lambda, and DynamoDB](docs/adr/001-use-serverless-api-gateway-lambda-dynamodb.md)
* [002. Use DynamoDB for item storage](docs/adr/002-use-dynamodb-for-item-storage.md)
* [003. Add validation, structured logs, and operability controls](docs/adr/003-operability-validation-and-observability.md)
* [004. Evaluate authentication and access-control options](docs/adr/004-authentication-and-access-control-options.md)
* [005. Use conditional writes for item creation](docs/adr/005-use-conditional-writes-for-item-creation.md)
* [006. Use optimistic locking for item updates](docs/adr/006-use-optimistic-locking-for-item-updates.md)
* [007. Use idempotency keys for item creation](docs/adr/007-use-idempotency-keys-for-item-creation.md)

</details>

## Repository structure

| Path                 | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `lambdas/`           | TypeScript handlers, shared utilities, validation, and tests |
| `openapi/`           | OpenAPI contract                                             |
| `terraform/`         | AWS infrastructure definitions                               |
| `scripts/`           | Packaging and post-deployment smoke tests                    |
| `docs/adr/`          | Architecture decision records                                |
| `docs/operations.md` | Deployment validation and troubleshooting runbook            |
| `diagram/`           | Architecture diagram                                         |
| `images/`            | Deployment screenshots                                       |
| `.github/workflows/` | GitHub Actions CI                                            |

## Cleanup

To remove the deployed AWS resources:

```bash
cd terraform
terraform destroy
```

Review the destroy plan before confirming and check for any resources that may have been retained outside the Terraform state.

```
