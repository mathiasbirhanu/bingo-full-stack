# registry — ACR for the two deployables (web, room-events).
variable "name" { type = string }
variable "rg" { type = string }
variable "location" { type = string }
variable "tags" { type = map(string), default = {} }

resource "azurerm_container_registry" "this" {
  name                = var.name
  resource_group_name = var.rg
  location            = var.location
  sku                 = "Standard"
  admin_enabled       = false
  tags                = var.tags
}

output "login_server" { value = azurerm_container_registry.this.login_server }
