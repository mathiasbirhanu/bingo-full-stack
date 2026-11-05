# redis — Premium P1 in VNet (staging/demo); dev runs compose redis instead.
variable "name" { type = string }
variable "rg" { type = string }
variable "location" { type = string }
variable "data_subnet_id" { type = string }
variable "sku" { type = string, default = "P1" }
variable "tags" { type = map(string), default = {} }

resource "azurerm_redis_cache" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.rg
  capacity            = 1          # P1: 6 GB
  family              = "P"
  sku_name            = "Premium"
  minimum_tls_version = "1.2"
  subnet_id           = var.data_subnet_id
  tags                = var.tags
  redis_configuration {
    maxmemory_policy = "noeviction" # AP-04: never silently evict streams
  }
}

output "hostname" { value = azurerm_redis_cache.this.hostname }
output "primary_key" { value = azurerm_redis_cache.this.primary_access_key, sensitive = true }
