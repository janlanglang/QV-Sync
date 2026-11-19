# ERP Dashboard Sync

VS-Code-Erweiterung zum Synchronisieren von APplus-Quickviews und -Flowboards mit lokalen Dateien.

## Skill
**Copilot-Skill ausprobieren:** Öffne Copilot Chat nach der Installation der
Extension. In unterstützten VS-Code-Versionen kannst du `/erp-dashboard-sync`
aufrufen oder Copilot den Skill passend zur Aufgabe laden lassen:

**`/erp-dashboard-sync Prüfe den PARAMSTRING dieser indizierten Query zusammen mit SQL und OPTIONS. Erkläre den passenden Filter und ändere nichts, was ungefragt ins ERP hochladen könnte.`**

**Weitere Beispiele:** **`/erp-dashboard-sync Erweitere das Flowboard: prüfe zuerst SQL/XML/JavaScript und die Bindungen im vorhandenen Flow.`** · **`/erp-dashboard-sync Erkläre, welche ERP-Zuordnung diese materialisierte Datei hat und ob ihr Speichern automatisch synchronisiert.`**


Die Erweiterung trägt den Skill `erp-dashboard-sync` für Copilot Chat bei.
Er enthält Hinweise zu Datei-/ERP-Feldzuordnungen, Quickview- und Flow-
Kontexten sowie zur sicheren Bearbeitung der materialisierten Dateien. Dazu
werden vertiefende Referenzen für Plugin-Sync, Quickviews, Flowboards,
ERP-Datenzugriffe, anonymisierte Beispielmuster und Projektdokumentation
mitgeliefert. Copilot kann ihn bei passenden Aufgaben automatisch laden; in
unterstützten VS-Code-Versionen ist er außerdem über die Skill-Auswahl
beziehungsweise Slash-Befehle verfügbar. Die Skill-Unterstützung hängt von
der installierten VS-Code-/Copilot-Version und dem verwendeten Chat-Harness
ab.

## Funktionen

- Unterstützt mehrere unabhängige Dashboard-Ordner in einem gemeinsamen übergeordneten Ordner oder einem Multi-Root-Workspace:
  - Quickview über den Dashboard-Namen, zum Beispiel `wss_001`
  - Flow über die GUID
- Lädt Daten über `dbFetchJSON` und erzeugt lokale Dateien:
  - Quickview: `.js`, `.css` und bei Query-Datensätzen zusätzlich `.sql` sowie `.options.xml`
  - Dashboard-Query-Zuordnungen: `.paramstring.txt`, `.jschartscript.js`, `.chartoptions.js`
  - Flow: `.xml`, `.js`, `.sql`
- Ordnet jede erzeugte Datei über einen lokalen Index einer ERP-Tabelle, einem Feld und einer GUID zu.
- Überträgt Änderungen beim Speichern im Editor oder bei externen Dateiänderungen über SOAP `xmlUpdateOffline` zurück ins ERP.
- Aktualisiert Versionen nach den jeweiligen Regeln für Quickview und Flow.
- Kann beim Start für jeden verknüpften Dashboard-Ordner nachfragen und den aktuellen ERP-Stand laden.

## Erzeugte Dateien

Die Pfade beziehen sich jeweils auf den zugehörigen Dashboard-Ordner. Der Stammordner `erp-dashboard` ist über `generatedRootDir` konfigurierbar.

- `.erp-dashboard-sync.json`: lokale Konfiguration mit Kontexttyp (`contextType`), Kennung (`dashboardId`) und gespeicherten Versionsentscheidungen.
- `.erp-dashboard-sync-index.json`: Zuordnung der lokalen Dateien zu ERP-Tabelle, Feld und GUID.
- `erp-dashboard/<dashboardId>/query/...`: Dateien der Quickview-Queries.
- `erp-dashboard/<dashboardId>/dashboard/...`: Dateien des Quickview-Dashboards.
- `erp-dashboard/<dashboardId>/dashboard-query/...`: Dateien der Dashboard-Query-Zuordnungen.
- `erp-dashboard/<flowGuid>/<datensatzGuid>/...`: Dateien eines Flow-Datensatzes.

## Voraussetzungen

- Zugriff auf APplus-Endpunkte:
  - `dbFetchJSON`
  - SOAP-Endpunkt für `xmlUpdateOffline`
- Korrekte Authentifizierung, üblicherweise `ntlm`, einschließlich Zugangsdaten.
- In VS Code muss mindestens ein Ordner als Arbeitsbereich geöffnet sein.

## Neuer Arbeitsbereich und erster Abruf

1. In VS Code einen neuen Ordner für die Bearbeitung anlegen und öffnen.
2. Die Erweiterung installieren oder aktualisieren und VS Code neu laden.
3. Optional zuerst Zugangsdaten setzen:
   - Befehlspalette: `ERP Dashboard Sync: Set Credentials (Secret Storage)`
4. Erstinitialisierung starten:
   - Befehlspalette: `ERP Dashboard Sync: Initialize Workspace`
   - Die Erweiterung setzt bei Bedarf fehlende Ordnereinstellungen automatisch:
     - `erpDashboardSync.dbFetchJsonUrl`
     - `erpDashboardSync.xmlUpdateOfflineSoapUrl`
     - `erpDashboardSync.authMode = ntlm`
     - `erpDashboardSync.tlsAllowInsecure = true`
   - Wenn bei `authMode = ntlm` Benutzername oder Passwort fehlen, werden die Zugangsdaten zuerst abgefragt.
5. Den Dashboard-Ordner und den Typ wählen:
   - `Quickview`
   - `Flow`
6. Die Kennung eingeben:
   - Quickview: Name aus `QVDASHBOARD`
   - Flow: `GUID`
7. Die Erweiterung legt die Konfigurationsdateien an und lädt die Arbeitsdateien aus dem ERP.

Hinweis:
- Für einen späteren manuellen Komplettabgleich: `ERP Dashboard Sync: Reload From ERP`.

## Mehrere Dashboards

Vorhandene Dashboard-Ordner lassen sich ohne erneute Initialisierung gemeinsam verwenden:

```text
hauptordner
  dashboard-a
    .erp-dashboard-sync.json
    .erp-dashboard-sync-index.json
    erp-dashboard
  dashboard-b
    .erp-dashboard-sync.json
    .erp-dashboard-sync-index.json
    erp-dashboard
```

- Entweder `hauptordner` öffnen oder `dashboard-a` und `dashboard-b` als eigene Ordner zu einem Multi-Root-Workspace hinzufügen.
- Die Erweiterung findet vorhandene Sync-Konfigurationen auch in verschachtelten Dashboard-Ordnern. `node_modules` und `.git` werden bei dieser Suche ausgeschlossen.
- Vorhandene Indizes werden an ihrem bisherigen Ort weiterverwendet. Ihre Pfade bleiben relativ zum ursprünglichen Dashboard-Ordner, nicht zum übergeordneten Arbeitsbereich. Für das Zusammenfassen ist keine Migration oder Neuerzeugung nötig.
- Für Uploads bestimmt die nächstgelegene übergeordnete Dashboard-Konfiguration innerhalb des geöffneten Arbeitsbereichsordners den Kontext. Bei einem fehlenden Index, einer ungültigen Konfiguration oder einer nicht indizierten Datei wird niemals auf den Index eines anderen Dashboards ausgewichen.
- Bei mehreren Zielen zeigen die Befehle eine Dashboard-Auswahl. `Reload From ERP` bietet zusätzlich **Alle Dashboards neu laden**. Ein fehlgeschlagener Abruf verhindert nicht, dass die übrigen ausgewählten Dashboards verarbeitet werden.
- `Initialize Workspace` bietet vorhandene Dashboard- und Arbeitsbereichsordner sowie **Anderen Dashboard-Ordner waehlen...** für neue Kontexte an. Vorhandene Dashboards müssen zum Einbinden in einen übergeordneten Arbeitsbereich nicht neu initialisiert werden.
- Der Abruf beim Start berücksichtigt jeden gefundenen Kontext und dessen wirksame Einstellungen einzeln. Eine abgelehnte Rückfrage überspringt nicht die übrigen Kontexte.
- Konfiguration, erzeugte Dateien, Indexänderungen und Versionsentscheidungen bleiben im jeweiligen Dashboard-Ordner.
- Auch die Befehle zum Setzen oder Löschen von Zugangsdaten und zum Zurücksetzen der Versionsentscheidungen bieten eine Ordnerauswahl. Vorhandene Zugangsdaten im Secret Storage bleiben nutzbar, solange der Dashboard-Ordner am gleichen absoluten Pfad liegt.
- In Multi-Root-Workspaces lassen sich die Erweiterungseinstellungen pro Ordner überschreiben. Ist nur ein übergeordneter Ordner geöffnet, erben die verschachtelten Dashboards dessen Einstellungen: VS Code lädt untergeordnete `.vscode/settings.json` und Einstellungen aus eingebetteten `.code-workspace`-Dateien nicht automatisch. Für getrennte Ordnereinstellungen die tatsächlichen Dashboard-Verzeichnisse als eigene Arbeitsbereichsordner hinzufügen. Einstellungen aus bisherigen separaten Arbeitsbereichsdateien bei Bedarf in die Ordnereinstellungen oder den gemeinsamen Arbeitsbereich übertragen.

## Query-Optionen

`QVQUERY.OPTIONS` wird beim ERP-Abruf als `<queryname>__<optionalerTitel>__<queryGuid>.options.xml` unter `erp-dashboard/<dashboardId>/query/` angelegt. Der Titel entfällt, wenn er leer ist.

- Der Inhalt ist unverändertes XML, ohne zusätzliche Kodierung oder Formatierung. Leere Werte und `NULL` ergeben eine leere Datei. Die Maskierung für den SOAP-Transport verändert den zurückgeschriebenen XML-Feldwert nicht.
- Beim Speichern oder bei externen Änderungen wird `OPTIONS` über die Query-GUID nach `QVQUERY` zurückgeschrieben. Wie bei den übrigen Query-Dateien wird dabei auch `QVQUERY.VERSION` aktualisiert.
- Vorhandene Projekte benötigen die Datei zunächst nicht. **Reload From ERP** erzeugt die Datei und ihren Indexeintrag; fehlende Optionsdateien blockieren keine anderen Uploads.

## Felder der Dashboard-Query-Zuordnung

Beim erneuten Laden eines Quickviews werden auch diese Felder aus `QVDASHBOARDQUERY` als Dateien angelegt:

| Feld | Dateiendung |
| --- | --- |
| `PARAMSTRING` | `.paramstring.txt` |
| `JSCHARTSCRIPT` | `.jschartscript.js` |
| `CHARTOPTIONS` | `.chartoptions.js` |

- Die Dateien liegen unter `erp-dashboard/<dashboardId>/dashboard-query/`. Ihre Namen enthalten den Query-Namen, einen optionalen Titel und die **GUID der Zuordnung**. Auch bei mehrfacher Verwendung derselben Query entstehen getrennte Dateien.
- Die Inhalte bleiben unveränderter Text, ohne JSON-Prüfung, Formatierung oder zusätzliche JavaScript-Hülle. Leere Werte und `NULL` ergeben leere Dateien.
- Speichern im Editor und externe Dateiänderungen übertragen ausschließlich das geänderte Feld nach `QVDASHBOARDQUERY`. Verwendet wird die eigene `GUID` der Zuordnung, niemals `QVQUERY.GUID`.
- Die Zuordnung hat kein eigenes Versionsfeld. Bei Änderungen wird zusätzlich `QVDASHBOARD.ANP_VERSION` des übergeordneten Dashboards nach der bestehenden Quickview-Versionslogik geprüft und aktualisiert. Der Dashboard-Datensatz wird aus dem Index desselben Kontexts ermittelt; fehlt er oder ist die Zuordnung nicht eindeutig, ist zunächst **Reload From ERP** erforderlich.
- Eine notwendige Versionsrückfrage erscheint vor dem Upload. Bei Abbruch werden weder Inhalt noch Dashboard-Version übertragen. Inhalt und Dashboard-Version werden in getrennten SOAP-Anfragen gespeichert; schlägt die Versionsaktualisierung nach dem Inhaltsupload fehl, erscheint ein ausdrücklicher Fehler. Die Datei gilt erst nach beiden erfolgreichen Schritten als synchronisiert und kann durch erneutes Speichern wiederholt werden.
- Bestehende Projekte und Indizes funktionieren auch vor einem erneuten Abruf. Die neuen Dateien und Indexeinträge sind keine Voraussetzung: **Reload From ERP** legt sie an. Eine erneute Initialisierung ist nicht nötig.
- Fehlende neue Dateien blockieren keine Uploads anderer indizierter Dateien. Ein späterer Abruf erzeugt sie erneut. Nicht vorhandene oder nicht indizierte Inhalte werden nicht automatisch hochgeladen.

## Befehle

Nach einer Aktualisierung die neue VSIX installieren und VS Code neu laden. Die Befehlspalette wird mit **Strg+Umschalt+P** geöffnet.

- `ERP Dashboard Sync: Initialize Workspace`
  - Wählt den Dashboard-Ordner, fragt dann Typ (`Quickview` oder `Flow`) und Kennung.
  - Speichert die lokale Konfiguration.
  - Lädt ERP-Daten und erzeugt Arbeitsdateien.
- `ERP Dashboard Sync: Reload From ERP`
  - Verwendet die bestehende Konfiguration und lädt alle erzeugten Dateien neu.
  - Erkennt umbenannte Queries und Dashboards anhand ihrer GUID, benennt die verwalteten Dateien entsprechend um und entfernt die alten Dateipfade.
  - Bietet bei mehreren Kontexten eine Dashboard-Auswahl oder das Laden aller Dashboards an.
  - Dient dem manuellen Abgleich nach Änderungen direkt im ERP.
- `ERP Dashboard Sync: Set Credentials (Secret Storage)`
  - Speichert NTLM-Benutzername, Passwort und Domäne sicher im Secret Storage von VS Code.
  - Gilt wahlweise für den ausgewählten Dashboard-Ordner oder global für alle Arbeitsbereiche.
- `ERP Dashboard Sync: Clear Credentials (Secret Storage)`
  - Entfernt gespeicherte Zugangsdaten aus dem Secret Storage von VS Code.
- `ERP Dashboard Sync: Reset Version Prompt State`
  - Löscht gespeicherte Tagesentscheidungen für die Versionsabfragen von Quickview und Flow.

## Einstellungen der Erweiterung

- `erpDashboardSync.dbFetchJsonUrl`
- `erpDashboardSync.xmlUpdateOfflineSoapUrl`
- `erpDashboardSync.verboseLogging`
- Empfehlung: `xmlUpdateOfflineSoapUrl` als expliziten Methoden-Endpunkt setzen (`.../utils.asmx/xmlUpdateOffline`).
- Kompatibilität: `.../utils.asmx` funktioniert weiterhin; die Erweiterung probiert intern beide Varianten.
- Der Übertragungsweg für Aktualisierungen ist fest auf SOAP 1.2 eingestellt.
- `erpDashboardSync.authMode` (`none` oder `ntlm`)
- `erpDashboardSync.autoSyncOnSave`
- `erpDashboardSync.reloadOnStartup`
- `erpDashboardSync.reloadOnStartupPrompt`
- `erpDashboardSync.configFileName`
- `erpDashboardSync.indexFileName`
- `erpDashboardSync.generatedRootDir`

### Automatische Uploads

- `erpDashboardSync.autoSyncOnSave` ist standardmäßig `true`. Die Einstellung steuert sowohl das Speichern im Editor als auch externe Dateiänderungen, beispielsweise durch Copilot oder Claude.
- Nur im lokalen Index zugeordnete Dateien werden hochgeladen. Der Sprachmodus im Editor spielt keine Rolle.
- Änderungen werden pro Datei für 300 ms zusammengefasst. Uploads und ERP-Abrufe laufen nacheinander, damit gemeinsam genutzte Index- und Versionsdaten konsistent bleiben.
- Hochgeladen wird der auf der Festplatte gespeicherte Inhalt, niemals eine ungespeicherte Editoränderung. Weitere Änderungen während eines Uploads werden eingereiht.
- Ein SHA-256-Inhaltshash im Index verhindert doppelte Uploads und das Zurückladen unveränderter Dateien, die gerade aus dem ERP erzeugt wurden.
- Vorhandene Indizes ohne Hashes bleiben unterstützt. Die erste nachfolgende Änderung oder Speicherung überträgt die Datei und ergänzt ihren Hash.
- Es gibt keinen nachträglichen Offline-Abgleich beim Start. Änderungen bei geschlossenem VS Code werden nicht automatisch hochgeladen.
- Ein fehlgeschlagener oder abgebrochener Upload markiert den Inhalt nicht als synchronisiert. Zum Wiederholen erneut speichern. Auslöser, übersprungene Dateien und Fehler stehen im Ausgabekanal `ERP Dashboard Sync`.

### Protokollierung

- Standardmäßig schreibt die Erweiterung kompakte Meldungen mit Zeitstempel in den Ausgabekanal `ERP Dashboard Sync`.
- `erpDashboardSync.verboseLogging = true` aktiviert ausführliche Diagnoseprotokolle.
- Dieser Modus protokolliert auch vollständige SQL-Abfragen, SOAP-Nutzdaten und unverarbeitete ERP-Antworten.
- Empfehlung: Nur vorübergehend zur Fehlersuche aktivieren, da die Ausgabe deutlich umfangreicher wird und fachliche Inhalte enthalten kann.

## Versionierungslogik

### Quickview

- Gespeicherte Version wird aus `QVQUERY.VERSION` bzw. `QVDASHBOARD.ANP_VERSION` gelesen.
- Beim Übertragen werden Inhalt und Versionsfeld zusammen aktualisiert.
- Wenn der aktuelle Versionswert ein gültiges `YYYYMMDD` ist:
  - Ohne Rückfrage wird automatisch das heutige Datum gesetzt.
- Wenn der aktuelle Versionswert kein gültiges `YYYYMMDD` ist:
  - Es wird höchstens einmal pro Tag nach einem neuen Versionsstand gefragt.
  - Der Dialog zeigt den aktuellen Wert als Referenz.
  - Weitere Übertragungen am selben Tag verwenden den bereits eingegebenen Wert.

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
  - Automatische Aktualisierung auf das heutige Datum (`YYYY`, `MM`, `DD`) ohne Rückfrage.
- Wenn die Version nicht dem Datumsprinzip entspricht:
  - Höchstens einmal pro Tag erfolgt die Auswahl, welcher Teil erhöht wird (`major`, `minor`, `fix`).
  - Danach automatische Wiederverwendung am selben Tag.
  - Der Dialog zeigt den bisherigen Versionsstand als Referenz.

### Tagesstatus zurücksetzen

- Soll am selben Tag erneut nach einer Versionsentscheidung gefragt werden:
  - Den Befehl `ERP Dashboard Sync: Reset Version Prompt State` ausführen.

## Ersatzabfrage ohne ANP_VERSION

- Beim Laden eines Quickviews verwendet die erste SQL-Abfrage `ANP_VERSION`.
- Falls diese Spalte serverseitig noch nicht verfügbar ist, wird der Abruf automatisch ohne `ANP_VERSION` wiederholt.

## Automatischer Abruf beim Start

- `erpDashboardSync.reloadOnStartup = true` (Standard): Der Abruf beim Start ist für jede gefundene Dashboard-Konfiguration aktiviert.
- `erpDashboardSync.reloadOnStartupPrompt = true` (Standard): Vor dem Abruf erscheint die Rückfrage `Laden` / `Nicht jetzt`.
- Mit `reloadOnStartupPrompt = false` erfolgt der Abruf beim Start ohne Rückfrage.

## Authentifizierung

Wenn die ERP-Umgebung NTLM verlangt, beispielsweise auch beim Zugriff mit Postman:

- `erpDashboardSync.authMode = ntlm`
- Empfohlen: Zugangsdaten über `ERP Dashboard Sync: Set Credentials (Secret Storage)` speichern.
- Ersatzweise: `erpDashboardSync.authUsername` und `erpDashboardSync.authPassword` setzen.
- Optional: Domäne über `erpDashboardSync.authDomain` angeben.

Zugangsdaten werden in dieser Reihenfolge aufgelöst:

1. Secret-Storage-Eintrag des Dashboard-Ordners; bestehende Schlüssel für bisher einzeln geöffnete Ordner bleiben erhalten.
2. Secret-Storage-Eintrag des umgebenden Arbeitsbereichsordners, falls das Dashboard verschachtelt ist und keinen eigenen Eintrag hat.
3. Globaler Secret-Storage-Eintrag.
4. Klartext-Einstellungen `authUsername`, `authPassword` und `authDomain` als Ersatz.

### Erforderliche Angaben

- Immer erforderlich:
  - `contextType` und `dashboardId` in `.erp-dashboard-sync.json`; `Initialize Workspace` fragt diese Angaben ab und legt die Datei an.
- Für die Endpunkte:
  - `dbFetchJsonUrl` und `xmlUpdateOfflineSoapUrl` sind technisch erforderlich, werden aber durch Standardwerte oder bei der Ersteinrichtung gesetzt.
- Für die Authentifizierung:
  - `authMode` ist erforderlich; Standard ist `ntlm`.
  - Bei `authMode = ntlm` sind Benutzername und Passwort erforderlich, entweder im Secret Storage oder in den Ersatzeinstellungen.
  - `authDomain` ist optional und wird bei Bedarf aus den gespeicherten Zugangsdaten übernommen.
- TLS:
  - `tlsAllowInsecure` ist optional und standardmäßig `false`. Die Ersteinrichtung setzt fehlende Ordnereinstellungen für interne Umgebungen mit selbstsignierten Zertifikaten auf `true`. Bei gültigen, vertrauenswürdigen Zertifikaten sollte die Einstellung `false` bleiben.

## Entwicklung

- Kompilieren: `npm run compile`
- Fortlaufend kompilieren: `npm run watch`
- Codeprüfung: `npm run lint`
- Gezielte Synchronisations- und Kontexttests nach dem Kompilieren: `node_modules\.bin\mocha --ui tdd --timeout 10000 out\test\fileSync.test.js`

## VSIX erstellen und verteilen

- Release mit Versionserhöhung, Kompilierung und Paketierung: `npm run release:vsix`
- Kompilieren und paketieren ohne Versionserhöhung: `npm run release:vsix:no-bump`
- Direkter Paketierungsbefehl: `npm run package:vsix`

Die erzeugte `.vsix` lässt sich auf anderen Rechnern installieren:

- In VS Code: Erweiterungsansicht öffnen, `...` wählen und den Befehl zum Installieren aus einer VSIX-Datei ausführen.
- Über die Kommandozeile: `code --install-extension <pfad-zur-vsix>`

## Beispiel für den JSON-Webdienst

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

### Datenbankanpassung für das Versionsfeld in QVDASHBOARD

```xml
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

### Anpassung an WebProject/WebServer/Quickviews/DashboardTransfer.aspx

Beispiel ab Zeile 286:
```csharp
else if (table == "QVDASHBOARD" && cmd == "modify") {
  versionLocal = Int32.Parse(WebUtils.getSimpleScalarValue(table, "ANP_VERSION", keyCol, key) ?? "0");
  versionImport = (xRecord.SelectSingleNode("ANP_VERSION") == null ? 0 : Int32.Parse(xRecord.SelectSingleNode("ANP_VERSION").InnerText ?? "0"));
  isNewVersion = versionLocal == 0 || versionImport > versionLocal;
}
```