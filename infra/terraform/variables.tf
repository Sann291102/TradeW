variable "project" {
  description = "Name prefix for every resource. Keep it short — ALB target group names are capped at 32 characters."
  type        = string
  default     = "tradew"
}

variable "environment" {
  description = "prod | staging. Part of every resource name and of the Secrets Manager path."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "ap-south-1 (Mumbai) — the users and the exchange are both in India, and a round trip to us-east-1 would add ~200ms to every request in a product where the market data is the point."
  type        = string
  default     = "ap-south-1"
}

variable "domain_name" {
  description = "Apex domain served by the ALB, e.g. tradew.in. An ACM certificate is requested for this name and www."
  type        = string
}

variable "route53_zone_id" {
  description = "Hosted zone for domain_name. Used for ACM DNS validation and the ALB alias record."
  type        = string
}

# ---------------------------------------------------------------- networking

variable "vpc_cidr" {
  description = "/16 leaves room to add subnets later without renumbering."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "Two AZs is the smallest topology that survives losing one. Three costs a third NAT-adjacent footprint for a failure mode two already covers."
  type        = number
  default     = 2
}

# ------------------------------------------------------------------ database

variable "db_instance_class" {
  description = "db.t4g.small is the honest starting point for the measured Stage 0 load (see docs/LOAD-TEST-REPORT.md). Graviton, burstable, and cheap enough that over-provisioning is not the thing to worry about first."
  type        = string
  default     = "db.t4g.small"
}

variable "db_allocated_storage" {
  description = "GB. gp3, with storage autoscaling to db_max_allocated_storage so a runaway table does not cause an outage at 3am."
  type        = number
  default     = 50
}

variable "db_max_allocated_storage" {
  description = "Ceiling for RDS storage autoscaling."
  type        = number
  default     = 200
}

variable "db_multi_az" {
  description = "Multi-AZ roughly doubles the database bill and is the single most effective availability purchase available. Off by default because at Stage 1 the honest answer is that a few minutes of downtime is survivable; turn it on the day it is not."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. 7 is the point where a Friday incident is still recoverable on Monday."
  type        = number
  default     = 7
}

# --------------------------------------------------------------------- cache

variable "redis_node_type" {
  description = "cache.t4g.micro. Redis exists at Stage 1 for shared rate-limit counters and hot market-data caching — both tiny working sets."
  type        = string
  default     = "cache.t4g.micro"
}

# ------------------------------------------------------------------- compute

variable "api_desired_count" {
  description = "Safe to scale: the API's singleton background jobs run behind the JobLease leader election (services/api/src/common/leader-election.ts). Before that existed, >1 would have double-filled resting orders."
  type        = number
  default     = 2
}

variable "web_desired_count" {
  description = "Stateless Next.js server. Scales freely."
  type        = number
  default     = 2
}

variable "api_cpu" {
  description = "Fargate CPU units for the API task."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "MiB for the API task. Node's default heap sits well under this; the headroom is for the telemetry buffers (capped at 5k records each) and Prisma's pool."
  type        = number
  default     = 1024
}

variable "sentinel_cpu" {
  description = "Sentinel is the CPU-heaviest service — the BM25 corpus and the reasoning pipeline are compute, not IO."
  type        = number
  default     = 1024
}

variable "sentinel_memory" {
  description = "MiB. The citation corpus (2085 chunks at last count) is held in memory per instance."
  type        = number
  default     = 2048
}

# Singleton services. These are variables rather than hardcoded 1s so the value
# is visible in a plan diff — but changing them is a correctness decision, not a
# capacity one. See infra/terraform/README.md.

variable "market_data_desired_count" {
  description = "MUST be 1. Owns the broker feed connection; Dhan counts those per account (five, then it evicts the oldest with code 805). A second task fights the first for the connection set."
  type        = number
  default     = 1

  validation {
    condition     = var.market_data_desired_count == 1
    error_message = "market-data is a singleton: the broker feed connection set is a per-account resource. Scale services/api instead."
  }
}

variable "live_feed_desired_count" {
  description = "MUST be 1, for the same broker-connection reason as market-data."
  type        = number
  default     = 1

  validation {
    condition     = var.live_feed_desired_count == 1
    error_message = "live-feed is a singleton: it holds a Dhan feed connection."
  }
}

variable "sentinel_desired_count" {
  description = "MUST be 1 today. Sentinel holds an in-memory market-watch registry and writes occurrence records that feed its own live-performance gate; two instances double-count occurrences and inflate the sample that gate reads. Making it scalable is Stage 2 work, tracked in docs/CLOUD-ARCHITECTURE.md."
  type        = number
  default     = 1

  validation {
    condition     = var.sentinel_desired_count == 1
    error_message = "sentinel is not horizontally scalable yet — see docs/CLOUD-ARCHITECTURE.md. Remove this validation only alongside the change that makes its watch registry and occurrence recording shared."
  }
}

# ------------------------------------------------------------------ scaling

variable "api_max_count" {
  description = "Upper bound for API autoscaling. Also the number that decides the RDS connection budget: max_count × Prisma connection_limit must stay under the instance's max_connections."
  type        = number
  default     = 6
}

variable "api_target_cpu" {
  description = "Target-tracking CPU percentage. 60 rather than 80 because Fargate task startup is not instant and the scale-out has to begin before the current tasks are already saturated."
  type        = number
  default     = 60
}

variable "prisma_connection_limit" {
  description = "Postgres connections PER API TASK. Prisma's default is (vCPU × 2 + 1), which silently multiplies by the task count. Set explicitly and budget against RDS max_connections — see api_max_count."
  type        = number
  default     = 10
}

variable "log_retention_days" {
  description = "CloudWatch retention. Matches TELEMETRY_RETENTION_DAYS so 'how far back can we look' has one answer, not two."
  type        = number
  default     = 30
}

variable "image_tag" {
  description = "Image tag deployed to every service. CI sets this to the commit SHA; 'latest' is deliberately not the default, because a task definition pinned to a moving tag makes a rollback impossible to express."
  type        = string
}

variable "tags" {
  description = "Extra tags merged onto every resource."
  type        = map(string)
  default     = {}
}
