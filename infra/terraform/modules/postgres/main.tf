# postgres — Flexible Server 16, private, RLS is applied by migrations.
variable "name" { type = string }
variable "rg" { type = string }
variable "location" { type = string }
variable "data_subnet_id" { type = string }
variable "admin_user" { type = string, default = "bingo_admin" }
variable "tags" { type = map(string), default = {} }

terraform {
  required_providers { random = { source = "hashicorp/random", version = "~> 3.6" } }
}

# Admin credential is generated per apply and never hardcoded; production
# rotates it from Key Vault secrets (the TODO of the first scaffold, closed).
resource "random_password" "admin" {
  length  = 32
  special = true
  override_special = "!#$%&*()-_=+[]{}:,.?"
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                   = var.name
  resource_group_name    = var.rg
  location               = var.location
  version                = "16"
  administrator_login    = var.admin_user
  administrator_password = random_password.admin.result
  storage_mb             = 32768
  sku_name               = "GP_Standard_D2ds_v4"
  zone                   = "1"
  high_availability { mode = "ZoneRedundant" }
  backup_retention_days        = 14
  geo_redundant_backup_enabled = false # demo phase; revisit at B2B pilot
  delegated_subnet_id          = var.data_subnet_id
  private_dns_zone_id          = null # supplied via private_dns_zone_id in real envs
  tags                         = var.tags
}

resource "azurerm_postgresql_flexible_server_configuration" "rls_guard" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = "PGCRYPTO"
}
# pgcrypto backs the AES-GCM phone envelope + blind index (FR-SEC-01).

output "fqdn" { value = azurerm_postgresql_flexible_server.this.fqdn }
output "admin_password" { value = random_password.admin.result, sensitive = true }
