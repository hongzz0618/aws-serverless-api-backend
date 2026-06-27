output "api_url" {
  value = "https://${aws_api_gateway_rest_api.api.id}.execute-api.${var.region}.amazonaws.com/${aws_api_gateway_stage.dev.stage_name}"
}

output "api_access_log_group_name" {
  value = aws_cloudwatch_log_group.api_access.name
}

output "items_table_name" {
  value = aws_dynamodb_table.items.name
}

output "item_processing_queue_url" {
  value = aws_sqs_queue.item_processing.url
}

output "item_processing_queue_arn" {
  value = aws_sqs_queue.item_processing.arn
}

output "item_processing_dlq_url" {
  value = aws_sqs_queue.item_processing_dlq.id
}

output "item_processing_dlq_arn" {
  value = aws_sqs_queue.item_processing_dlq.arn
}

output "item_created_dispatcher_function_name" {
  value = aws_lambda_function.item_created_dispatcher.function_name
}

output "item_processing_worker_function_name" {
  value = aws_lambda_function.item_processing_worker.function_name
}

output "item_created_dispatcher_log_group_name" {
  value = aws_cloudwatch_log_group.item_created_dispatcher.name
}

output "item_processing_worker_log_group_name" {
  value = aws_cloudwatch_log_group.item_processing_worker.name
}

output "cloudwatch_alarm_names" {
  value = var.enable_alarms ? concat(
    values(aws_cloudwatch_metric_alarm.lambda_errors)[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.lambda_handled_500_errors)[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.lambda_throttles)[*].alarm_name,
    aws_cloudwatch_metric_alarm.api_5xx_errors[*].alarm_name,
    aws_cloudwatch_metric_alarm.api_4xx_errors[*].alarm_name,
    aws_cloudwatch_metric_alarm.api_latency[*].alarm_name,
    aws_cloudwatch_metric_alarm.dynamodb_system_errors[*].alarm_name,
    aws_cloudwatch_metric_alarm.item_processing_dlq_visible_messages[*].alarm_name,
    aws_cloudwatch_metric_alarm.item_processing_queue_age[*].alarm_name,
    aws_cloudwatch_metric_alarm.item_created_dispatcher_errors[*].alarm_name,
    aws_cloudwatch_metric_alarm.item_processing_worker_errors[*].alarm_name,
    aws_cloudwatch_metric_alarm.item_created_dispatcher_iterator_age[*].alarm_name,
    aws_cloudwatch_metric_alarm.item_created_dispatch_failures[*].alarm_name,
    aws_cloudwatch_metric_alarm.item_processing_permanent_failures[*].alarm_name,
    aws_cloudwatch_metric_alarm.item_processing_retryable_failures[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.async_lambda_throttles)[*].alarm_name
  ) : []
}
