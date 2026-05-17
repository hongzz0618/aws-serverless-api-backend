# 003. Add Validation, Structured Logs, and Basic Operability Controls

## Status

Accepted

## Context

The API is public and request-driven. Even in a portfolio project, it should show how backend behavior is validated, logged, and monitored without pretending to be production-complete.

## Decision

Add request validation in the Lambda application layer, structured JSON logging, API Gateway access logs, basic API throttling, and simple CloudWatch alarms.

## Rationale

Request validation with Zod keeps invalid input away from DynamoDB and gives callers predictable `400` responses. Structured logging makes Lambda behavior easier to inspect in CloudWatch and avoids relying on unstructured `console.log` output.

API Gateway access logs add request-level visibility across methods, status codes, source IPs, and integration failures without logging bodies or sensitive headers. Basic throttling reduces accidental request spikes and cost risk. CloudWatch alarms provide lightweight signals for Lambda errors, Lambda throttles, and API Gateway 5XX responses.

Benefits:

- Clearer failure behavior for invalid client input.
- Safer logs that avoid request bodies and sensitive headers.
- Better operational debugging across both Lambda and API Gateway.
- Basic monitoring signals without adding a full observability platform.

## Trade-Offs

- Validation adds schema maintenance work as request shapes evolve.
- Logs and alarms create small CloudWatch costs.
- The alarms are intentionally simple and do not replace dashboards, tracing, runbooks, or incident response.
- API throttling is a broad stage-level control, not per-user abuse prevention.

## Consequences

The project now demonstrates more mature operational thinking while staying small. Important gaps remain: authentication and authorization, WAF or stronger public abuse controls, multi-environment strategy, deployment smoke tests, dashboards, and deeper production readiness work.
