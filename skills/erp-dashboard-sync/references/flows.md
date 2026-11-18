# Flowboards: SQL, XML und JavaScript als gemeinsamer Vertrag

Ein Flowboard ist kein Quickview-Dashboard. Die konkrete Flowdefinition und
APplus-Version sind maßgeblich; die folgenden Bindungsmuster sind
kontextabhängig und müssen anhand eines passenden Exports geprüft werden.

## Rollen der materialisierten Dateien

| `FLOWBOARD`-Feld | Aufgabe |
|---|---|
| `SQLSTATEMENT` | Kartenzeilen, Schlüssel, Status, Anzeigewerte und Aktionsdaten |
| `XMLDEFINITION` | Board, Filter, Parameter, Lanes, Templates, Dialoge und Aktionen |
| `JAVASCRIPT` | im XML referenzierte Clientfunktionen und belegte Koordination |

Die drei Dateien über die Board-GUID im Sync-Index zusammenführen. SQL-Aliasse
sind Schnittstellen zu XML und Aktionen. Wird ein Alias umbenannt, alle
Konsumenten nachziehen. Prüfe Join-Kardinalität, Filter, Statusberechnung und
Leerwerte, nicht nur die angezeigte Karte.

## Bindungen sind kontextgebunden

In untersuchten Flow-Definitionen kamen unter anderem folgende Muster vor:

| Muster | Beobachteter Kontext |
|---|---|
| `<Value>ANLAGE</Value>` | Direkter Spaltenname statt konstantem Anzeigetext |
| `${sql.ANLAGE}` | Kartenzeile in unterstütztem Platzhalterkontext |
| `${dialogresult.Prio}` | Benanntes Dialogfeld derselben Aktion |
| `{NAME}` oder `{PERSONAL}` | Aktuelle Zeile eines `DynamicSQL`-Kontexts |
| `${dynamic.PERSONAL}` | Dynamischer Aktionskontext |
| `$P{Prioritaet1}` | Boardparameter |

Das sind keine austauschbaren Syntaxformen. Schreibweise und Gültigkeit
können vom Element, der Aktion und der Engineversion abhängen. Nicht ungeprüft
`${dialogresult...}` in einen JavaScript-Aufruf verschieben oder QV-Parameter
als Flow-Parameter behandeln. Für gleiche Konzepte können andere Bereiche
unterschiedliche Groß-/Kleinschreibung verlangen.

## XML und Darstellung

- Flow-XML ist eine case-sensitive Domänensprache, keine freie HTML-Vorlage.
  Keine Events, Uploadfelder, Attribute, Statuswerte oder Feldtypen ergänzen,
  wenn sie nicht im Schema, in der installierten Engine oder einem passenden
  Export belegt sind.
- Bei einer zusätzlichen Kartenzeile den SQL-Alias, die Label-/Value-
  Bindungen und alle betroffenen CardTemplates zusammen prüfen. Vererbung
  zwischen Templates nicht voraussetzen.
- Dialogfelder und Aktionen im Scope der konkreten Aktion halten. Menüs,
  Neuanlage und Drop-Aktionen können unterschiedliche XML-Orte oder
  Datenkontexte haben.
- Für unterstützte Dialogtypen und deren Feldnamen den vorhandenen Flow und
  Enginevertrag prüfen. Ein SQL-Alias, ein Dialogergebnis und eine globale
  Variable sind unterschiedliche Bindungsquellen. Groß-/Kleinschreibung von
  Bezeichnern kann Teil des Vertrags sein.
- Anzeigeattribute nicht aus ihrem Namen interpretieren. In untersuchten
  Builds wirkten Detailanzeige-Einstellungen unterschiedlich auf kompakte
  Karten und Sidebarlisten. Beide Ansichten am Ziel prüfen.
- Lane- und Slice-Zuordnungen sowie Drop-Aktionen gemeinsam prüfen. Ein
  Schreibvorgang für nur ein Statusfeld garantiert nicht, dass die Karte
  fachlich der gewählten Ziel-Lane entspricht.
- `ExecuteFor` beschreibt die Ausführungskonfiguration, nicht die
  Backendberechtigung. Rechte müssen serverseitig durchgesetzt werden.

## Flow-JavaScript und Schreibgrenzen

- Im XML referenzierte Funktionsnamen, Parameterreihenfolge und Antwortwerte
  müssen im aktuellen Projekt belegt sein. JavaScript-Stringescaping ist
  zusätzlich zum XML-Escaping nötig.
- Async-Aufrufe nur dann als abgeschlossen behandeln, wenn die konkrete
  Funktion sie abwartet. `undefined`, `false`, `null` und ein Fehler sind
  nicht automatisch gleichbedeutend.
- Benutzer-JavaScript kann je nach Engine in einem separaten Frame oder
  Sandboxkontext laufen. `document`, `top.document`, Bibliotheken und
  Callbackreihenfolge nicht aus einem anderen Flow übernehmen. Zugriff auf
  fremde Frames oder interne Frameworkobjekte nicht als Integrationsweg
  voraussetzen.
- Keine Transaktion oder Abbruchgarantie über mehrere ERP-Serviceaufrufe
  annehmen. Nach einem Teilfehler können Änderungen bereits erfolgt sein.
  Idempotenz, Wiederholung und Teilfortschritt gesondert beurteilen.
- Fachliche Buchungen nicht durch direkte SQL-Schreibabfragen ersetzen.
  Bestehende geprüfte Fachservices und Backendvalidierung verwenden; Rechte,
  Pflichtfelder, Zustand und konkurrierende Änderungen berücksichtigen.
- Keine schreibende Liveprüfung ohne Auftrag und kontrollierten Testkontext.

## Abnahme

XML lokal parsen und danach Bindungen, SQL-Aliasse, Dialogfelder, Call-
Signaturen und Aktionsscopes einzeln prüfen. Wohlgeformtes XML belegt keine
Gültigkeit für die Flow-Engine.

Bei freigegebener Testumgebung zusätzlich Abbruch, Schließen, fehlende Rechte,
veraltete Daten, fehlgeschlagene Folgeaktionen, Neuanlage und Wiederholung
nach Teilfehler prüfen. Eine lokale Syntaxprüfung ist keine Liveabnahme.
Bei Karten-/Laneänderungen auch ungültige oder mehrdeutige Zeilen, Drop-
Aktionen, dynamische Lanes und den Datenreload nach Erfolg oder Fehler prüfen.

