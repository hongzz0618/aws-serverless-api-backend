# AWS Serverless API Backend

## Project Overview

This repository contains a basic Terraform-provisioned serverless CRUD API backend on AWS. It demonstrates how API Gateway, AWS Lambda with Node.js, and Amazon DynamoDB can be combined to expose a lightweight REST-style API without managing servers.

The project is intended as a cloud engineering portfolio project. It is not presented as a production-ready backend, but as a clear implementation of a common AWS serverless architecture pattern.

## Repository Context

This project is one of the linked projects in my AWS Architecture Portfolio. It focuses specifically on the serverless API backend pattern, separated from broader architecture examples so the infrastructure, Lambda handlers, diagram, and demo screenshots can be reviewed independently.

Portfolio hub:

[AWS Architecture Portfolio](https://github.com/hongzz0618/aws-architecture-portfolio)

## Problem This Architecture Solves

Many applications need a simple backend API for creating, reading, and deleting records without the operational overhead of managing virtual machines, containers, operating system patches, or database servers.

This architecture solves that problem by using managed AWS services:

- API Gateway receives HTTP requests.
- Lambda runs backend logic only when requested.
- DynamoDB stores item data using a serverless NoSQL model.
- Terraform defines the infrastructure as code.

## Real-World Use Case

This pattern is suitable for small APIs, prototypes, internal tools, mobile app backends, learning projects, and event-driven applications that need a simple persistence layer.

Example use cases include:

- A lightweight item-tracking API
- A backend for a mobile or web application
- A prototype CRUD service
- A small microservice with minimal infrastructure management

## Architecture Diagram

![AWS Serverless API Diagram](diagram/serverless-api-backend.png)

## Architecture Overview

The current implementation provisions:

- A DynamoDB table with `id` as the partition key
- Three Lambda functions written in TypeScript and compiled for Node.js Lambda
- API Gateway REST API resources and methods
- Lambda permissions allowing API Gateway to invoke the functions
- A `dev` API Gateway stage
- A Terraform output for the deployed API URL

## AWS Services Used

| Service | Purpose |
| --- | --- |
| Amazon API Gateway | Public HTTP entry point for API requests |
| AWS Lambda | Runs the backend logic for create, get, and delete operations |
| Amazon DynamoDB | Stores item records using a serverless NoSQL table |
| AWS IAM | Provides the Lambda execution role and service permissions |
| Amazon CloudWatch Logs | Receives Lambda logs through the basic Lambda execution role |
| Terraform | Provisions and manages the AWS infrastructure |

## Request Flow

The implemented request flow is:

```text
Client -> API Gateway -> Lambda -> DynamoDB -> Lambda -> API Gateway -> Client
```

1. A client sends an HTTP request to API Gateway.
2. API Gateway routes the request to the matching Lambda function.
3. The Lambda function reads from or writes to DynamoDB.
4. DynamoDB returns the operation result to Lambda.
5. Lambda returns an HTTP response payload.
6. API Gateway sends the response back to the client.

## Implemented Lambda Handlers

| File | Responsibility |
| --- | --- |
| `lambdas/createItem.ts` | Creates a new item with a generated UUID, `name`, and `createdAt` timestamp |
| `lambdas/getItem.ts` | Retrieves an item by `id` from DynamoDB |
| `lambdas/deleteItem.ts` | Deletes an item by `id` from DynamoDB |

## API Routes

The routes below are defined in `terraform/main.tf`:

| Method | Route | Lambda Handler | Description |
| --- | --- | --- | --- |
| `POST` | `/items` | `createItem.ts` | Creates a new item |
| `GET` | `/items/{id}` | `getItem.ts` | Retrieves an item by ID |
| `DELETE` | `/items/{id}` | `deleteItem.ts` | Deletes an item by ID |

The API is deployed to the `dev` stage.

The Lambda handlers include basic input validation and return JSON error responses for invalid requests or missing items.

## Example Requests

Replace `<API_URL>` with the Terraform output value, for example:

```text
https://example.execute-api.us-east-1.amazonaws.com/dev
```

Create an item:

```bash
curl -X POST "<API_URL>/items" \
  -H "Content-Type: application/json" \
  -d '{"name":"Example item"}'
```

Example create response:

```json
{
  "message": "Item created",
  "id": "generated-item-id"
}
```

Example invalid create response:

```json
{
  "error": "Name is required"
}
```

Get an item:

```bash
curl -X GET "<API_URL>/items/<ITEM_ID>"
```

Example missing item response:

```json
{
  "error": "Item not found"
}
```

Delete an item:

```bash
curl -X DELETE "<API_URL>/items/<ITEM_ID>"
```

## Terraform Structure

| File | Purpose |
| --- | --- |
| `terraform/main.tf` | Defines DynamoDB, IAM, Lambda functions, API Gateway routes, integrations, deployment, stage, and Lambda permissions |
| `terraform/provider.tf` | Configures the AWS provider region from Terraform variables |
| `terraform/variables.tf` | Declares `region` and `project_name` variables |
| `terraform/outputs.tf` | Outputs the API Gateway URL as `api_url` |
| `terraform/terraform.tfvars` | Provides default values for `project_name` and `region` |
| `terraform/versions.tf` | Defines Terraform and AWS provider version constraints |

## Deployment Guide

Prerequisites:

- AWS account and credentials configured locally
- Terraform `>= 1.5.0`
- Node.js/npm for installing Lambda dependencies

Package the Lambda functions from the repository root:

```bash
bash scripts/package-lambdas.sh
```

The packaging script installs dependencies, compiles the TypeScript handlers into `lambdas/dist/`, removes old Lambda zip files, and creates the zip files required by Terraform. Each zip contains the compiled handler JavaScript at the zip root so the Terraform Lambda handler names remain unchanged.
Windows users should run this script from WSL or Git Bash with `zip` available on `PATH`.

The Terraform configuration expects these zip files to exist in the `lambdas` directory:

- `lambdas/createItem.zip`
- `lambdas/getItem.zip`
- `lambdas/deleteItem.zip`

Run the packaging script before `terraform plan` or `terraform apply`.

Deploy the infrastructure:

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

After deployment, get the API URL:

```bash
terraform output api_url
```

Use that value as `<API_URL>` in the example requests.

## Demo Screenshots

These screenshots show the deployed API being exercised and the backend resources/results visible during testing.

![Demo Screenshot 1](images/demo1.png)
![Demo Screenshot 2](images/demo2.png)
![Demo Screenshot 3](images/demo3.png)

## Security Considerations

This project is intentionally simple and should be reviewed before being used beyond a demo environment.

Current security considerations:

- API Gateway methods currently use `authorization = "NONE"`.
- The API is publicly reachable when deployed unless additional controls are added.
- The Lambda execution role uses a least-privilege inline IAM policy scoped to the project DynamoDB table, allowing only `PutItem`, `GetItem`, and `DeleteItem`.
- Secrets should not be hardcoded in Terraform, Lambda code, or committed configuration files.
- Basic Lambda input validation is included, but stronger request validation should be added before exposing this pattern to real users.

## Observability

The Lambda execution role includes the AWS managed basic Lambda execution policy, which allows Lambda logs to be written to CloudWatch Logs. Lambda CloudWatch log groups are managed by Terraform with 7-day retention for cost control.

Useful observability areas for this architecture include:

- Lambda logs in CloudWatch Logs
- Lambda invocation count, errors, duration, and throttles
- API Gateway request count, latency, and error metrics
- DynamoDB read/write usage and throttling metrics
- Future CloudWatch alarms for API errors, Lambda errors, and throttles
- Possible AWS X-Ray tracing for request-level debugging

## Cost Considerations

This architecture uses managed, usage-based services, but deployed resources can still generate cost.

Cost drivers include:

- API Gateway request volume
- Lambda request count and execution duration
- DynamoDB read/write usage with on-demand billing
- CloudWatch log ingestion and 7-day retention
- Any additional observability or tracing added later

After testing, run `terraform destroy` to remove the deployed resources.

## Limitations

Current limitations:

- No API authentication or authorization
- No request schema validation
- Basic input validation in Lambda handlers only
- Basic error handling only
- No automated tests
- No CI/CD pipeline
- No Terraform remote state configuration
- No environment separation such as `dev`, `staging`, and `prod`
- Lambda packaging is automated with a Bash script, but it is not yet integrated into CI/CD.
- IAM access to DynamoDB has been scoped to the project table, but broader API security controls such as authentication and request validation are still not implemented.

## Future Improvements

Potential improvements:

- Add API authentication or authorization
- Add request validation at API Gateway or application level
- Further improve Lambda error handling and response consistency
- Add stronger input validation
- Add SQS and a dead-letter queue for asynchronous processing patterns
- Add CloudWatch alarms for operational signals
- Further refine IAM and API Gateway security controls as the project evolves
- Add a CI/CD pipeline
- Configure Terraform remote state
- Add environment separation
- Add automated tests for Lambda handlers
- Integrate Lambda packaging into CI/CD.

## Architecture Trade-offs

Compared with an ECS/Fargate backend:

- This serverless approach has less infrastructure to manage.
- It can be simpler for small APIs and event-driven workloads.
- ECS/Fargate may be better for long-running services, custom runtimes, or containerized workloads with more control.

Compared with an EC2-based backend:

- This approach avoids server provisioning, patching, and capacity planning.
- EC2 provides more operating system and networking control.
- EC2 may be more appropriate for legacy applications or workloads requiring persistent compute.

Compared with an RDS-based backend:

- DynamoDB is serverless and scales differently from relational databases.
- DynamoDB works well for key-value access patterns like this project's `id` lookup.
- RDS is better when the application needs relational queries, joins, transactions, or SQL-based reporting.

## Interview Talking Points

30-second explanation:

This project demonstrates a basic serverless CRUD API on AWS. API Gateway exposes HTTP routes, Lambda functions handle create, read, and delete operations, DynamoDB stores the data, and Terraform provisions the infrastructure.

2-minute explanation:

The API uses API Gateway as the public entry point and forwards requests to separate Node.js Lambda handlers. The create handler validates and writes a new item to DynamoDB using a generated UUID, the get handler reads an item by ID, and the delete handler removes an item by ID. Terraform defines the DynamoDB table, Lambda functions, IAM role, API Gateway resources, methods, integrations, deployment stage, and output URL. DynamoDB access has been improved with a least-privilege IAM policy scoped to the project table, while authentication, stronger validation, automated tests, and observability alarms remain future improvements before this pattern should be treated as production-ready.

Likely follow-up questions:

- Why use API Gateway and Lambda instead of ECS or EC2?
- How would you secure this API?
- How would you apply least privilege to the Lambda role?
- How would you add validation for incoming requests?
- How would you monitor errors, latency, and throttling?
- How would you separate dev, staging, and production environments?
- How would you automate packaging and deployment?
- When would DynamoDB be a better fit than RDS, and when would it not?

## CV Bullet Draft

- Built a Terraform-provisioned AWS serverless API backend using API Gateway, Node.js Lambda functions, and DynamoDB, including least-privilege DynamoDB IAM, automated Lambda packaging, documented CRUD routes, and security/observability considerations for a cloud engineering portfolio.

## Cleanup / Destroy Instructions

To remove the deployed AWS resources:

```bash
cd terraform
terraform destroy
```

Review the destroy plan before confirming. This helps avoid leaving API Gateway, Lambda, DynamoDB, IAM, and CloudWatch-related resources running after testing. After cleanup, check for any retained resources or CloudWatch log groups.
