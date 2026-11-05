# Terraform — provisions existence; Helm deploys versions (ADR-27)
#
#   envs/dev → envs/staging → envs/demo   (demo == M4 go-live environment)
#
# Layout: one module per infrastructure concern; envs compose modules and own
# state. Remote state in Azure Storage (per-env containers, locking enabled).
# Regions under test for the Ethiopia latency envelope (1.6 Mbps / 150 ms RTT
# design point, SRS §1.4): swedencentral (staging), southafricanorth and
# uae north candidates — decision recorded when the latency rig lands (S6–S7).

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}
