# dev — smallest lawful footprint; data planes live in compose, TF only proves
# the modules compile and provides the RG scaffold for the latency rig.
terraform {
  backend "azurerm" {
    resource_group_name  = "bingo-tfstate"
    storage_account_name = "bingotfstate"
    container_name       = "tfstate"
    key                  = "dev.terraform.tfstate"
  }
  required_providers { azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" } }
}

provider "azurerm" { features {} }

variable "location" { type = string, default = "swedencentral" }
variable "suffix" { type = string, default = "dev" }

resource "azurerm_resource_group" "this" {
  name     = "bingo-${var.suffix}"
  location = var.location
}

module "network" {
  source   = "../../modules/network"
  name     = "bingo-${var.suffix}-vnet"
  rg       = azurerm_resource_group.this.name
  location = var.location
  cidr     = "10.40.0.0/16"
}

output "rg" { value = azurerm_resource_group.this.name }
output "aks_subnet" { value = module.network.aks_subnet_id }
