variable "region" {
  description = "AWS region"
  type        = string

  validation {
    condition     = length(trimspace(var.region)) > 0
    error_message = "region must not be empty."
  }
}

variable "project_name" {
  description = "Project name prefix"
  type        = string

  validation {
    condition     = length(trimspace(var.project_name)) > 0 && length(var.project_name) <= 40
    error_message = "project_name must be non-empty and 40 characters or fewer."
  }
}

variable "api_throttle_rate_limit" {
  description = "API Gateway steady-state throttle limit in requests per second."
  type        = number
  default     = 20

  validation {
    condition     = var.api_throttle_rate_limit > 0
    error_message = "api_throttle_rate_limit must be greater than 0."
  }
}

variable "api_throttle_burst_limit" {
  description = "API Gateway burst throttle limit in requests."
  type        = number
  default     = 40

  validation {
    condition     = var.api_throttle_burst_limit > 0
    error_message = "api_throttle_burst_limit must be greater than 0."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention period for Lambda and API Gateway access logs."
  type        = number
  default     = 7

  validation {
    condition = contains([
      1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180,
      365, 400, 545, 731, 1096, 1827, 2192, 2557, 3653
    ], var.log_retention_days)
    error_message = "log_retention_days must be a valid CloudWatch Logs retention value."
  }
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
