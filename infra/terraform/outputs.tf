output "alb_dns_name" {
  description = "Load balancer hostname. The Route53 alias records point here; useful directly when DNS is still propagating."
  value       = aws_lb.main.dns_name
}

output "site_url" {
  value = "https://${var.domain_name}"
}

output "ecr_repository_urls" {
  description = "Push targets for CI, one per service."
  value       = { for k, v in aws_ecr_repository.service : k => v.repository_url }
}

output "database_endpoint" {
  description = "RDS endpoint. Not a connection string — the full DATABASE_URL, password included, lives in Secrets Manager."
  value       = aws_db_instance.main.endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "app_secret_arn" {
  description = "Set the real secret values here, out of band. Terraform creates the container and then ignores its contents (see data.tf)."
  value       = aws_secretsmanager_secret.app.arn
}

output "singleton_services" {
  description = "Services that must never run more than one task. Kept as an output so it shows up in `terraform output` rather than only in a comment someone has to go looking for."
  value       = [for k, v in local.services : k if v.singleton]
}
