locals {
  async_application_metric_filters = {
    dispatcher_failure = {
      name           = "${aws_lambda_function.item_created_dispatcher.function_name}-dispatch-failure"
      log_group_name = aws_cloudwatch_log_group.item_created_dispatcher.name
      metric_name    = "ItemCreatedDispatchFailureCount"
      pattern        = "{ $.event = \"item_created_dispatch_failed\" }"
    }
    worker_success = {
      name           = "${aws_lambda_function.item_processing_worker.function_name}-processing-success"
      log_group_name = aws_cloudwatch_log_group.item_processing_worker.name
      metric_name    = "ItemProcessingSuccessCount"
      pattern        = "{ $.event = \"item_processing_completed\" }"
    }
    worker_retryable_failure = {
      name           = "${aws_lambda_function.item_processing_worker.function_name}-retryable-failure"
      log_group_name = aws_cloudwatch_log_group.item_processing_worker.name
      metric_name    = "ItemProcessingRetryableFailureCount"
      pattern        = "{ $.event = \"item_processing_failed\" && $.retryable IS TRUE }"
    }
    worker_permanent_failure = {
      name           = "${aws_lambda_function.item_processing_worker.function_name}-permanent-failure"
      log_group_name = aws_cloudwatch_log_group.item_processing_worker.name
      metric_name    = "ItemProcessingPermanentFailureCount"
      pattern        = "{ $.event = \"item_processing_failed\" && $.retryable IS FALSE }"
    }
    worker_duplicate = {
      name           = "${aws_lambda_function.item_processing_worker.function_name}-duplicate"
      log_group_name = aws_cloudwatch_log_group.item_processing_worker.name
      metric_name    = "ItemProcessingDuplicateCount"
      pattern        = "{ $.event = \"duplicate_event_ignored\" }"
    }
    worker_skipped = {
      name           = "${aws_lambda_function.item_processing_worker.function_name}-skipped"
      log_group_name = aws_cloudwatch_log_group.item_processing_worker.name
      metric_name    = "ItemProcessingSkippedCount"
      pattern        = "{ $.event = \"item_processing_skipped\" }"
    }
  }

  async_lambda_functions = {
    dispatcher = aws_lambda_function.item_created_dispatcher.function_name
    worker     = aws_lambda_function.item_processing_worker.function_name
  }
}

resource "aws_cloudwatch_log_metric_filter" "async_application_events" {
  for_each = local.async_application_metric_filters

  name           = each.value.name
  log_group_name = each.value.log_group_name
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.value.metric_name
    namespace = local.handled_application_error_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "item_processing_dlq_visible_messages" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-item-processing-dlq-visible-messages"
  alarm_description   = "Item processing DLQ has one or more messages requiring investigation."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    QueueName = aws_sqs_queue.item_processing_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "item_created_dispatch_failures" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-item-created-dispatch-failures"
  alarm_description   = "Item-created dispatcher handled one or more stream records that were not sent to SQS. The Lambda invocation may still complete successfully."
  namespace           = local.handled_application_error_namespace
  metric_name         = "ItemCreatedDispatchFailureCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "item_processing_permanent_failures" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-item-processing-permanent-failures"
  alarm_description   = "Item-processing worker saw a non-retryable message such as an invalid event, conflicting stored state, or other condition requiring investigation."
  namespace           = local.handled_application_error_namespace
  metric_name         = "ItemProcessingPermanentFailureCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "item_processing_retryable_failures" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-item-processing-retryable-failures"
  alarm_description   = "Item-processing worker saw repeated retryable failures over a 15-minute window."
  namespace           = local.handled_application_error_namespace
  metric_name         = "ItemProcessingRetryableFailureCount"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "async_lambda_throttles" {
  for_each = var.enable_alarms ? local.async_lambda_functions : {}

  alarm_name          = "${each.value}-throttles"
  alarm_description   = "Async Lambda function was throttled one or more times in a 5-minute period."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    FunctionName = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "item_processing_queue_age" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-item-processing-queue-age"
  alarm_description   = "Oldest item processing message has waited more than 5 minutes."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    QueueName = aws_sqs_queue.item_processing.name
  }
}

resource "aws_cloudwatch_metric_alarm" "item_created_dispatcher_errors" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${aws_lambda_function.item_created_dispatcher.function_name}-errors"
  alarm_description   = "Item-created dispatcher Lambda reported one or more errors in a 5-minute period."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    FunctionName = aws_lambda_function.item_created_dispatcher.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "item_processing_worker_errors" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${aws_lambda_function.item_processing_worker.function_name}-errors"
  alarm_description   = "Item-processing worker Lambda reported one or more errors in a 5-minute period."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    FunctionName = aws_lambda_function.item_processing_worker.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "item_created_dispatcher_iterator_age" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${aws_lambda_function.item_created_dispatcher.function_name}-iterator-age"
  alarm_description   = "Item-created dispatcher DynamoDB stream iterator age exceeded 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "IteratorAge"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 300000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    FunctionName = aws_lambda_function.item_created_dispatcher.function_name
  }
}
