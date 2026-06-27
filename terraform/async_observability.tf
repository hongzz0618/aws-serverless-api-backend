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
