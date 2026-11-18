# ERP Dashboard Sync: Konfiguration, Mapping und Schreibverhalten

Diese Referenz beschreibt den Pluginvertrag für die verwalteten Dateien. Bei
Abweichungen haben der tatsächlich installierte Extension-Build, die lokale
README und der Index des betroffenen Dashboard-Ordners Vorrang.

## Konfiguration und Index

- `.erp-dashboard-sync.json` wählt den Kontext (`quickview` oder `flow`), die
  Dashboardkennung beziehungsweise Flow-GUID und optionale
  Versionsentscheidungen. Die Datei beschreibt nicht, ob ein Quickview in eine
  Fachseite eingebettet ist.
- `.erp-dashboard-sync-index.json` ist die Zuordnung lokaler relativer Pfade
  zu ERP-Tabelle, Feld, Datensatz-GUID und Kontext. Der Index, nicht der
  Dateiname oder die Dateiendung, entscheidet, ob und wohin eine Datei
  synchronisiert wird.
- Ein neu angelegtes oder umbenanntes Dokument wird nicht dadurch zu einer
  ERP-Ressource, dass es im generierten Ordner liegt. Indexeinträge nicht durch
  Raten ergänzen oder auf andere Kontexte übertragen.
- Bei mehreren oder verschachtelten Dashboards Konfiguration und Index des
  nächstgelegenen passenden Kontextordners verwenden. Keine Zuordnung aus
  einem anderen Dashboard ausleihen.
- Endpoints, Authentifizierung, TLS, automatischer Sync, Startup-Reload und
  generierter Stammordner kommen aus den wirksamen VS-Code-Einstellungen. In
  Multi-Root-Workspaces können Einstellungen je Ordner variieren.
- Zugangsdaten gehören bevorzugt in VS Code Secret Storage. Keine Passwörter,
  Tokens oder produktive Antworten in Dateien, Logs, Beispielen oder Tests
  aufnehmen.

## Materialisieren und synchronisieren

Der Abruf über `dbFetchJSON` erzeugt lokale Inhalte und den Index. Änderungen
an indizierten Dateien werden über `xmlUpdateOffline` zurückgeschrieben.
Transportdetails und Fähigkeiten können sich zwischen installierter
Extension-Version und Quellstand unterscheiden.

- `erpDashboardSync.autoSyncOnSave` steuert den automatischen Abgleich bei
  Editor-Speichern und — im aktuellen Quellstand — externen Änderungen an
  indizierten Dateien. Ein KI-Edit oder eine Dateisystemänderung kann daher
  bereits einen ERP-Schreibvorgang auslösen.
- Der aktuelle Quellstand fasst Dateiereignisse kurz zusammen und reiht
  Uploads und Reloads ein, damit Index- und Versionsdaten nicht gleichzeitig
  verändert werden. Das verhindert keine Konflikte mit ERP-Änderungen von
  anderen Nutzern.
- Nur indizierte Dateien werden hochgeladen. Die Extension überträgt den
  gespeicherten Dateiinhalt; ungespeicherte Editorinhalte sind kein
  Uploadnachweis. Ein unveränderter Inhalt kann anhand seines Hashs
  übersprungen werden.
- Dateiänderungen bei geschlossenem VS Code werden nicht automatisch beim
  nächsten Start nachgesendet. Ein erfolgreicher lokaler Edit und ein
  erfolgreicher ERP-Upload sind getrennte Ergebnisse.
- Bestehende Indizes bleiben auch ohne optionale, neuere Dateieinträge
  verwendbar. Ein späterer, ausdrücklich beauftragter Reload kann zusätzliche
  Dateien und ihre Zuordnungen materialisieren. Eine fehlende Datei ist weder
  Beleg für einen leeren ERP-Wert noch ein Grund, den Index manuell zu erfinden.
- `Reload From ERP` ist kein Merge. Er kann verwaltete lokale Dateien
  überschreiben. Vor einem Reload lokale Arbeit sichern und Konflikte klären.
- Uploadwarteschlangen und Versionsupdates vermeiden keine fachlichen
  Nebenwirkungen und garantieren keine Transaktion über mehrere SOAP-Aufrufe.
  Teilfehler ausdrücklich prüfen und berichten.
- Fehler und Trigger im Output-Channel `ERP Dashboard Sync` nachsehen.
  Ausführliches Logging kann SQL, SOAP-Inhalte und ERP-Antworten enthalten;
  nur gezielt einschalten und Ausgaben vor Weitergabe bereinigen.

## Versionsfelder im aktuellen Pluginvertrag

Diese Zuordnungen beschreiben den aktuellen Quellstand; vor Annahmen über
einen installierten Build dessen Verhalten bestätigen.

- Quickview-Queryressourcen wie SQL, JavaScript, CSS und Query-Options gehören
  zu `QVQUERY`; deren Änderungen verwenden `QVQUERY.VERSION`.
- Dashboard-JavaScript und -CSS gehören zu `QVDASHBOARD` und verwenden die
  Dashboardversion `ANP_VERSION`.
- Dashboard-Query-Zuordnungen besitzen kein eigenes Versionsfeld. Bei deren
  Änderungen prüft das Plugin die Version des übergeordneten Dashboards. Der
  Zuordnungsinhalt und das Dashboard-Versionsfeld können in getrennten
  Schreibschritten übertragen werden; ein Fehler im zweiten Schritt bedeutet
  einen möglichen Teilerfolg, keine vollständige Synchronisierung.
- Flow-Inhalte gehören zu `FLOWBOARD`; die Version umfasst
  `MAJORVERSION`, `MINORVERSION` und `PATCHVERSION`.
- Versionsauswahl oder -prompt ist keine fachliche Freigabe für Deployment
  oder Buchungen.
- Im aktuellen Plugin werden gültige Quickview-Datumswerte im Format
  `YYYYMMDD` automatisch auf das heutige Datum aktualisiert; bei anderen
  Werten kann eine tägliche Versionsentscheidung erforderlich sein. Für Flows
  gibt es ein eigenes Datums-/Major-Minor-Patch-Verhalten. Vor dem Schreiben
  die tatsächlichen Werte, die VS-Code-Rückfrage und die installierte Version
  prüfen. Versionsprompts sind kein fachlicher Releaseprozess.

## Verhaltensregeln

1. Vor dem Edit die wirksame Auto-Sync-Einstellung, den Index und den
   Arbeitsbaum prüfen.
2. Bei einem lokalen Änderungsauftrag mit aktivem Auto-Sync vor dem Schreiben
   eine freigegebene lokale Arbeitsweise sicherstellen. Einstellungen,
   Credentials und TLS nicht ungefragt ändern.
3. Nur die angeforderten indizierten Ressourcen bearbeiten. Dieselbe
   Query-GUID kann in mehreren Dashboards verwendet werden.
4. Bei einem beauftragten ERP-Upload die ausdrückliche Erfolgsmeldung der
   Extension abwarten. Bei Teilfehler, Abbruch oder unklarem Ausgang keinen
   Erfolg behaupten und keine blinde Wiederholung auslösen.

