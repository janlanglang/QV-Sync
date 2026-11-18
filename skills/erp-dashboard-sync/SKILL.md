---
name: erp-dashboard-sync
description: Explains and edits files materialized by the ERP Dashboard Sync extension. Use for APplus Quickview or Flow files under the configured generatedRootDir, especially query SQL, options, dashboard-query assignments, chart scripts, and Flow XML/JavaScript.
---

# ERP Dashboard Sync: materialisierte Dateien bearbeiten

Nutze diesen Skill, wenn Dateien bearbeitet werden, die ERP Dashboard Sync
geladen und in `.erp-dashboard-sync-index.json` eingetragen hat. Ziel ist,
den APplus-Datenvertrag der konkreten Datei zu erhalten; die Dateiendung allein
ist kein verlässlicher Syntax- oder Zuordnungsnachweis.

## Erst Kontext und Sync-Grenze prüfen

1. Lies `.erp-dashboard-sync.json` und `.erp-dashboard-sync-index.json` im
   passenden Dashboard-Ordner. Der Index bestimmt, welche ERP-Tabelle, welches
   Feld und welche GUID eine Datei adressiert. Dateinamen nicht als Ersatz
   für den Index verwenden und verwaltete Dateien nicht eigenmächtig umbenennen.
2. Bestimme den Laufzeitkontext anhand des Dashboard-Aufrufs und der
   tatsächlichen Einbettung:
   - Eigenständiges Dashboard: Dashboard- und Query-Dateien können dazugehören.
   - In einer Fach-/Navpage eingebettetes Quickview: nur die eigene Query-/
     View-Zuordnung ändern, nicht die umgebende Fachseite oder Navigation.
   - Flowboard: eigener Vertrag aus Flow-SQL, Flow-XML und Flow-JavaScript;
     keine Quickview- oder HTML-Strukturen in das Flow-XML übertragen.
   `contextType` allein belegt nicht, ob ein Quickview eigenständig oder
   eingebettet ist. Ist das für die Änderung relevant und nicht feststellbar,
   frage nach.
3. Prüfe den wirksamen Wert von `erpDashboardSync.autoSyncOnSave`. Er steuert
   Speichern und externe Dateiänderungen. Bei aktiviertem Auto-Sync kann schon
   ein agentischer Dateiedit Änderungen ins ERP übertragen. Ohne Auftrag zum
   ERP-Schreiben nicht editieren, bevor eine freigegebene lokale Arbeitsweise
   feststeht. Einstellungen oder Zugangsdaten nicht eigenmächtig ändern.
4. Kein `Reload From ERP` über ungesicherte lokale Änderungen. Ein Reload ist
   kein Merge und kann materialisierte Dateien überschreiben.

## Vertiefende Referenzen

Lies nur die Referenz, die zum Auftrag passt; aktuelle Projektdateien und der
Sync-Index haben Vorrang:

- Sync-Konfiguration, Index, Upload- und Versionsverhalten:
  [Pluginvertrag](./references/plugin.md).
- Quickview-Einbettung, Query-Ladezyklus, Parameter und Diagramme:
  [Quickview-Vertrag](./references/quickviews.md).
- Flow-SQL, XML-Bindings, Dialoge und Flow-JavaScript:
  [Flowboard-Vertrag](./references/flows.md).
- Lesen und Schreiben von ERP-Daten, Serialisierung und Fehlergrenzen:
  [Daten- und Dienstgrenzen](./references/data-services.md).
- Anonymisierte Beispiele aus Quickviews, Flowboards und Datenintegrationen:
  [Beispielmuster](./references/anonymized-patterns.md).
- Projektdokumentation und sichere Vorschau:
  [Dokumentationsregeln](./references/documentation.md).

## Datei- und Feldverträge

Die Wurzel `erp-dashboard` kann über `generatedRootDir` geändert sein. Die
Namen enthalten bereinigte Bezeichnungen; GUIDs erhalten die Zuordnung auch
bei mehrfach verwendeten Queries oder Zuordnungen.

| Dateien unter dem Dashboard-Kontext | ERP-Ziel | Inhalt |
| --- | --- | --- |
| `query/<name>[__<titel>]__<guid>.js` | `QVQUERY.JSPAGESCRIPT` | JavaScript der Query |
| `query/<name>[__<titel>]__<guid>.css` | `QVQUERY.CSSSTYLE` | CSS der Query |
| `query/<name>[__<titel>]__<guid>.sql` | `QVQUERY.STATEMENT` | SQL der Query |
| `query/<name>[__<titel>]__<guid>.options.xml` | `QVQUERY.OPTIONS` | XML-Text, unverändert |
| `dashboard/<name>[__<titel>]__<guid>.js` | `QVDASHBOARD.JSPAGESCRIPT` | Dashboard-JavaScript |
| `dashboard/<name>[__<titel>]__<guid>.css` | `QVDASHBOARD.CSSSTYLE` | Dashboard-CSS |
| `dashboard-query/<name>[__<titel>][__<Zuordnungs-GUID>].paramstring.txt` | `QVDASHBOARDQUERY.PARAMSTRING` | Parameterstring der Dashboard-Query-Zuordnung |
| `dashboard-query/<name>[__<titel>][__<Zuordnungs-GUID>].jschartscript.js` | `QVDASHBOARDQUERY.JSCHARTSCRIPT` | JavaScript des Diagramms |
| `dashboard-query/<name>[__<titel>][__<Zuordnungs-GUID>].chartoptions.js` | `QVDASHBOARDQUERY.CHARTOPTIONS` | Text der Diagrammoptionen |
| `<flow-GUID>/<flow-GUID>.xml` | `FLOWBOARD.XMLDEFINITION` | Flow-Definition |
| `<flow-GUID>/<flow-GUID>.js` | `FLOWBOARD.JAVASCRIPT` | Flow-JavaScript |
| `<flow-GUID>/<flow-GUID>.sql` | `FLOWBOARD.SQLSTATEMENT` | Flow-SQL |

Die Tabellenzeilen sind schematische Muster: optionale Titelteile entfallen,
wenn sie leer sind. Bei Dashboard-Query-Dateien steht die GUID der
`QVDASHBOARDQUERY`-Zuordnung im Dateinamen und Index, nicht die GUID der
`QVQUERY`. Diese Unterscheidung ist wichtig, wenn dieselbe Query mehrfach
verwendet wird.

## APplus-Verträge hinter den Dateien

- `QVDASHBOARD` beschreibt die Dashboard-Seite, `QVQUERY` die gemeinsame
  Query samt SQL und Query-Ressourcen, `QVDASHBOARDQUERY` die Verwendung einer
  Query in einem Dashboardelement. Änderungen an einer Query können daher
  mehrere Elemente betreffen; Änderungen an `PARAMSTRING`, `JSCHARTSCRIPT`
  oder `CHARTOPTIONS` betreffen die konkrete Zuordnung.
- `QVQUERY.OPTIONS` und `QVDASHBOARDQUERY.CHARTOPTIONS` sind verschieden:
  `OPTIONS` ist XML der Query, `CHARTOPTIONS` sind elementbezogene
  Diagrammoptionen. Ein untersuchter APplus-Chartpfad liest
  `CHARTOPTIONS` als JSON; der Sync selbst validiert es nicht. Vor Änderungen
  die Zielversion und vorhandenen Werte prüfen.
- Das Quickview-Framework lädt Queries asynchron, und Hooks können bei
  erneutem Rendern wieder aufgerufen werden. Vorhandene Hook-Signaturen,
  Container und Ladezyklen im konkreten Dashboard prüfen. Keine globalen
  Funktionen doppelt definieren; Render- und Eventlogik wiederholbar halten.
- Query-`OPTIONS`-Defaults, `PARAMSTRING`/lokaler Kontext und globale
  Requestparameter können gemeinsam an der Ersetzung von `$P{...}` beteiligt
  sein. Ein untersuchter Serverpfad bevorzugte globale `param`-Werte gegenüber
  lokalen Werten; das ist versionsabhängig. Parameterdatei, Query-SQL und
  Options-XML zusammen prüfen, statt eine Priorität vorauszusetzen.
- URL-Kodierung, Querystring-Trennung und SQL-Quoting sind getrennte Schritte.
  Listen oder SQL-Fragmente in Parametern nur nach einem belegten Vertrag und
  mit eingeschränkten erlaubten Werten verwenden. Parameter sind keine
  Berechtigungsprüfung.
- Flow-XML ist eine case-sensitive APplus-Domänensprache, kein HTML oder
  BPMN. SQL-Aliasse, XML-Elemente und JavaScript-Aufrufe bilden zusammen
  einen Datenvertrag. Platzhalter und Dialogwerte sind kontextabhängig; nur
  Syntax aus einem passenden Flow-Beispiel und der installierten Version
  übernehmen. Keine Tags, Felder oder Serviceaufrufe erraten.

## Fachliche Inhalte richtig erstellen

- **Query-SQL:** Vergleiche die Änderung mit der vorhandenen Query, den
  referenzierten Parametern und vorhandenen Beispielen desselben
  Laufzeitkontexts. Erfinde keine Tabellen, Spalten, Statuswerte oder
  APplus-Funktionen. Wenn ein Query-Parameter verwendet wird, prüfe sowohl
  dessen SQL-Platzhalter (zum Beispiel `$P{Parameter}`) als auch vorhandene
  Query-Options-Defaults und Aufrufer.
- **`PARAMSTRING`:** Dies ist der Parameterstring einer bestehenden
  Dashboard-Query-Zuordnung, kein SQL und keine Definition von Query-Defaults.
  Verwende die Syntax der konkreten Query und vorhandener Zuordnungen, zum
  Beispiel `Status=2&Gruppe='BEISPIEL'`; kein `localparam=` voranstellen.
  Der Sync quotiert, dekodiert oder formatiert den Inhalt nicht. Namen, Werte,
  Quotes und URL-Kodierung müssen zum Empfänger passen.
- **`OPTIONS`:** Muss gültiger, zum Query-Vertrag passender XML-Text sein.
  Keine JavaScript-Hülle ergänzen. Der Sync speichert den Inhalt als Text und
  validiert oder formatiert das XML nicht.
- **`CHARTOPTIONS`:** Die `.chartoptions.js`-Endung sagt nicht, dass der Inhalt
  JavaScript ist. Der Sync behandelt ihn als unveränderten Text und prüft das
  Format nicht. Prüfe bestehende Werte und den konkreten APplus-Chartpfad,
  bevor du Syntax oder Struktur festlegst.
- **`JSCHARTSCRIPT` und JavaScript-Dateien:** JavaScript des passenden
  Quickview-/Chart-/Flow-Kontexts. Bestehende Hooks, Datenform und Ladezyklus
  erhalten; APIs und Eigenschaften nicht aus Dateinamen ableiten.
- **Flow-Dateien:** SQL, XML und JavaScript gehören zusammen, haben aber einen
  eigenen Vertrag. Bestehende Struktur und Datenübergaben im Flow erhalten.
  IDs, GUIDs, Belegnummern und Flow-CARDIDs nicht verwechseln.
- Leere oder im ERP `NULL`-Werte werden als leere Dateien materialisiert. Die
  Dateien enthalten Feldtext ohne zusätzliche Hülle oder Formatierung des
  Syncs. Keine sensiblen ERP-Daten in Beispiele, Tests oder Dokumentation
  übernehmen.

## Bearbeiten und verifizieren

1. Suche ein Beispiel im selben Laufzeitkontext und prüfe Query, Zuweisung,
   Index-GUID, Parameterquellen sowie gekoppelte SQL-/JS-/CSS-/XML-Dateien.
2. Ändere nur die angeforderten Inhalte und notwendige gekoppelte Stellen.
   Bewahre unveränderte Textbereiche, Zeilenumbrüche und bestehende APIs.
3. Führe für SQL, XML, JavaScript oder CSS nur passende lokale Syntax- oder
   Projekttests aus. Das ist keine Liveprüfung gegen APplus.
4. Berichte, was geändert und lokal geprüft wurde. Einen erfolgreichen
   ERP-Upload nur melden, wenn die Extension ihn ausdrücklich als erfolgreich
   bestätigt hat.

Keine ERP-Reloads, Deployments, echten Buchungen oder DMS-Uploads ohne
entsprechenden Auftrag und kontrollierten Testkontext ausführen.
