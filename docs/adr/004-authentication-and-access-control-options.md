# 004. Evaluate Authentication and Access-Control Options

## Status

Proposed

## Context

The current API Gateway methods use `authorization = "NONE"`. This is intentional for the current reference scope: it keeps the request path easy to inspect and lets the project focus on API Gateway, Lambda, DynamoDB, validation, logging, IAM boundaries, Terraform, and CI checks.

That choice also means a deployed API URL is publicly reachable. API Gateway throttling and Lambda input validation reduce some failure and cost risks, but they do not identify callers, prevent unwanted access, or provide per-user authorization.

## Risks

An unauthenticated public API can create several risks if it is left deployed or used outside a controlled demo account:

- Anyone with the URL can create, read, update, or delete item records.
- Automated clients can create unnecessary API Gateway, Lambda, DynamoDB, and CloudWatch cost.
- There is no caller identity for auditing or per-user access decisions.
- Stage-level throttling is shared across all callers and does not distinguish trusted from untrusted traffic.
- CORS, if added later, would only control browser behavior and would not provide authentication.

## Options Considered

### API Gateway usage plans and API keys

Usage plans and API keys can provide simple caller identification, quotas, and throttling controls for REST APIs.

Trade-offs:

- Simple to explain and useful for basic quota management.
- Helpful for demo clients, internal tools, or partner-style access where keys can be distributed safely.
- API keys are not strong user authentication and should not be treated as identity proof.
- Key rotation, distribution, and leakage handling add operational work.

### Cognito or JWT authorizer

A Cognito user pool authorizer or JWT authorizer can validate bearer tokens before invoking Lambda.

Trade-offs:

- Better fit when callers represent users or services with explicit identity.
- Keeps most authentication checks at the API Gateway layer.
- Supports a clearer path toward authorization decisions based on claims or groups.
- Adds identity-provider setup, token lifecycle handling, local testing complexity, and client integration work.

### IAM authorization

IAM authorization can require callers to sign requests with AWS credentials.

Trade-offs:

- Good fit for AWS-to-AWS service access, internal automation, or trusted backend clients.
- Uses AWS-native identity and policy controls.
- Not ergonomic for browser clients or public user-facing APIs.
- Requires careful credential management and signed-request tooling.

### Lambda authorizer

A Lambda authorizer can run custom authorization logic before the main handler is invoked.

Trade-offs:

- Flexible for custom token formats, tenant lookups, or policy decisions.
- Can centralize access-control logic outside the business handlers.
- Adds another Lambda function, cache behavior, failure modes, latency, and test surface.
- Easy to overuse when a managed authorizer would be simpler.

### WAF and rate limiting

AWS WAF, API Gateway throttling, and usage-plan quotas can reduce abuse and traffic spikes.

Trade-offs:

- Useful defense-in-depth for public endpoints.
- Helps with common unwanted traffic patterns and cost control.
- Does not authenticate users or authorize access to item records.
- Adds rule management, tuning, and monitoring work.

## Decision

Do not implement authentication in this batch. Keep the current API unauthenticated for the reference implementation, but document that it is suitable only for controlled demos and architecture review unless an access-control layer is added.

For a real environment, the recommended next step is to choose the access-control model based on the expected caller:

- For browser or user-facing clients, start with Cognito or a JWT authorizer.
- For AWS-internal service clients, consider IAM authorization.
- For simple controlled client demos, API keys and usage plans can add quota controls, but they should not be presented as strong authentication.
- For public exposure, combine the chosen authentication approach with abuse controls such as tighter throttling, usage plans, or WAF rules where appropriate.

## Consequences

The project remains small and easy to inspect, while making the security trade-off explicit. Future implementation should add authentication and access-control tests, update Terraform method authorization, document expected callers, and include a deployment validation step that confirms protected routes reject unauthenticated requests.
