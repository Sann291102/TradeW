resource "aws_ecr_repository" "service" {
  for_each = local.services

  name                 = "${var.project}/${each.key}"
  image_tag_mutability = "IMMUTABLE" # A tag that can be repointed makes a rollback a guess.

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Untagged images accumulate on every rebuild and are pure cost. Tagged images
# are kept generously — 30 is several weeks of deploys, and the whole point of
# immutable tags is being able to roll back to one.
resource "aws_ecr_lifecycle_policy" "service" {
  for_each   = aws_ecr_repository.service
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 30 tagged images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
        action       = { type = "expire" }
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = local.services

  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ------------------------------------------------------------------- IAM
#
# Two roles, and the distinction matters. The EXECUTION role is used by the ECS
# agent to pull the image and fetch secrets before the container starts. The
# TASK role is what the application code itself gets. They are separate so that
# application code does not inherit permission to read every secret in the
# account — it receives the values it needs as environment, and holds no
# credentials to fetch more.

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn] # This one secret. Not "*".
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-app-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  # Deliberately no policies attached. The application talks to Postgres, Redis
  # and third-party HTTP APIs — none of which are AWS services — so it needs no
  # AWS permissions at all. Add them one at a time, with a reason, if that
  # changes.
}

# ------------------------------------------------------------- task definitions

locals {
  # Secrets are injected by ARN reference, resolved by the ECS agent at task
  # start. They never appear in the task definition JSON, which is readable by
  # anyone holding ecs:DescribeTaskDefinition.
  secret_keys = [
    "DATABASE_URL",
    "REDIS_URL",
    "JWT_SECRET",
    "ADMIN_API_TOKEN",
    "SERVICE_TOKEN",
    "SENTINEL_SERVICE_TOKEN",
    "DHAN_ACCESS_TOKEN",
    "DHAN_CLIENT_ID",
  ]

  task_secrets = [
    for k in local.secret_keys : {
      name      = k
      valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::"
    }
  ]

  # Non-secret configuration, shared by every service. Service-specific values
  # are merged on top in each task definition below.
  common_env = [
    { name = "NODE_ENV", value = "production" },
    # Bind the container's interfaces. Every service defaults to 127.0.0.1 so a
    # developer's machine is not exposed to its own LAN; inside a task that
    # default means "nothing can reach me", which fails the health check while
    # the logs say the service started normally.
    { name = "HOST", value = "0.0.0.0" },
    { name = "SENTINEL_SERVICE_URL", value = "http://sentinel.${local.name}.internal:${local.services.sentinel.port}" },
    { name = "SENTINEL_LIVE_FEED_URL", value = "http://live-feed.${local.name}.internal:${local.services["live-feed"].port}" },
    { name = "API_PROXY_TARGET", value = "http://api.${local.name}.internal:${local.services.api.port}" },
    { name = "FEED_PROXY_TARGET", value = "http://live-feed.${local.name}.internal:${local.services["live-feed"].port}" },
    { name = "FRONTEND_URL", value = "https://${var.domain_name}" },
    # CloudFront is not in front of the ALB in this stack, so there is exactly
    # one proxy hop. This is what makes the rate limiter meter real clients and
    # the security log record real IPs. Raise it to 2 if CloudFront is added —
    # and only then, because a value higher than the real hop count lets a
    # client forge X-Forwarded-For and mint itself a fresh rate-limit bucket.
    { name = "TRUSTED_PROXY_HOPS", value = "1" },
  ]
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "${local.name}.internal"
  description = "Internal service-to-service names. Nothing here resolves publicly."
  vpc         = aws_vpc.main.id
}

resource "aws_service_discovery_service" "service" {
  for_each = local.services

  name = each.key

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.key == "sentinel" ? var.sentinel_cpu : var.api_cpu
  memory                   = each.key == "sentinel" ? var.sentinel_memory : var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    # X86_64 here, not ARM64 — a deliberate difference from Stage 0, where the
    # OCI Ampere VM forces arm64. Fargate offers both; pick one and make CI
    # build for it. Building for the wrong one produces an image that pulls
    # successfully and then exec-format-errors on start.
    cpu_architecture = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.service[each.key].repository_url}:${var.image_tag}"
      essential = true

      portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]

      # The live-feed bridge is a ts-node script, not a Nest build — it shares
      # the market-data image (see services/market-data/Dockerfile).
      command = each.key == "live-feed" ? ["npx", "ts-node", "-T", "--project", "tsconfig.scripts.json", "scripts/live-feed-server.ts"] : null

      environment = concat(
        local.common_env,
        [{ name = "PORT", value = tostring(each.value.port) }],
        each.key == "live-feed" ? [
          { name = "DHAN_LIVE_PORT", value = tostring(each.value.port) },
          { name = "DHAN_LIVE_HOST", value = "0.0.0.0" },
        ] : [],
      )

      secrets = local.task_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service[each.key].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = each.key
        }
      }

      # Container-level health check, distinct from the ALB target-group check.
      # This one is liveness and must NOT depend on the database, or a database
      # blip restarts every task simultaneously and turns a recoverable
      # dependency failure into a full outage.
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${each.value.port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 15
        timeout     = 5
        retries     = 5
        startPeriod = 30
      }

      # SIGTERM -> this many seconds -> SIGKILL. Long enough for Nest's shutdown
      # hooks to flush telemetry, release job leases and close the Prisma pool.
      stopTimeout = 30
    }
  ])
}

resource "aws_ecs_service" "service" {
  for_each = local.services

  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  launch_type     = "FARGATE"

  desired_count = (
    each.key == "web" ? var.web_desired_count :
    each.key == "api" ? var.api_desired_count :
    each.key == "sentinel" ? var.sentinel_desired_count :
    each.key == "market-data" ? var.market_data_desired_count :
    var.live_feed_desired_count
  )

  # Singletons must never run two tasks at once, not even for the few seconds a
  # rolling deploy would normally overlap them — a second market-data task
  # competes for the broker's per-account connection set, and a second Sentinel
  # double-counts the occurrences its own live-performance gate reads. So they
  # deploy by stopping the old task first (100/0) and accept a brief gap.
  # Stateless services deploy the usual way, with no gap.
  deployment_minimum_healthy_percent = each.value.singleton ? 0 : 100
  deployment_maximum_percent         = each.value.singleton ? 100 : 200

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false # Private subnets + NAT. A public IP here would bypass the ALB.
  }

  service_registries {
    registry_arn = aws_service_discovery_service.service[each.key].arn
  }

  dynamic "load_balancer" {
    for_each = each.value.public ? [1] : []
    content {
      target_group_arn = each.key == "api" ? aws_lb_target_group.api.arn : aws_lb_target_group.web.arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  # Only wait for the load balancer on services that have one.
  health_check_grace_period_seconds = each.value.public ? 60 : null

  enable_execute_command = true # `aws ecs execute-command` for incident debugging, without SSH.

  depends_on = [aws_lb_listener.https]

  lifecycle {
    # CI updates the task definition on deploy; Terraform should not fight it by
    # reverting to whatever image tag was in the last apply.
    ignore_changes = [task_definition, desired_count]
  }
}

# ------------------------------------------------------------------ autoscaling
#
# API only. Every other service is either the web tier (fixed small count, add
# scaling when it is ever the bottleneck — it never was in the load test) or a
# singleton that must not scale at all.

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.service["api"].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = var.api_target_cpu

    # Scale out quickly, in slowly. Indian market open is a step function in
    # traffic, not a ramp, and a five-minute scale-in cooldown that is too eager
    # will remove a task moments before the next surge.
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}
