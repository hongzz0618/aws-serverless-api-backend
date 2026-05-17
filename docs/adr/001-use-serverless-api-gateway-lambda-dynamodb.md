# 001. Use API Gateway, Lambda, and DynamoDB for the CRUD API

## Status

Accepted

## Context

This project needs a small HTTP backend for creating, reading, and deleting item records. The main goals are to demonstrate a realistic AWS serverless API shape, keep operations lightweight, and avoid managing servers or containers for a portfolio-sized CRUD workload.

## Decision

Use Amazon API Gateway as the public HTTP entry point, AWS Lambda for request handling, and DynamoDB as the managed persistence layer.

## Rationale

API Gateway and Lambda fit this API because each operation is short-lived, request-driven, and easy to model as an independent handler. The combination keeps infrastructure small while still showing important backend concerns such as routing, IAM, validation, logging, packaging, and infrastructure as code.

Benefits:

- Low operational overhead because there are no servers or containers to patch, scale, or supervise.
- Pay-per-use economics for low-to-moderate traffic and demo environments.
- Managed scaling across API Gateway, Lambda, and DynamoDB.
- Clear separation between HTTP routing, compute, and storage.

## Trade-Offs

- Lambda cold starts can affect tail latency.
- The design is tied to AWS-managed services and APIs.
- Lambda timeout and payload limits matter for larger workloads.
- A public API still needs authentication, authorization, throttling, and abuse controls before it can be treated as production-ready.

## Consequences

This is a good fit for a focused serverless backend demonstration, but it is intentionally not a full production platform. Future production work should prioritize authentication, environment separation, deployment safety, and stronger abuse protection.
