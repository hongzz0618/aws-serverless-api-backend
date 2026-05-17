variable "region" {
  description = "AWS region"
  type        = string
}

variable "project_name" {
  description = "Project name prefix"
  type        = string
}

variable "api_throttle_rate_limit" {
  description = "API Gateway steady-state throttle limit in requests per second."
  type        = number
  default     = 20
}

variable "api_throttle_burst_limit" {
  description = "API Gateway burst throttle limit in requests."
  type        = number
  default     = 40
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention period for Lambda and API Gateway access logs."
  type        = number
  default     = 7
}

variable "enable_alarms" {
  description = "Whether to create basic CloudWatch alarms for API Gateway and Lambda."
  type        = bool
  default     = true
}

variable "alarm_actions" {
  description = "Optional list of SNS topic ARNs or other CloudWatch alarm action ARNs."
  type        = list(string)
  default     = []
}
