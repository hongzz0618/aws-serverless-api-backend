mock_provider "aws" {}

variables {
  region       = "us-east-1"
  project_name = "serverless-api"
}

override_resource {
  target = aws_api_gateway_rest_api.api


  values = {
    id               = "api123"
    root_resource_id = "root123"
    execution_arn    = "arn:aws:execute-api:us-east-1:123456789012:api123"
  }
}

override_resource {
  target          = aws_dynamodb_table.items
  override_during = plan


  values = {
    arn        = "arn:aws:dynamodb:us-east-1:123456789012:table/serverless-api-items"
    stream_arn = "arn:aws:dynamodb:us-east-1:123456789012:table/serverless-api-items/stream/2026-06-27T00:00:00.000"
  }
}

override_resource {
  target          = aws_dynamodb_table.idempotency
  override_during = plan


  values = {
    arn = "arn:aws:dynamodb:us-east-1:123456789012:table/serverless-api-idempotency"
  }
}

override_resource {
  target = aws_cloudwatch_log_group.create_item


  values = {
    arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/serverless-api-create"
  }
}

override_resource {
  target = aws_cloudwatch_log_group.get_item


  values = {
    arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/serverless-api-get"
  }
}

override_resource {
  target = aws_cloudwatch_log_group.update_item


  values = {
    arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/serverless-api-update"
  }
}

override_resource {
  target = aws_cloudwatch_log_group.delete_item


  values = {
    arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/serverless-api-delete"
  }
}

override_resource {
  target          = aws_cloudwatch_log_group.item_created_dispatcher
  override_during = plan


  values = {
    arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/serverless-api-item-created-dispatcher"
  }
}

override_resource {
  target          = aws_cloudwatch_log_group.item_processing_worker
  override_during = plan


  values = {
    arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/serverless-api-item-processing-worker"
  }
}

override_resource {
  target          = aws_sqs_queue.item_processing
  override_during = plan


  values = {
    arn  = "arn:aws:sqs:us-east-1:123456789012:serverless-api-item-processing"
    id   = "https://sqs.us-east-1.amazonaws.com/123456789012/serverless-api-item-processing"
    name = "serverless-api-item-processing"
    url  = "https://sqs.us-east-1.amazonaws.com/123456789012/serverless-api-item-processing"
  }
}

override_resource {
  target          = aws_sqs_queue.item_processing_dlq
  override_during = plan


  values = {
    arn  = "arn:aws:sqs:us-east-1:123456789012:serverless-api-item-processing-dlq"
    id   = "https://sqs.us-east-1.amazonaws.com/123456789012/serverless-api-item-processing-dlq"
    name = "serverless-api-item-processing-dlq"
  }
}

override_resource {
  target          = aws_lambda_function.item_created_dispatcher
  override_during = plan


  values = {
    arn           = "arn:aws:lambda:us-east-1:123456789012:function:serverless-api-item-created-dispatcher"
    function_name = "serverless-api-item-created-dispatcher"
  }
}

override_resource {
  target          = aws_lambda_function.item_processing_worker
  override_during = plan


  values = {
    arn           = "arn:aws:lambda:us-east-1:123456789012:function:serverless-api-item-processing-worker"
    function_name = "serverless-api-item-processing-worker"
  }
}

run "dynamodb_contract" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.items.billing_mode == "PAY_PER_REQUEST"
    error_message = "The items table must use on-demand billing."
  }

  assert {
    condition     = aws_dynamodb_table.items.hash_key == "id"
    error_message = "The items table hash key must be id."
  }

  assert {
    condition     = aws_dynamodb_table.idempotency.hash_key == "idempotencyKey"
    error_message = "The idempotency table hash key must be idempotencyKey."
  }

  assert {
    condition     = aws_dynamodb_table.idempotency.ttl[0].enabled == true && aws_dynamodb_table.idempotency.ttl[0].attribute_name == "expiresAt"
    error_message = "The idempotency table must enable TTL on expiresAt."
  }

  assert {
    condition     = aws_dynamodb_table.idempotency.server_side_encryption[0].enabled == true
    error_message = "The idempotency table must enable server-side encryption."
  }
}

run "lambda_contract" {
  command = plan

  assert {
    condition = alltrue([
      aws_lambda_function.create_item.runtime == "nodejs22.x",
      aws_lambda_function.get_item.runtime == "nodejs22.x",
      aws_lambda_function.update_item.runtime == "nodejs22.x",
      aws_lambda_function.delete_item.runtime == "nodejs22.x"
    ])
    error_message = "All Lambda functions must use Node.js 22."
  }

  assert {
    condition = {
      create = aws_lambda_function.create_item.handler
      get    = aws_lambda_function.get_item.handler
      update = aws_lambda_function.update_item.handler
      delete = aws_lambda_function.delete_item.handler
      } == {
      create = "createItem.handler"
      get    = "getItem.handler"
      update = "updateItem.handler"
      delete = "deleteItem.handler"
    }
    error_message = "Lambda handlers must point to the expected files."
  }

  assert {
    condition = alltrue([
      aws_lambda_function.create_item.memory_size == 128,
      aws_lambda_function.get_item.memory_size == 128,
      aws_lambda_function.update_item.memory_size == 128,
      aws_lambda_function.delete_item.memory_size == 128,
      aws_lambda_function.create_item.timeout == 10,
      aws_lambda_function.get_item.timeout == 10,
      aws_lambda_function.update_item.timeout == 10,
      aws_lambda_function.delete_item.timeout == 10
    ])
    error_message = "Lambda memory and timeout values must remain explicit."
  }

  assert {
    condition = alltrue([
      length(aws_lambda_function.create_item.source_code_hash) > 0,
      length(aws_lambda_function.get_item.source_code_hash) > 0,
      length(aws_lambda_function.update_item.source_code_hash) > 0,
      length(aws_lambda_function.delete_item.source_code_hash) > 0
    ])
    error_message = "Lambda artifacts must use source_code_hash."
  }

  assert {
    condition = (
      aws_lambda_function.create_item.environment[0].variables["TABLE_NAME"] == aws_dynamodb_table.items.name &&
      aws_lambda_function.create_item.environment[0].variables["IDEMPOTENCY_TABLE_NAME"] == aws_dynamodb_table.idempotency.name &&
      aws_lambda_function.get_item.environment[0].variables["TABLE_NAME"] == aws_dynamodb_table.items.name &&
      aws_lambda_function.update_item.environment[0].variables["TABLE_NAME"] == aws_dynamodb_table.items.name &&
      aws_lambda_function.delete_item.environment[0].variables["TABLE_NAME"] == aws_dynamodb_table.items.name
    )
    error_message = "Lambda environment variables must connect to the expected DynamoDB tables."
  }
}

run "api_gateway_contract" {
  command = plan

  assert {
    condition = {
      post   = aws_api_gateway_method.post_items.http_method
      get    = aws_api_gateway_method.get_item.http_method
      put    = aws_api_gateway_method.put_item.http_method
      delete = aws_api_gateway_method.delete_item.http_method
      } == {
      post   = "POST"
      get    = "GET"
      put    = "PUT"
      delete = "DELETE"
    }
    error_message = "The API must keep the four expected HTTP methods."
  }

  assert {
    condition     = aws_api_gateway_resource.items.path_part == "items" && aws_api_gateway_resource.item.path_part == "{id}"
    error_message = "The API resources must keep /items and /items/{id} routes."
  }

  assert {
    condition = alltrue([
      aws_api_gateway_method.post_items.authorization == "NONE",
      aws_api_gateway_method.get_item.authorization == "NONE",
      aws_api_gateway_method.put_item.authorization == "NONE",
      aws_api_gateway_method.delete_item.authorization == "NONE"
    ])
    error_message = "Current API Gateway methods must remain explicitly unauthenticated."
  }

  assert {
    condition = alltrue([
      aws_lambda_permission.apigw_create.action == "lambda:InvokeFunction",
      aws_lambda_permission.apigw_get.action == "lambda:InvokeFunction",
      aws_lambda_permission.apigw_update.action == "lambda:InvokeFunction",
      aws_lambda_permission.apigw_delete.action == "lambda:InvokeFunction",
      aws_lambda_permission.apigw_create.principal == "apigateway.amazonaws.com",
      aws_lambda_permission.apigw_get.principal == "apigateway.amazonaws.com",
      aws_lambda_permission.apigw_update.principal == "apigateway.amazonaws.com",
      aws_lambda_permission.apigw_delete.principal == "apigateway.amazonaws.com",
      aws_lambda_permission.apigw_create.statement_id == "AllowAPIGatewayInvokeCreate",
      aws_lambda_permission.apigw_get.statement_id == "AllowAPIGatewayInvokeGet",
      aws_lambda_permission.apigw_update.statement_id == "AllowAPIGatewayInvokeUpdate",
      aws_lambda_permission.apigw_delete.statement_id == "AllowAPIGatewayInvokeDelete"
    ])
    error_message = "Lambda invoke permissions must be present for API Gateway and attached to the expected functions."
  }

  assert {
    condition     = length(aws_api_gateway_stage.dev.access_log_settings) == 1
    error_message = "API Gateway access logs must be enabled."
  }

  assert {
    condition     = aws_api_gateway_method_settings.dev_all.settings[0].data_trace_enabled == false
    error_message = "API Gateway data trace logging must remain disabled."
  }

  assert {
    condition     = aws_api_gateway_method_settings.dev_all.settings[0].throttling_rate_limit == var.api_throttle_rate_limit && aws_api_gateway_method_settings.dev_all.settings[0].throttling_burst_limit == var.api_throttle_burst_limit
    error_message = "API Gateway throttling settings must be wired from variables."
  }

  assert {
    condition     = aws_api_gateway_account.account.reset_on_delete == true
    error_message = "API Gateway account settings must be reset during Terraform destroy."
  }
}

run "iam_contract" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.lambda_exec.assume_role_policy).Statement[0].Principal.Service == "lambda.amazonaws.com"
    error_message = "The Lambda execution role must be assumable only by Lambda."
  }

  assert {
    condition     = aws_iam_role_policy.lambda_dynamodb_items.name == "${var.project_name}-lambda-dynamodb-items"
    error_message = "The Lambda DynamoDB permissions must remain in the dedicated inline policy."
  }

  assert {
    condition     = contains(one([for statement in jsondecode(aws_iam_role_policy.lambda_dynamodb_items.policy).Statement : statement if statement.Resource == aws_dynamodb_table.items.arn]).Action, "dynamodb:PutItem")
    error_message = "The Lambda DynamoDB permissions must allow PutItem on the items table."
  }

  assert {
    condition     = contains(one([for statement in jsondecode(aws_iam_role_policy.lambda_dynamodb_items.policy).Statement : statement if statement.Resource == aws_dynamodb_table.idempotency.arn]).Action, "dynamodb:UpdateItem")
    error_message = "The Lambda DynamoDB permissions must allow UpdateItem on the idempotency table."
  }

  assert {
    condition     = alltrue([for statement in jsondecode(aws_iam_role_policy.lambda_dynamodb_items.policy).Statement : !contains(statement.Action, "dynamodb:TransactWriteItems")])
    error_message = "The Lambda DynamoDB permissions must not use TransactWriteItems as the transaction permission."
  }

  assert {
    condition     = length([for statement in jsondecode(aws_iam_role_policy.lambda_dynamodb_items.policy).Statement : statement if statement.Resource == aws_dynamodb_table.items.arn]) == 1 && length([for statement in jsondecode(aws_iam_role_policy.lambda_dynamodb_items.policy).Statement : statement if statement.Resource == aws_dynamodb_table.idempotency.arn]) == 1
    error_message = "The Lambda DynamoDB permissions must remain scoped to the items and idempotency table ARNs."
  }

  assert {
    condition     = aws_iam_role_policy.lambda_logs.name == "${var.project_name}-lambda-logs"
    error_message = "The Lambda logging permissions must remain in the dedicated inline policy."
  }
}

run "async_dynamodb_stream_contract" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.items.stream_enabled == true
    error_message = "The items table must enable DynamoDB Streams."
  }

  assert {
    condition     = aws_dynamodb_table.items.stream_view_type == "NEW_IMAGE"
    error_message = "The items table stream must publish NEW_IMAGE records only."
  }
}

run "async_queue_contract" {
  command = plan

  assert {
    condition     = aws_sqs_queue.item_processing.fifo_queue == false
    error_message = "The item processing queue must be a standard queue, not FIFO."
  }

  assert {
    condition     = aws_sqs_queue.item_processing.visibility_timeout_seconds == 60
    error_message = "The item processing queue visibility timeout must be 60 seconds."
  }

  assert {
    condition     = aws_sqs_queue.item_processing.visibility_timeout_seconds >= aws_lambda_function.item_processing_worker.timeout * 6
    error_message = "The item processing queue visibility timeout must be at least six times the worker timeout."
  }

  assert {
    condition     = aws_sqs_queue.item_processing.message_retention_seconds == 345600
    error_message = "The item processing queue must retain messages for 4 days."
  }

  assert {
    condition     = aws_sqs_queue.item_processing.sqs_managed_sse_enabled == true && aws_sqs_queue.item_processing_dlq.sqs_managed_sse_enabled == true
    error_message = "Both item processing queues must use SQS managed server-side encryption."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.item_processing.redrive_policy).deadLetterTargetArn == aws_sqs_queue.item_processing_dlq.arn
    error_message = "The item processing queue must redrive to the processing DLQ."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.item_processing.redrive_policy).maxReceiveCount == 5
    error_message = "The item processing queue maxReceiveCount must be 5."
  }

  assert {
    condition     = aws_sqs_queue.item_processing_dlq.message_retention_seconds == 1209600
    error_message = "The item processing DLQ must retain messages for 14 days."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue_redrive_allow_policy.item_processing_dlq.redrive_allow_policy).redrivePermission == "byQueue"
    error_message = "The item processing DLQ redrive allow policy must allow only named source queues."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue_redrive_allow_policy.item_processing_dlq.redrive_allow_policy).sourceQueueArns == [aws_sqs_queue.item_processing.arn]
    error_message = "The item processing DLQ must allow redrive only from the main item processing queue."
  }
}

run "async_lambda_contract" {
  command = plan

  assert {
    condition = alltrue([
      aws_lambda_function.item_created_dispatcher.runtime == "nodejs22.x",
      aws_lambda_function.item_processing_worker.runtime == "nodejs22.x"
    ])
    error_message = "Async Lambda functions must use Node.js 22."
  }

  assert {
    condition = {
      dispatcher = aws_lambda_function.item_created_dispatcher.handler
      worker     = aws_lambda_function.item_processing_worker.handler
      } == {
      dispatcher = "dispatchItemCreated.handler"
      worker     = "processItemCreated.handler"
    }
    error_message = "Async Lambda handlers must point to the expected placeholder files."
  }

  assert {
    condition = alltrue([
      aws_lambda_function.item_created_dispatcher.memory_size == 128,
      aws_lambda_function.item_processing_worker.memory_size == 128,
      aws_lambda_function.item_created_dispatcher.timeout == 10,
      aws_lambda_function.item_processing_worker.timeout == 10
    ])
    error_message = "Async Lambda memory and timeout values must remain explicit."
  }

  assert {
    condition     = aws_lambda_function.item_processing_worker.reserved_concurrent_executions == 5
    error_message = "The item processing worker must reserve concurrency at 5."
  }

  assert {
    condition = alltrue([
      aws_lambda_function.item_created_dispatcher.filename == "${path.module}/../lambdas/dispatchItemCreated.zip",
      aws_lambda_function.item_processing_worker.filename == "${path.module}/../lambdas/processItemCreated.zip",
      length(aws_lambda_function.item_created_dispatcher.source_code_hash) > 0,
      length(aws_lambda_function.item_processing_worker.source_code_hash) > 0
    ])
    error_message = "Async Lambda artifacts must use the expected ZIP paths and source_code_hash."
  }

  assert {
    condition = (
      aws_lambda_function.item_created_dispatcher.environment[0].variables["ITEM_PROCESSING_QUEUE_URL"] == aws_sqs_queue.item_processing.url &&
      aws_lambda_function.item_processing_worker.environment[0].variables["TABLE_NAME"] == aws_dynamodb_table.items.name
    )
    error_message = "Async Lambda environment variables must connect to the expected resources."
  }
}

run "async_iam_contract" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.item_created_dispatcher.assume_role_policy).Statement[0].Principal.Service == "lambda.amazonaws.com"
    error_message = "The dispatcher role must be assumable only by Lambda."
  }

  assert {
    condition     = jsondecode(aws_iam_role.item_processing_worker.assume_role_policy).Statement[0].Principal.Service == "lambda.amazonaws.com"
    error_message = "The worker role must be assumable only by Lambda."
  }

  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.item_created_dispatcher.policy).Statement : statement if statement.Resource == aws_sqs_queue.item_processing.arn]).Action == ["sqs:SendMessage"]
    error_message = "The dispatcher must only send messages to the main processing queue."
  }

  assert {
    condition = alltrue([
      for action in [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:ListStreams"
      ] : contains(one([for statement in jsondecode(aws_iam_role_policy.item_created_dispatcher.policy).Statement : statement if statement.Resource == aws_dynamodb_table.items.stream_arn]).Action, action)
    ])
    error_message = "The dispatcher must have the required DynamoDB stream polling permissions."
  }

  assert {
    condition     = !contains(flatten([for statement in jsondecode(aws_iam_role_policy.item_created_dispatcher.policy).Statement : statement.Action]), "dynamodb:UpdateItem")
    error_message = "The dispatcher must not update the items table."
  }

  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.item_created_dispatcher.policy).Statement : statement if statement.Resource == "${aws_cloudwatch_log_group.item_created_dispatcher.arn}:*"]).Action == ["logs:CreateLogStream", "logs:PutLogEvents"]
    error_message = "The dispatcher logging permissions must be scoped to its log group streams."
  }

  assert {
    condition = alltrue([
      for action in [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ] : contains(one([for statement in jsondecode(aws_iam_role_policy.item_processing_worker.policy).Statement : statement if statement.Resource == aws_sqs_queue.item_processing.arn]).Action, action)
    ])
    error_message = "The worker must only consume from the main processing queue."
  }

  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.item_processing_worker.policy).Statement : statement if statement.Resource == aws_dynamodb_table.items.arn]).Action == ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    error_message = "The worker DynamoDB permissions must be limited to GetItem and UpdateItem on the items table."
  }

  assert {
    condition     = alltrue([for statement in jsondecode(aws_iam_role_policy.item_processing_worker.policy).Statement : statement.Resource != aws_dynamodb_table.idempotency.arn])
    error_message = "The worker must not access the idempotency table."
  }

  assert {
    condition     = !contains(flatten([for statement in jsondecode(aws_iam_role_policy.item_processing_worker.policy).Statement : statement.Action]), "sqs:SendMessage")
    error_message = "The worker must not send SQS messages."
  }

  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.item_processing_worker.policy).Statement : statement if statement.Resource == "${aws_cloudwatch_log_group.item_processing_worker.arn}:*"]).Action == ["logs:CreateLogStream", "logs:PutLogEvents"]
    error_message = "The worker logging permissions must be scoped to its log group streams."
  }
}

run "async_event_source_mapping_contract" {
  command = plan

  assert {
    condition = (
      aws_lambda_event_source_mapping.item_created_dispatcher.event_source_arn == aws_dynamodb_table.items.stream_arn &&
      aws_lambda_event_source_mapping.item_created_dispatcher.function_name == aws_lambda_function.item_created_dispatcher.arn
    )
    error_message = "The dispatcher event source mapping must connect the items stream to the dispatcher Lambda."
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.item_created_dispatcher.enabled == true &&
      aws_lambda_event_source_mapping.item_created_dispatcher.starting_position == "LATEST" &&
      aws_lambda_event_source_mapping.item_created_dispatcher.batch_size == 10 &&
      aws_lambda_event_source_mapping.item_created_dispatcher.bisect_batch_on_function_error == true &&
      length(aws_lambda_event_source_mapping.item_created_dispatcher.function_response_types) == 1 &&
      contains(aws_lambda_event_source_mapping.item_created_dispatcher.function_response_types, "ReportBatchItemFailures")
    )
    error_message = "The dispatcher event source mapping must be enabled and configured for safe partial batch retries."
  }

  assert {
    condition     = jsondecode(one(aws_lambda_event_source_mapping.item_created_dispatcher.filter_criteria[0].filter).pattern).eventName == ["INSERT"]
    error_message = "The dispatcher event source mapping must filter to INSERT stream records only."
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.item_processing_worker.event_source_arn == aws_sqs_queue.item_processing.arn &&
      aws_lambda_event_source_mapping.item_processing_worker.function_name == aws_lambda_function.item_processing_worker.arn
    )
    error_message = "The worker event source mapping must connect the main queue to the worker Lambda."
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.item_processing_worker.enabled == true &&
      aws_lambda_event_source_mapping.item_processing_worker.batch_size == 5 &&
      length(aws_lambda_event_source_mapping.item_processing_worker.function_response_types) == 1 &&
      contains(aws_lambda_event_source_mapping.item_processing_worker.function_response_types, "ReportBatchItemFailures") &&
      aws_lambda_event_source_mapping.item_processing_worker.scaling_config[0].maximum_concurrency == 2
    )
    error_message = "The worker event source mapping must be enabled, partial-batch aware, and concurrency-limited."
  }
}

run "async_alarm_contract" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.item_processing_dlq_visible_messages[0].namespace == "AWS/SQS" &&
      aws_cloudwatch_metric_alarm.item_processing_dlq_visible_messages[0].metric_name == "ApproximateNumberOfMessagesVisible" &&
      aws_cloudwatch_metric_alarm.item_processing_dlq_visible_messages[0].threshold == 1
    )
    error_message = "The DLQ visible messages alarm must fire when at least one message is visible."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.item_processing_queue_age[0].namespace == "AWS/SQS" &&
      aws_cloudwatch_metric_alarm.item_processing_queue_age[0].metric_name == "ApproximateAgeOfOldestMessage" &&
      aws_cloudwatch_metric_alarm.item_processing_queue_age[0].threshold == 300
    )
    error_message = "The main queue age alarm must watch for messages older than 5 minutes."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.item_created_dispatcher_errors[0].metric_name == "Errors",
      aws_cloudwatch_metric_alarm.item_processing_worker_errors[0].metric_name == "Errors",
      aws_cloudwatch_metric_alarm.item_created_dispatcher_iterator_age[0].metric_name == "IteratorAge",
      aws_cloudwatch_metric_alarm.item_created_dispatcher_iterator_age[0].threshold == 300000
    ])
    error_message = "Async Lambda error and iterator age alarms must be present."
  }
}
