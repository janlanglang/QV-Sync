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
- Extension updaten (VSIX installieren) und VS Code neu laden.
- Command Palette öffnen: Strg+Shift+P.

- `ERP Dashboard Sync: Initialize Workspace`
	- Prompts for dashboard name.
	- Saves local config.
	- Downloads and generates files.
- `ERP Dashboard Sync: Reload From ERP`
	- Uses existing config and reloads all generated files.
- `ERP Dashboard Sync: Set Credentials (Secret Storage)`
  - Stores NTLM username/password/domain/workstation securely in VS Code Secret Storage.
- `ERP Dashboard Sync: Clear Credentials (Secret Storage)`
  - Removes stored credentials from VS Code Secret Storage.

## Extension Settings

- `erpDashboardSync.dbFetchJsonUrl`
- `erpDashboardSync.xmlUpdateOfflineSoapUrl`
- Update-Transport ist fest auf SOAP 1.2.
- `erpDashboardSync.authMode` (`none` or `ntlm`)
- `erpDashboardSync.autoSyncOnSave`
- `erpDashboardSync.configFileName`
- `erpDashboardSync.indexFileName`
- `erpDashboardSync.generatedRootDir`

## Authentication

For environments where Postman requires NTLM, configure:

- `erpDashboardSync.authMode = ntlm`
- Preferred: run `ERP Dashboard Sync: Set Credentials (Secret Storage)`
- Fallback: `erpDashboardSync.authUsername` / `erpDashboardSync.authPassword`
- optional domain/workstation fields

Credential precedence:

1. Secret Storage credentials (recommended)
2. Plain settings (`authUsername` / `authPassword` / `authDomain` / `authWorkstation`) as fallback

## Development

- Compile: `npm run compile`
- Watch: `npm run watch`
- Lint: `npm run lint`

## Build VSIX / Distribution

- One-command release (version bump + compile + package): `npm run release:vsix`
- Package only (no version bump): `npm run release:vsix:no-bump`
- Raw package command: `npm run package:vsix`

The generated `.vsix` file can be installed on another machine with:

- VS Code UI: Extensions view -> `...` -> `Install from VSIX...`
- CLI: `code --install-extension <path-to-vsix>`

## JSON Webservice Beispiel:

```csharp
[WebMethod]
public string dbFetchJSON(string sql)
{
  xmlDB x;
  string ret;


  WebUtils.checkSQL(sql);
  x = new xmlDB("Artikel", sql);
  try
  {
    ret = x.GetRowsAsJson();
  }
  finally
  {
    x.Close();
  }
  return (ret);
} // dbFetchJSON
```

### DB Anpassung für Versionsfeld in QVDashboard:

```
<?xml version="1.0" encoding="UTF-8" ?>
<dbchange xmlns="http://schemas.p2plus.com/P2plus40/dbChangeSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://schemas.p2plus.com/P2plus40/dbChangeSchema dbChangeSchema.xsd">
  <createLogFile>dbchlog_20260518.txt</createLogFile>
  <!--JLANGENBERG 18.05.2026-->
  <addField>
    <table>QVDASHBOARD</table>
    <name>ANP_VERSION</name>
    <type>int</type>
    <description/>
  </addField>
  <closeLogFile/>
</dbchange>

```

### Anpassung WebProject/WebServer/Quickviews/DashboardTransfer.aspx

ab Zeile 286
```csharp
else if (table == "QVDASHBOARD" && cmd == "modify") {
  versionLocal = Int32.Parse(WebUtils.getSimpleScalarValue(table, "ANP_VERSION", keyCol, key) ?? "0");
  versionImport = (xRecord.SelectSingleNode("ANP_VERSION") == null ? 0 : Int32.Parse(xRecord.SelectSingleNode("ANP_VERSION").InnerText ?? "0"));
  isNewVersion = versionLocal == 0 || versionImport > versionLocal;
}
```