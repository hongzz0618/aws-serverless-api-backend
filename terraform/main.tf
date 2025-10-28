# DynamoDB Table
resource "aws_dynamodb_table" "items" {
  name         = "${var.project_name}-items"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda_exec" {
  name = "${var.project_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "dynamo_full" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"
}

# Lambda Functions
resource "aws_lambda_function" "create_item" {
  function_name = "${var.project_name}-create"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "createItem.handler"
  runtime       = "nodejs18.x"

  filename         = "${path.module}/../lambdas/createItem.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambdas/createItem.zip")

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.items.name
    }
  }
}

resource "aws_lambda_function" "get_item" {
  function_name = "${var.project_name}-get"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "getItem.handler"
  runtime       = "nodejs18.x"

  filename         = "${path.module}/../lambdas/getItem.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambdas/getItem.zip")

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.items.name
    }
  }
}

resource "aws_lambda_function" "delete_item" {
  function_name = "${var.project_name}-delete"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "deleteItem.handler"
  runtime       = "nodejs18.x"

  filename         = "${path.module}/../lambdas/deleteItem.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambdas/deleteItem.zip")

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.items.name
    }
  }
}

# API Gateway
resource "aws_api_gateway_rest_api" "api" {
  name        = "${var.project_name}-api"
  description = "Serverless API Backend example"
}

# /items
resource "aws_api_gateway_resource" "items" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "items"
}

# POST /items
resource "aws_api_gateway_method" "post_items" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.items.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "post_items" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.items.id
  http_method             = aws_api_gateway_method.post_items.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.create_item.invoke_arn
}

# /items/{id}
resource "aws_api_gateway_resource" "item" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.items.id
  path_part   = "{id}"
}

# GET /items/{id}
resource "aws_api_gateway_method" "get_item" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.item.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "get_item" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.item.id
  http_method             = aws_api_gateway_method.get_item.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.get_item.invoke_arn
}

# DELETE /items/{id}
resource "aws_api_gateway_method" "delete_item" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.item.id
  http_method   = "DELETE"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "delete_item" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.item.id
  http_method             = aws_api_gateway_method.delete_item.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.delete_item.invoke_arn
}

# Deployment
resource "aws_api_gateway_deployment" "deployment" {
  rest_api_id = aws_api_gateway_rest_api.api.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_method.post_items.id,
      aws_api_gateway_method.get_item.id,
      aws_api_gateway_method.delete_item.id,
      aws_api_gateway_integration.post_items.id,
      aws_api_gateway_integration.get_item.id,
      aws_api_gateway_integration.delete_item.id
    ]))
  }

  depends_on = [
    aws_api_gateway_integration.post_items,
    aws_api_gateway_integration.get_item,
    aws_api_gateway_integration.delete_item
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "dev" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  deployment_id = aws_api_gateway_deployment.deployment.id
  stage_name    = "dev"
}

# Lambda permissions so API Gateway can invoke them
resource "aws_lambda_permission" "apigw_create" {
  statement_id  = "AllowAPIGatewayInvokeCreate"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.create_item.arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_get" {
  statement_id  = "AllowAPIGatewayInvokeGet"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_item.arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_delete" {
  statement_id  = "AllowAPIGatewayInvokeDelete"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.delete_item.arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}
