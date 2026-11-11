locals {
  item_processing_queue_visibility_timeout_seconds = local.lambda_timeout_seconds * 6
  item_processing_queue_retention_seconds          = 4 * 24 * 60 * 60
  item_processing_dlq_retention_seconds            = 14 * 24 * 60 * 60
  item_processing_max_receive_count                = 5
  item_processing_worker_maximum_concurrency       = 2
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "stream_failures" {
  # Keep the prefix within 37 characters and outside S3's reserved namespaces.
  bucket_prefix = "stream-fail-${substr(var.project_name, 0, 24)}-"
  force_destroy = false

  tags = {
    Name = "${var.project_name}-stream-failures"
  }
}

resource "aws_s3_bucket_ownership_controls" "stream_failures" {
  bucket = aws_s3_bucket.stream_failures.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "stream_failures" {
  bucket = aws_s3_bucket.stream_failures.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "stream_failures" {
  bucket = aws_s3_bucket.stream_failures.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "stream_failures" {
  bucket = aws_s3_bucket.stream_failures.id

  rule {
    id     = "expire-stream-failures"
    status = "Enabled"
    filter {}

    expiration {
      days = 30
    }
  }
}

resource "aws_s3_bucket_policy" "stream_failures" {
  bucket = aws_s3_bucket.stream_failures.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.stream_failures.arn, "${aws_s3_bucket.stream_failures.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_sqs_queue" "item_processing_dlq" {
  name                       = "${var.project_name}-item-processing-dlq"
  fifo_queue                 = false
  message_retention_seconds  = local.item_processing_dlq_retention_seconds
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = local.item_processing_queue_visibility_timeout_seconds
}

resource "aws_sqs_queue" "item_processing" {
  name                       = "${var.project_name}-item-processing"
  fifo_queue                 = false
  visibility_timeout_seconds = local.item_processing_queue_visibility_timeout_seconds
  message_retention_seconds  = local.item_processing_queue_retention_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.item_processing_dlq.arn
    maxReceiveCount     = local.item_processing_max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "item_processing_dlq" {
  queue_url = aws_sqs_queue.item_processing_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.item_processing.arn]
  })
}

resource "aws_cloudwatch_log_group" "item_created_dispatcher" {
  name              = "/aws/lambda/${var.project_name}-item-created-dispatcher"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "item_processing_worker" {
  name              = "/aws/lambda/${var.project_name}-item-processing-worker"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "item_created_dispatcher" {
  name = "${var.project_name}-item-created-dispatcher-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "item_created_dispatcher" {
  name = "${var.project_name}-item-created-dispatcher"
  role = aws_iam_role.item_created_dispatcher.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator"
        ]
        Resource = aws_dynamodb_table.items.stream_arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:ListStreams"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.item_processing.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.stream_failures.arn
        Condition = {
          StringEquals = { "s3:ResourceAccount" = data.aws_caller_identity.current.account_id }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.stream_failures.arn}/*"
        Condition = {
          StringEquals = { "s3:ResourceAccount" = data.aws_caller_identity.current.account_id }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.item_created_dispatcher.arn}:*"
      }
    ]
  })
}

resource "aws_iam_role" "item_processing_worker" {
  name = "${var.project_name}-item-processing-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "item_processing_worker" {
  name = "${var.project_name}-item-processing-worker"
  role = aws_iam_role.item_processing_worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.item_processing.arn
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.items.arn
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.item_processing_worker.arn}:*"
      }
    ]
  })
}

resource "aws_lambda_function" "item_created_dispatcher" {
  function_name = "${var.project_name}-item-created-dispatcher"
  role          = aws_iam_role.item_created_dispatcher.arn
  handler       = "dispatchItemCreated.handler"
  runtime       = "nodejs22.x"
  memory_size   = local.lambda_memory_size
  timeout       = local.lambda_timeout_seconds

  filename         = "${path.module}/../lambdas/dispatchItemCreated.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambdas/dispatchItemCreated.zip")

  environment {
    variables = {
      ITEM_PROCESSING_QUEUE_URL = aws_sqs_queue.item_processing.url
    }
  }

  depends_on = [aws_cloudwatch_log_group.item_created_dispatcher]
}

resource "aws_lambda_function" "item_processing_worker" {
  function_name = "${var.project_name}-item-processing-worker"
  role          = aws_iam_role.item_processing_worker.arn
  handler       = "processItemCreated.handler"
  runtime       = "nodejs22.x"
  memory_size   = local.lambda_memory_size
  timeout       = local.lambda_timeout_seconds

  filename         = "${path.module}/../lambdas/processItemCreated.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambdas/processItemCreated.zip")

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.items.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.item_processing_worker]
}

resource "aws_lambda_event_source_mapping" "item_created_dispatcher" {
  event_source_arn               = aws_dynamodb_table.items.stream_arn
  function_name                  = aws_lambda_function.item_created_dispatcher.arn
  enabled                        = true
  starting_position              = "TRIM_HORIZON"
  batch_size                     = 10
  bisect_batch_on_function_error = true
  function_response_types        = ["ReportBatchItemFailures"]
  maximum_retry_attempts         = 3
  maximum_record_age_in_seconds  = 3600

  destination_config {
    on_failure {
      destination_arn = aws_s3_bucket.stream_failures.arn
    }
  }

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT"]
      })
    }
  }

  depends_on = [
    aws_iam_role_policy.item_created_dispatcher,
    aws_cloudwatch_log_group.item_created_dispatcher,
    aws_s3_bucket_ownership_controls.stream_failures,
    aws_s3_bucket_public_access_block.stream_failures,
    aws_s3_bucket_server_side_encryption_configuration.stream_failures,
    aws_s3_bucket_lifecycle_configuration.stream_failures,
    aws_s3_bucket_policy.stream_failures
  ]
}

resource "aws_lambda_event_source_mapping" "item_processing_worker" {
  event_source_arn        = aws_sqs_queue.item_processing.arn
  function_name           = aws_lambda_function.item_processing_worker.arn
  enabled                 = true
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = local.item_processing_worker_maximum_concurrency
  }

  depends_on = [
    aws_iam_role_policy.item_processing_worker,
    aws_sqs_queue_redrive_allow_policy.item_processing_dlq,
    aws_cloudwatch_log_group.item_processing_worker
  ]
}
