resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # ECS service discovery and RDS endpoints are names, not IPs.

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

# Public subnets hold the ALB and the NAT gateway, and nothing else. No task
# runs here: a Fargate task with a public IP is directly reachable from the
# internet on its container port, which would route around the ALB and every
# rule attached to it.
resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public-${local.azs[count.index]}", Tier = "public" }
}

# Private subnets hold every task, the database and the cache. Offset by 100 so
# public and private ranges stay visually distinguishable in a flow log.
resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 100)

  tags = { Name = "${local.name}-private-${local.azs[count.index]}", Tier = "private" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

# ONE NAT gateway, not one per AZ.
#
# Per-AZ NATs remove a cross-AZ dependency and are the textbook answer. They are
# also the largest fixed line on this bill. The tradeoff is worth stating
# plainly: if this AZ's NAT fails, tasks in the other AZ lose OUTBOUND internet
# — the broker feed, the news wires, the AI providers — while inbound traffic
# through the ALB keeps working. That is a degraded product, not an outage, and
# it is the right thing to buy back second rather than first.
resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]

  tags = { Name = local.name }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ------------------------------------------------------------ security groups
#
# The rule the whole design rests on: each tier accepts traffic ONLY from the
# security group of the tier above it, never from a CIDR. A subnet CIDR would
# grant access to anything that ever lands in that subnet; a security-group
# reference grants access to a specific role.

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ingress. The only security group that accepts traffic from the internet."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    # AWS restricts this field's character set, so no em dash here.
    description = "HTTP from anywhere; redirected to HTTPS, not served"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-alb" }
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "All ECS tasks. Inbound from the ALB, and from each other for internal calls."
  vpc_id      = aws_vpc.main.id

  # Unrestricted egress: tasks call the broker, the news wires and the AI
  # providers, whose address ranges are not knowable in advance. The inbound
  # rules are where this design constrains things.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  for_each = { for k, v in local.services : k => v if v.public }

  security_group_id            = aws_security_group.tasks.id
  description                  = "ALB -> ${each.key}"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}

# Internal service-to-service. api -> sentinel, api/web -> live-feed, and so on.
# Self-referential rather than per-pair: the services already authenticate each
# other (x-service-token on the api->sentinel hop), and enumerating every pair
# here would encode the call graph in two places that then drift apart.
resource "aws_vpc_security_group_ingress_rule" "tasks_internal" {
  for_each = { for k, v in local.services : k => v if !v.public }

  security_group_id            = aws_security_group.tasks.id
  description                  = "internal -> ${each.key}"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "database" {
  name        = "${local.name}-db"
  description = "RDS. Reachable only from ECS tasks."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  security_group_id            = aws_security_group.database.id
  description                  = "ECS tasks -> Postgres"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "cache" {
  name        = "${local.name}-cache"
  description = "ElastiCache Redis. Reachable only from ECS tasks."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-cache" }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_tasks" {
  security_group_id            = aws_security_group.cache.id
  description                  = "ECS tasks -> Redis"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}
