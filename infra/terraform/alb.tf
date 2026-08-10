resource "aws_acm_certificate" "main" {
  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_lb" "main" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # Longer than the default 60s because the API streams Server-Sent Events (the
  # admin telemetry feed, the Knowledge Workspace stream). At 60s the ALB would
  # cut a healthy idle stream every minute and the client would reconnect
  # forever, which reads as a flapping feature rather than as a proxy setting.
  idle_timeout = 300

  enable_deletion_protection = true
  drop_invalid_header_fields = true

  tags = { Name = local.name }
}

# One target group per publicly-routed service.
#
# The health check path is the load-bearing detail. `/ready` for the API, not
# `/health`: readiness asks "can this task serve a request", which for the API
# means the database is reachable. `/health` answers "is the process alive",
# which is the right question for the container orchestrator to ask before
# killing a task and the wrong one for the load balancer to ask before sending
# it traffic. Sending traffic to a live task with no database is exactly the
# failure this split exists to prevent.
resource "aws_lb_target_group" "api" {
  name        = substr("${local.name}-api", 0, 32)
  port        = local.services.api.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    path                = "/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Give in-flight requests time to finish when a task is being replaced. 30s
  # comfortably covers the slowest measured request (see
  # docs/LOAD-TEST-REPORT.md) without making a deploy feel stuck.
  deregistration_delay = 30

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group" "web" {
  name        = substr("${local.name}-web", 0, 32)
  port        = local.services.web.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    # Next has no dedicated health route; the root document is the signal.
    path                = "/"
    matcher             = "200-399"
    interval            = 20
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # Port 80 exists only to send people to port 443. Nothing is served here.
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2 minimum. TLS13 policies exist but still negotiate 1.2 for clients
  # that need it; this policy is the one that refuses 1.0/1.1 outright.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# `/api/*` -> the API, with the prefix stripped, mirroring what Caddy does in
# the Stage 0 compose deployment. Keeping the browser on ONE origin is not a
# convenience: it is what makes CORS irrelevant and keeps cookies on a single
# apex, and the two deployments must agree on it or the frontend needs two
# builds.
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# NOTE: ALB cannot rewrite a path on a forward action the way Caddy's
# `handle_path` does. Two options, and the choice belongs to whoever applies
# this:
#   (a) Mount the API under a global `/api` prefix (`app.setGlobalPrefix('api')`
#       in services/api/src/main.ts, env-gated so Stage 0 is unaffected), or
#   (b) put CloudFront in front and rewrite there.
# (a) is the smaller change and keeps the two deployments' routing identical
# from the browser's point of view. It is called out here rather than silently
# assumed, because applying this file without doing one of them yields an API
# that 404s every request while every health check stays green.

resource "aws_route53_record" "apex" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "www" {
  zone_id = var.route53_zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
