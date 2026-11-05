# staging — full managed footprint (Delivery Plan S2–S3).
# Terraform provisions existence; Helm deploys versions (ADR-27).
terraform {
  backend "azurerm" {
    resource_group_name  = "bingo-tfstate"
    storage_account_name = "bingotfstate"
    container_name       = "tfstate"
    key                  = "staging.terraform.tfstate"
  }
  required_providers { azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" } }
}

provider "azurerm" { features {} }

variable "location" { type = string, default = "swedencentral" }
variable "suffix" { type = string, default = "staging" }

locals {
  tags = {
    project = "bingo-platform"
    env     = var.suffix
    managed = "terraform"
  }
}

resource "azurerm_resource_group" "this" {
  name     = "bingo-${var.suffix}"
  location = var.location
  tags     = local.tags
}

module "network" {
  source   = "../../modules/network"
  name     = "bingo-${var.suffix}-vnet"
  rg       = azurerm_resource_group.this.name
  location = var.location
  cidr     = "10.41.0.0/16"
}

module "aks" {
  source        = "../../modules/aks"
  name          = "bingo-${var.suffix}-aks"
  rg            = azurerm_resource_group.this.name
  location      = var.location
  aks_subnet_id = module.network.aks_subnet_id
  app_nodes     = 2 # staging sizing; demo scales to 3 (ADR-27 §sizing)
  tags          = local.tags
}

module "postgres" {
  source        = "../../modules/postgres"
  name          = "bingo-${var.suffix}-pg"
  rg            = azurerm_resource_group.this.name
  location      = var.location
  data_subnet_id = module.network.data_subnet_id
  tags          = local.tags
}

module "redis" {
  source        = "../../modules/redis"
  name          = "bingo-${var.suffix}-redis"
  rg            = azurerm_resource_group.this.name
  location      = var.location
  data_subnet_id = module.network.data_subnet_id
  sku           = "P1" # managed Premium per infra decision; dev self-hosts in compose
  tags          = local.tags
}

module "registry" {
  source   = "../../modules/registry"
  name     = "bingo${var.suffix}acr"
  rg       = azurerm_resource_group.this.name
  location = var.location
  tags     = local.tags
}

module "observability" {
  source   = "../../modules/observability"
  name     = "bingo-${var.suffix}-obs"
  rg       = azurerm_resource_group.this.name
  location = var.location
  tags     = local.tags
}

output "rg" { value = azurerm_resource_group.this.name }
output "kubeconfig" { value = module.aks.kubeconfig, sensitive = true }
output "oidc_issuer" { value = module.aks.oidc_issuer }
output "postgres_fqdn" { value = module.postgres.fqdn }
output "redis_hostname" { value = module.redis.hostname }
output "redis_key" { value = module.redis.primary_key, sensitive = true }
output "acr_login_server" { value = module.registry.login_server }
output "log_workspace_id" { value = module.observability.workspace_id }
