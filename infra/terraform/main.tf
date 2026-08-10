terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State backend, left as a comment ON PURPOSE.
  #
  # Pointing this at an S3 bucket that does not exist yet turns `terraform init`
  # into a confusing failure before anyone has read a line of this. Create the
  # bucket and the lock table first, then uncomment. The lock table is not
  # optional once more than one person (or one CI job) can apply: without it,
  # two concurrent applies race on the same state file.
  #
  # backend "s3" {
  #   bucket         = "tradew-tfstate"
  #   key            = "prod/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "tradew-tfstate-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = merge(
      {
        Project     = var.project
        Environment = var.environment
        ManagedBy   = "terraform"
        Repo        = "TradeW"
      },
      var.tags,
    )
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "${var.project}-${var.environment}"

  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # Every service that gets an ECR repository, a log group and a task
  # definition. `singleton` is not decoration — it drives the desired_count and
  # is the field to read before anyone reaches for the autoscaling knobs.
  services = {
    web = {
      port      = 3000
      singleton = false
      public    = true
    }
    api = {
      port      = 4000
      singleton = false
      public    = true
    }
    sentinel = {
      port      = 4010
      singleton = true
      public    = false
    }
    market-data = {
      port      = 4020
      singleton = true
      public    = false
    }
    live-feed = {
      port      = 4600
      singleton = true
      public    = false
    }
  }
}
