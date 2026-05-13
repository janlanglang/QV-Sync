# ERP Dashboard Sync

VS Code extension to synchronize APplus dashboard/query JS and CSS sources with local files.

## What It Does

- Initializes the workspace for one dashboard (for example `wss_001`).
- Executes `dbFetchJSON` with the SQL query and creates local `.js` and `.css` files.
- Writes a local index file that maps each generated file to `QVQUERY` or `QVDASHBOARD` rows.
- On save, updates `JSPAGESCRIPT` or `CSSSTYLE` via `xmlUpdateOffline`.

## Generated Workspace Files

- `.erp-dashboard-sync.json`: dashboard configuration (initially stores `dashboardId`).
- `.erp-dashboard-sync-index.json`: mapping of local files to ERP table/field/GUID.
- `erp-dashboard/<dashboardId>/...`: generated JavaScript and CSS files.

## Commands

- `ERP Dashboard Sync: Initialize Workspace`
	- Prompts for dashboard name.
	- Saves local config.
	- Downloads and generates files.
- `ERP Dashboard Sync: Reload From ERP`
	- Uses existing config and reloads all generated files.

## Extension Settings

- `erpDashboardSync.dbFetchJsonUrl`
- `erpDashboardSync.xmlUpdateOfflineSoapUrl`
- `erpDashboardSync.xmlUpdateOfflineHttpUrl`
- `erpDashboardSync.updateTransport` (`soap12` or `httpPost`)
- `erpDashboardSync.authMode` (`none` or `ntlm`)
- `erpDashboardSync.authUsername`
- `erpDashboardSync.authPassword`
- `erpDashboardSync.authDomain`
- `erpDashboardSync.authWorkstation`
- `erpDashboardSync.autoSyncOnSave`
- `erpDashboardSync.configFileName`
- `erpDashboardSync.indexFileName`
- `erpDashboardSync.generatedRootDir`

## Authentication

For environments where Postman requires NTLM, configure:

- `erpDashboardSync.authMode = ntlm`
- `erpDashboardSync.authUsername`
- `erpDashboardSync.authPassword`
- optional domain/workstation fields

## Development

- Compile: `npm run compile`
- Watch: `npm run watch`
- Lint: `npm run lint`
