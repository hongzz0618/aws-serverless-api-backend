provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project      = var.project_name
      Environment  = "dev"
      ManagedBy    = "Terraform"
      Architecture = "ServerlessApiBackend"
    }
  }
}
