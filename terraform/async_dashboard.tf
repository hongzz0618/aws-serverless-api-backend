locals {
  async_dashboard_widgets = [
    {
      title = "Queue backlog (visible messages)"
      stat  = "Maximum"
      metrics = [
        ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.item_processing.name]
      ]
    },
    {
      title = "Oldest queued message age (seconds)"
      stat  = "Maximum"
      metrics = [
        ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.item_processing.name]
      ]
    },
    {
      title = "DLQ visible messages"
      stat  = "Maximum"
      metrics = [
        ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.item_processing_dlq.name]
      ]
    },
    {
      title = "Worker processing outcomes"
      stat  = "Sum"
      metrics = [
        [local.handled_application_error_namespace, local.async_application_metric_filters.worker_success.metric_name, { label = "Successes" }],
        [local.handled_application_error_namespace, local.async_application_metric_filters.worker_retryable_failure.metric_name, { label = "Retryable failures" }],
        [local.handled_application_error_namespace, local.async_application_metric_filters.worker_permanent_failure.metric_name, { label = "Permanent failures" }]
      ]
    },
    {
      title = "Dispatcher failures"
      stat  = "Sum"
      metrics = [
        [local.handled_application_error_namespace, local.async_application_metric_filters.dispatcher_failure.metric_name, { label = "Handled failures" }],
        ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.item_created_dispatcher.function_name, { label = "Invocation errors" }]
      ]
    },
    {
      title = "Worker Lambda errors and throttles"
      stat  = "Sum"
      metrics = [
        ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.item_processing_worker.function_name],
        ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.item_processing_worker.function_name]
      ]
    }
  ]
}

resource "aws_cloudwatch_dashboard" "async_item_processing" {
  dashboard_name = "${var.project_name}-${var.region}-async-item-processing"
  dashboard_body = jsonencode({
    start          = "-PT6H"
    periodOverride = "inherit"
    widgets = [for index, widget in local.async_dashboard_widgets : {
      type   = "metric"
      x      = (index % 2) * 12
      y      = floor(index / 2) * 6
      width  = 12
      height = 6
      properties = merge(widget, {
        region  = var.region
        period  = 300
        view    = "timeSeries"
        stacked = false
      })
    }]
  })
}
