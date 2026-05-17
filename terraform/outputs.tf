output "api_url" {
  value = "https://${aws_api_gateway_rest_api.api.id}.execute-api.${var.region}.amazonaws.com/${aws_api_gateway_stage.dev.stage_name}"
}

output "api_access_log_group_name" {
  value = aws_cloudwatch_log_group.api_access.name
}

output "cloudwatch_alarm_names" {
  value = var.enable_alarms ? concat(
    values(aws_cloudwatch_metric_alarm.lambda_errors)[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.lambda_throttles)[*].alarm_name,
    aws_cloudwatch_metric_alarm.api_5xx_errors[*].alarm_name
  ) : []
}
