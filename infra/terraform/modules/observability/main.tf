# observability — Log Analytics + Container Insights; Prometheus itself runs
# kube-prometheus-stack in-cluster (ADR-29). App Insights stays an optional
# OTel exporter switch, never a hard dependency.
variable "name" { type = string }
variable "rg" { type = string }
variable "location" { type = string }
variable "tags" { type = map(string), default = {} }

resource "azurerm_log_analytics_workspace" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.rg
  retention_in_days   = 30
  tags                = var.tags
}

output "workspace_id" { value = azurerm_log_analytics_workspace.this.workspace_id }
