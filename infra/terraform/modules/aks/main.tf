# aks — minimal managed Kubernetes per architecture v5.0 §11.2:
# two system-pool nodes, autoscaled app pool, no service mesh (explicitly
# out of MVP scope). Blue-green ingress rotation is chart-level (ADR-13).
variable "name" { type = string }
variable "location" { type = string }
variable "rg" { type = string }
variable "aks_subnet_id" { type = string }
variable "k8s_version" { type = string, default = "1.30" }
variable "app_nodes" { type = number, default = 2 }
variable "tags" { type = map(string), default = {} }

resource "azurerm_kubernetes_cluster" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.rg
  dns_prefix          = var.name
  kubernetes_version  = var.k8s_version
  sku_tier            = "Standard"
  tags                = var.tags

  default_system_pool {
    name                  = "sys"
    node_count            = 2
    vm_size               = "Standard_B2ms"
    vnet_subnet_id        = var.aks_subnet_id
    only_critical_addons_enabled = true
  }

  identity { type = "SystemAssigned" }

  network_profile {
    network_plugin = "azure"
    load_balancer_sku = "standard"
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "app" {
  name                  = "app"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = "Standard_D4s_v5"
  node_count            = var.app_nodes
  vnet_subnet_id        = var.aks_subnet_id
  auto_scaling_enabled  = true
  min_count             = 2
  max_count             = 6
  orchestrator_version  = var.k8s_version
  tags                  = var.tags
}

output "kubeconfig" { value = azurerm_kubernetes_cluster.this.kube_config_raw, sensitive = true }
output "oidc_issuer" { value = azurerm_kubernetes_cluster.this.oidc_issuer_url }
