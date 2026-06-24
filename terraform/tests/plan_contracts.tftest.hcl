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
    arn = "arn:aws:dynamodb:us-east-1:123456789012:table/serverless-api-items"
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
