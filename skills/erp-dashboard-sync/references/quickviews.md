# Quickviews: Betriebsmodi, Parameter und Rendervertrag

Projektcode und die installierte APplus-Version sind maßgeblich. Die folgenden
Muster sind Orientierung, keine vollständige oder versionsübergreifende
Spezifikation.

## Drei getrennte Ressourcen

- `QVDASHBOARD` beschreibt Dashboardseite und Dashboardressourcen.
- `QVQUERY` enthält die gemeinsame Query, ihr SQL und querybezogene
  JavaScript-, CSS- und Optionsfelder.
- `QVDASHBOARDQUERY` verknüpft eine Query mit einem Element im Dashboard.
  Parameter- und Darstellungsoptionen dieser Verknüpfung sind
  elementbezogen.

Dashboard-, Query- und Zuordnungs-GUID sind verschiedene Kennungen. Eine
Query kann mehreren Dashboardelementen zugeordnet sein. Änderungen an
`QVQUERY` können daher alle diese Verwendungen beeinflussen; Änderungen an
einer `QVDASHBOARDQUERY`-Zuordnung betreffen nur diese Zuordnungszeile.

## Kontext vor der Implementierung bestimmen

| Modus | Typischer Kontext | Arbeitsgrenze |
|---|---|---|
| Eigenständiges Dashboard | Dashboard ist die eigene Seite | Dashboardlayout und Navigation nur im beauftragten Umfang ändern. |
| Eingebettetes Quickview (`navview`) | Quickview läuft innerhalb einer Fach-/Navpage | Nur eigenen Query-/Viewbereich ändern; Fachseite, Navigation und technische Frameworkknoten erhalten. |
| Flowboard | Eigenes Board mit Flow-XML, SQL und JavaScript | Flow-Verträge verwenden, keine Quickview-Hooks oder HTML-Strukturen übertragen. |

Der Ordnername und `contextType: quickview` belegen die Einbettungsart nicht.
Dashboardaufruf, APplus-Zuordnung, Hooks und Parameterquellen prüfen. Bei
Navview sind Fachmaske und Quickview getrennte DOM- und Ladebereiche. Die
isolierte Dashboardansicht ersetzt keine Prüfung in der Fachmaske.

Ein möglicher Frameworkablauf lädt zunächst Dashboardkonfiguration und danach
Query-Ressourcen asynchron. In untersuchten Frameworkständen gibt es
unterschiedliche Abfrageformen für HTML-, JSON-, Chart- und Compute-Antworten.
Vorhandene Queryhelper und Zielversion prüfen; keine Antwortform aus einem
anderen Projekt übernehmen. Compute-Funktionen können auf einem bereits
geladenen DataTable laufen und sind nicht automatisch SQL-Aggregationen.

In Projekten belegte Hooknamen wie `event_page_loaded(isSingleTableView)` oder
`event_table_loaded(guid, tableContainer)` sind keine Garantie, dass sie in
jedem Dashboard oder APplus-Build verfügbar sind. Exakte Signatur und
Ausführungsreihenfolge am Ziel prüfen. Ein zusätzlicher Single-Table-Aufruf
kann beispielsweise einen fehlenden Query-GUID-Kontext liefern.

## Einbettungs- und Parameterkontext

Bei Navview nicht `location.search` als einzige Quelle voraussetzen. Je nach
Integration kann der Fachkontext in einem verschachtelten `param`, in einem
technischen Kontextknoten oder im `data-localparam` des Elements liegen.
Zuerst den tatsächlich geladenen Quickview-Container bestimmen, dann den
vorhandenen Parser und die nachgewiesene Übergabe verwenden. Mehrfach
URL-kodierte Werte begrenzt dekodieren; fehlerhafte Kodierung sichtbar
behandeln, nicht in einer Schleife immer weiter dekodieren.

Ein beobachtetes Aufrufmuster für eingebettete Quickviews enthält
`Dashboard.aspx`, eine Element-GUID, Parameter und einen In-Frame-Marker.
Das ist kein universeller Aufrufvertrag. Recpage, Fachdatensatz-ID und
Navview-GUID niemals aus Queryname, Element-GUID oder sichtbarem Titel
ableiten. Die Fachseite und ihre technischen Knoten erhalten; nur den eigenen
Elementbereich aktualisieren.

## Queryparameter und Optionen

1. `QVQUERY.OPTIONS` enthält querybezogene Optionen und kann Defaults für
   `$P{...}`-Parameter liefern.
2. `QVDASHBOARDQUERY.PARAMSTRING` ist der Parameterstring einer bestehenden
   Zuordnung. Beispiel: `Status=2&Gruppe='BEISPIEL'`. Er enthält weder ein
   führendes `?` noch `localparam=`. Er definiert keine neuen Query-Defaults.
3. Query-SQL muss dieselben Parameternamen und den erwarteten Wertetyp
   verwenden. Parameterdatei, `$P{...}`-Platzhalter und Options-XML gemeinsam
   untersuchen.
4. URL-Kodierung, Querystring-Paartrennung und SQL-Quoting sind getrennte
   Verarbeitungsschritte. Der Sync führt diese Umwandlungen nicht aus.
5. In einem untersuchten Serverpfad konnten globale Requestparameter lokale
   Parameter überschreiben. Das ist versionsabhängig; die Priorität in der
   Zielinstallation belegen, nicht raten.

Die Platzierung des Platzhalters im SQL bestimmt, was eingesetzt werden darf.
`column = '$P{Name}'` und `column IN ($P{Names})` sind unterschiedliche
Verträge: im ersten Muster kommen die SQL-Quotes aus dem Querytext, im
zweiten muss der konkrete Ersatz zum SQL-Ausdruck passen. Für Listen
Kardinalität, erlaubte Werte und Quotes aus einem bestehenden, passenden
Querybeispiel übernehmen; nicht aus einem Parameterstring auf sichere
Beliebigkeit schließen.

Quickview-SQL kann außerdem versions- und kontextabhängige Platzhalter wie
`$S{...}`, `$SC{...}`, `$O{...}` und `$T{...}` verwenden. SQL-Escaping-
Optionen wie `escape=true` oder `:e` nicht als allgemeine Garantie für
beliebige Werte auffassen. Tabellennamen und andere Identifier brauchen
separate feste Regeln.

Listen, optionale Schlüsselwörter und SQL-Fragmente in Parametern sind kein
sicherer Vertrag für beliebige Eingaben. Werte typisieren und begrenzen.
Parameter und UI-Sichtbarkeit ersetzen keine serverseitigen Berechtigungen.

## Query-Chart und Element-Chart unterscheiden

- `QVQUERY.OPTIONS` ist querybezogenes XML. Untersuchte Exporte verwenden unter
  anderem eine `config/chart`-Struktur. Vorhandene Knoten und Attribute
  beibehalten; nicht aus einem Dateinamen oder einem anderen Querytyp ableiten.
- `QVDASHBOARDQUERY.CHARTOPTIONS` ist elementbezogener Text. Ein untersuchter
  APplus-Chartpfad verarbeitet ihn als JSON und nicht als ausführbares
  JavaScript. Zielversion und bestehende Werte verifizieren; der Sync prüft
  die Syntax nicht.
- `QVDASHBOARDQUERY.JSCHARTSCRIPT` enthält hingegen ausführbaren JavaScript-
  Code. Einen Sicherheits- und Laufzeitvertrag prüfen; keine Variablen oder
  APIs anhand der Dateiendung erfinden.
- Ein Chart kann Query-Options und elementbezogene Optionen kombinieren.
  Unterschiedliche Merge-Regeln nicht voraussetzen.
- In untersuchten Query-Options lag die Chartdefinition unter
  `config/chart`; SQL-Aliasse für Gruppen und Measures mussten zu den
  XML-Werten passen. Das ist ein belegtes Exportmuster, keine Pflichtstruktur
  für jede Query. Bestehende XML-Struktur, SQL-Aliasse und Charttyp gemeinsam
  prüfen. Leere Optionsdatei, fehlende Datei und ein definierter Parameter mit
  leerem Default sind unterschiedliche Zustände.

## Hooks, Reload und DOM

- Vorhandene Hooknamen, Argumente und Ausführungszeitpunkt in der konkreten
  Query/Dashboarddatei nachlesen. Ein Hook für ein eigenständiges Dashboard
  ist kein allgemeiner Navview-Hook.
- Framework-Hooks und Queries können bei Reload erneut laufen. Keine zweite
  gleichnamige globale Funktion definieren; Renderlogik idempotent halten.
- Den übergebenen Container und die konkrete Query prüfen, nicht nur eine
  geratene GUID. Technische Kontext- oder Ladeelemente nicht ersetzen.
- Bei eigenem DOM: pro Container eindeutige IDs und Zustand verwenden,
  Eventhandler/Observer bei erneutem Mount bereinigen und verspätete Antworten
  nach einem Datensatzwechsel verwerfen.
- ERP-Werte nicht ungeprüft als HTML interpretieren. HTML-Escaping und
  SQL-/XML-/URL-Kodierung sind getrennte Kontexte; vorhandene sichere
  Renderinghelfer verwenden.
- WSS-spezifische Regeln zum Ausblenden von Navigation, Splittern oder Aktionen
  nicht auf Navview übertragen. Auch bei eigenständigen Dashboards keine
  pauschale Leerung des Inhaltscontainers vornehmen.
- Einmal initialisieren, erneut laden, leere Daten, Fehler und Kontextwechsel
  prüfen. Bei Navview in der echten Fachmaske, mit Datensatzwechsel und
  fehlendem Kontext verifizieren.

