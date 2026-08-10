resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = local.name }
}

# Parameter group rather than the default, for one reason that matters and one
# that is convenience.
#
# `max_connections` is the one that matters. Prisma opens a pool PER PROCESS, so
# the connection budget is (api tasks × connection_limit) + sentinel + market-data
# + live-feed + whatever a human has open. That product is easy to exceed
# accidentally the first time autoscaling does its job, and the failure mode is
# the API refusing connections — which looks like a database outage. It is
# pinned here so the ceiling is a decision rather than a default that depends on
# instance memory.
resource "aws_db_parameter_group" "main" {
  name_prefix = "${local.name}-pg16-"
  family      = "postgres16"

  parameter {
    name         = "max_connections"
    value        = tostring(max(100, var.api_max_count * var.prisma_connection_limit + 60))
    apply_method = "pending-reboot"
  }

  # Log anything slower than a second. At the measured latencies (see
  # docs/LOAD-TEST-REPORT.md) a one-second query is not slow, it is broken, so
  # this threshold produces a log that is worth reading rather than one that is
  # always full.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "random_password" "db" {
  length = 32
  # Excluded rather than allowed: the password ends up inside a URL
  # (DATABASE_URL), and `@`, `/`, `:` and `#` all change how that URL parses.
  # A password that works in psql and breaks Prisma is a genuinely miserable
  # afternoon.
  override_special = "!*-_=+"
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "tradew"
  username = "tradew"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  multi_az                = var.db_multi_az
  backup_retention_period = var.db_backup_retention_days
  backup_window           = "20:00-21:00" # ~01:30 IST — after the Indian market close and well before the open.
  maintenance_window      = "sun:21:30-sun:22:30"

  # Deletion protection ON, and a final snapshot. Both exist because the failure
  # this guards against is not malice, it is a `terraform destroy` run against
  # the wrong var-file.
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  auto_minor_version_upgrade      = true
  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = { Name = local.name }
}

# pgvector is not optional — Sentinel's Persistent Knowledge Brain stores
# embeddings in it, and the schema's own migration runs `CREATE EXTENSION
# vector`. RDS ships the extension for Postgres 16; it still has to be created
# in the database, which the existing migration does. Recorded here so nobody
# has to rediscover why a fresh RDS instance fails its first migration if the
# engine version is ever moved backwards.

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

# Redis exists at Stage 1 for a specific, non-negotiable reason: the API's rate
# limiter keeps its counters in process memory (services/api/src/common/throttling.ts),
# so with api_desired_count > 1 the effective limit is multiplied by the task
# count and resets on every deploy. Sharing those counters is what makes the
# limiter mean what it says. Hot market-data caching is the second use, and the
# reason the node is sized for throughput rather than storage.
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = local.name
  description          = "${local.name} — shared rate-limit counters and hot market-data cache"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  # One node at Stage 1. The data is a cache and a set of per-minute counters:
  # losing it costs a brief window of un-metered requests and some cache misses,
  # not correctness. Turn on automatic_failover with a second node when the
  # limiter is load-bearing against abuse rather than against accidents.
  num_cache_clusters         = 1
  automatic_failover_enabled = false

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # Evict the least-recently-used key rather than returning errors when memory
  # fills. For a cache that is correct; the rate-limit counters are short-lived
  # enough that they are rarely the LRU victim.
  parameter_group_name = "default.redis7"

  tags = { Name = local.name }
}

# ------------------------------------------------------------------- secrets
#
# One secret holding the application's runtime configuration, injected into
# tasks by ARN. Deliberately NOT put in the task definition's `environment`
# block: anything there is plain text to anyone who can call
# ecs:DescribeTaskDefinition, which is a much wider group than the people who
# should see JWT_SECRET.
#
# The initial value is a placeholder. Terraform is the wrong place to author
# secret VALUES — putting them here writes them to state — so it creates the
# container and the real values are set out of band, once, by a human.

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  description             = "TradeW runtime secrets. Values are set out of band, not by Terraform."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    DATABASE_URL = "postgresql://tradew:${random_password.db.result}@${aws_db_instance.main.endpoint}/tradew?schema=public&connection_limit=${var.prisma_connection_limit}&pool_timeout=10"
    REDIS_URL    = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"

    # Placeholders. Boot fails loudly on these rather than starting insecure:
    # services/api/src/common/secret-validation.ts rejects placeholder,
    # too-short and vendor-key values for JWT_SECRET and ADMIN_API_TOKEN, and
    # ServiceTokenGuard does the same for SERVICE_TOKEN. That is the intended
    # behaviour — a deployment that has not had its secrets set should not serve
    # traffic.
    JWT_SECRET             = "SET_ME_OUT_OF_BAND"
    ADMIN_API_TOKEN        = "SET_ME_OUT_OF_BAND"
    SERVICE_TOKEN          = "SET_ME_OUT_OF_BAND"
    SENTINEL_SERVICE_TOKEN = "SET_ME_OUT_OF_BAND"
    DHAN_ACCESS_TOKEN      = "SET_ME_OUT_OF_BAND"
    DHAN_CLIENT_ID         = "SET_ME_OUT_OF_BAND"
  })

  lifecycle {
    # Terraform creates this once and then keeps its hands off. Without this,
    # every apply would revert the real secrets to the placeholders above —
    # which is the kind of outage that takes an hour to diagnose because
    # `terraform plan` said "no changes" to everything anyone would think to look at.
    ignore_changes = [secret_string]
  }
}
