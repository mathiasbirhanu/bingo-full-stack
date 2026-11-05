# network — VNet, subnets (aks / postgres private endpoint), NSG baseline.
variable "name" { type = string }
variable "cidr" { type = string }
variable "location" { type = string }
variable "rg" { type = string }
variable "tags" { type = map(string), default = {} }

resource "azurerm_virtual_network" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.rg
  address_space       = [var.cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "snet-aks"
  resource_group_name  = var.rg
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.cidr, 4, 0)]
}

resource "azurerm_subnet" "data" {
  name                 = "snet-data"
  resource_group_name  = var.rg
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.cidr, 4, 1)]
  # Private endpoints for PostgreSQL Flexible Server + Redis Premium.
  private_endpoint_network_policies = "Enabled"
}

output "aks_subnet_id" { value = azurerm_subnet.aks.id }
output "data_subnet_id" { value = azurerm_subnet.data.id }
