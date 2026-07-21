# ERP Dashboard Sync

VS Code extension to synchronize APplus Quickview and Flowboard sources with local files.

## What It Does

- Initializes one workspace for one context type:
  - Quickview by dashboard name (for example `wss_001`)
  - Flow by GUID
- Loads data via `dbFetchJSON` and generates local files:
  - Quickview: `.js`, `.css`, and for query rows `.sql`
  - Flow: `.xml`, `.js`, `.sql`
- Writes a local index file mapping each generated file to ERP table/field/GUID.
- On save, writes changed content back via SOAP `xmlUpdateOffline`.
- Handles version updates with context-specific logic (Quickview and Flow).
- Optional startup reload: if a workspace is already linked, the extension can ask once and reload latest ERP state.

## Generated Workspace Files

- `.erp-dashboard-sync.json`: workspace configuration (`contextType`, identifier and version prompt state).
- `.erp-dashboard-sync-index.json`: mapping of local files to ERP table/field/GUID.
- `erp-dashboard/quickview/<dashboardId>/...`: generated Quickview files.
- `erp-dashboard/flow/<flowGuid>/...`: generated Flow files.

## Voraussetzungen

- Zugriff auf APplus-Endpunkte:
  - `dbFetchJSON`
  - SOAP endpoint fuer `xmlUpdateOffline`
- Korrekte Authentifizierung (typisch `ntlm`) inklusive Credentials.
- In VS Code muss ein Ordner als Workspace geoeffnet sein.

## Neuer Workspace und erster Abruf

1. In VS Code einen neuen Ordner fuer die Bearbeitung anlegen und oeffnen.
2. Extension installieren/aktualisieren und VS Code neu laden.
3. Optional zuerst Credentials setzen:
   - Command Palette: `ERP Dashboard Sync: Set Credentials (Secret Storage)`
4. Erstinitialisierung starten:
   - Command Palette: `ERP Dashboard Sync: Initialize Workspace`
5. Im Dialog den Typ waehlen:
   - `Quickview`
   - `Flow`
6. Identifier eingeben:
   - Quickview: `QVDASHBOARD` Name
   - Flow: `GUID`
7. Extension legt Konfigurationsdateien an und laedt die Dateien aus ERP.

Hinweis:
- Fuer einen spaeteren manuellen Komplettabgleich: `ERP Dashboard Sync: Reload From ERP`.

## Commands
- Extension updaten (VSIX installieren) und VS Code neu laden.
- Command Palette oeffnen: Strg+Shift+P.

- `ERP Dashboard Sync: Initialize Workspace`
	- Fragt zuerst den Typ (`Quickview` oder `Flow`), dann den Identifier.
	- Speichert lokale Konfiguration.
	- Laedt ERP-Daten und erzeugt Arbeitsdateien.
- `ERP Dashboard Sync: Reload From ERP`
	- Verwendet bestehende Konfiguration und laedt alle generierten Dateien neu.
	- Sinnvoll als manueller Refresh bei Aenderungen direkt in ERP.
- `ERP Dashboard Sync: Set Credentials (Secret Storage)`
  - Speichert NTLM username/password/domain/workstation sicher im VS Code Secret Storage.
- `ERP Dashboard Sync: Clear Credentials (Secret Storage)`
  - Entfernt gespeicherte Credentials aus VS Code Secret Storage.
- `ERP Dashboard Sync: Reset Version Prompt State`
  - Loescht gespeicherte Tagesentscheidungen fuer die Versionierungsabfragen (Quickview/Flow).

## Extension Settings

- `erpDashboardSync.dbFetchJsonUrl`
- `erpDashboardSync.xmlUpdateOfflineSoapUrl`
- `erpDashboardSync.verboseLogging`
- Empfehlung: `xmlUpdateOfflineSoapUrl` als expliziten Methoden-Endpunkt setzen (`.../utils.asmx/xmlUpdateOffline`).
- Kompatibilitaet: `.../utils.asmx` funktioniert weiterhin; die Extension probiert intern beide Varianten.
- Update-Transport ist fest auf SOAP 1.2.
- `erpDashboardSync.authMode` (`none` or `ntlm`)
- `erpDashboardSync.autoSyncOnSave`
- `erpDashboardSync.reloadOnStartup`
- `erpDashboardSync.reloadOnStartupPrompt`
- `erpDashboardSync.configFileName`
- `erpDashboardSync.indexFileName`
- `erpDashboardSync.generatedRootDir`

### Logging

- Standardmaessig schreibt die Extension kompakte Logs mit Zeitstempel in den Output-Channel `ERP Dashboard Sync`.
- `erpDashboardSync.verboseLogging = true` schaltet ausfuehrliche Debug-Logs zu.
- In diesem Modus werden auch komplette SQL-Abfragen, SOAP-Payloads und rohe ERP-Antworten geloggt.
- Empfehlung: Nur temporaer fuer Fehlersuche aktivieren, weil die Log-Ausgabe deutlich groesser wird.

## Versionierungslogik

### Quickview

- Gespeicherte Version wird aus `QVQUERY.VERSION` bzw. `QVDASHBOARD.ANP_VERSION` gelesen.
- Bei Save wird der Inhalt plus Versionsfeld zusammen in einem SOAP-Update geschrieben.
- Wenn der aktuelle Versionswert ein gueltiges `YYYYMMDD` ist:
  - Es wird ohne Rueckfrage automatisch auf das heutige Datum gesetzt.
- Wenn der aktuelle Versionswert kein `YYYYMMDD` ist:
  - Es wird maximal einmal pro Tag nach einem neuen Versionsstand gefragt.
  - Im Prompt wird der aktuelle Wert als Referenz angezeigt.
  - Weitere Saves am selben Tag verwenden den bereits eingegebenen Wert.

### Flow

- Flow-Inhalte werden in `FLOWBOARD` gespeichert:
  - `XMLDEFINITION`
  - `JAVASCRIPT`
  - `SQLSTATEMENT`
- Version wird als drei Felder behandelt:
  - `MAJORVERSION`
  - `MINORVERSION`
  - `PATCHVERSION`
- Wenn die aktuelle Flow-Version dem Datumsprinzip entspricht (`YYYY.MM.DD`):
  - Automatisches Update auf aktuelles Datum (`YYYY`, `MM`, `DD`) ohne Rueckfrage.
- Wenn die Version nicht dem Datumsprinzip entspricht:
  - Maximal einmal pro Tag Auswahl, welcher Teil erhoeht wird (`major`, `minor`, `fix`).
  - Danach automatische Wiederverwendung am selben Tag.
  - Der bestehende Versionsstand wird als Referenz im Prompt angezeigt.

### Tagesstatus zuruecksetzen

- Falls am selben Tag eine neue Entscheidung erzwungen werden soll:
  - Command `ERP Dashboard Sync: Reset Version Prompt State` ausfuehren.

## ANP_VERSION Fallback beim Laden

- Beim Quickview-Reload wird zunaechst SQL mit `ANP_VERSION` verwendet.
- Falls `ANP_VERSION` serverseitig noch nicht verfuegbar ist, erfolgt ein automatischer Retry ohne `ANP_VERSION`.

## Startup Auto Reload

- `erpDashboardSync.reloadOnStartup = true` (default): when a linked dashboard exists in `.erp-dashboard-sync.json`, startup reload is enabled.
- `erpDashboardSync.reloadOnStartupPrompt = true` (default): show a short prompt (`Laden` / `Nicht jetzt`) before startup reload.
- Set `reloadOnStartupPrompt = false` for fully automatic reload on startup.

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