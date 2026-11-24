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

### `param` und `localparam` als URL-String

Stand: 24.11.2026. Grundlage: vorhandene Frameworkdokumentation und statische
Projektbefunde, keine neue APplus-Livepruefung. Gilt fuer eigenstaendige und
eingebettete Quickviews; die konkrete Weitergabe im Zielbuild pruefen.

| Quelle | Bedeutung und Weitergabe |
|---|---|
| `param` | Globaler Parameterstring des Dashboardaufrufs; wird im untersuchten Framework an die Query-Requests weitergegeben, oft aus `#global-data[data-param]`. Gilt nicht automatisch fuer die umgebende Fachseite. |
| `localparam` | Lokaler Parameterstring eines einzelnen Query-Requests. Im Dashboard stammt er typischerweise aus `QVDASHBOARDQUERY.PARAMSTRING` ueber `data-localparam` des Elements. |
| `QVQUERY.OPTIONS` | Querybezogene Parameterdefaults; kein URL-Parameterstring. Im untersuchten Pfad Ersatz fuer nicht uebergebene Parameter. |

Beide Requestparameter enthalten selbst einen Querystring, also
`Name=Wert&Name=Wert`. Die inneren Parameternamen muessen zu `$P{Name}` im
SQL passen. `?id=42` ist nicht dasselbe wie `?param=id%3D42`: Im zweiten Fall
liegt `id` innerhalb des vom QV-Parameterpfad gelesenen Strings.

Schematische Beispiele mit neutralen Werten:

```text
Dashboard.aspx?name=BEISPIEL&param=id%3D42%26Status%3D2
Query.aspx?name=BEISPIEL_QUERY&xhr=html&param=id%3D42%26Status%3D2&localparam=Status%3D3%26Gruppe%3DA
```

Nach dem Lesen der aeusseren Requestparameter enthalten diese:

```text
param:      id=42&Status=2
localparam: Status=3&Gruppe=A
```

Im dokumentierten Serverpfad wird zuerst lokal, danach global eingelesen:
Bei gleichem Namen gewinnt `param`, hier also `Status=2`; `Gruppe=A` bleibt
lokal erhalten. Nicht aus dem Wort "lokal" einen Vorrang ableiten. Ob ein
leerer Wert einen Default unterdrueckt, in der Zielversion pruefen; fehlend
und leer nicht gleichsetzen. Ein `localparam` an der Dashboard-URL allein
belegt nicht, dass er an alle Elemente weitergegeben wird.

**Zwei Kodierungsebenen:** Zuerst einzelne innere Namen/Werte serialisieren,
dann den gesamten inneren String als Wert von `param` bzw. `localparam` in
die aeussere URL einsetzen. Beispiel ohne ERP-Aufruf:

```javascript
const inner = new URLSearchParams({ Gruppe: "A&B", Status: "2" }).toString();
// inner: Gruppe=A%26B&Status=2
const outer = new URLSearchParams({ name: "BEISPIEL", param: inner });
// outer.toString(): name=BEISPIEL&param=Gruppe%3DA%2526B%26Status%3D2
const received = new URLSearchParams(outer.toString()).get("param");
const group = new URLSearchParams(received).get("Gruppe"); // A&B
```

`%2526` ist hier korrekt: Der innere Wert enthaelt ein kodiertes `&`.
Ein rohes inneres `&` in der aeusseren URL wuerde dagegen einen neuen
Requestparameter beginnen. Ein literales `+` als `%2B` serialisieren;
Querystringparser koennen `+` als Leerzeichen lesen. Nicht vor dem Trennen
der inneren Paare pauschal alles dekodieren, sonst wird ein Werte-`&` zum
Trenner. DOM-Datasets koennen je Frameworkstand zusaetzlich kodiert sein;
vorhandenen Parser nutzen, nicht blind mehrfach kodieren/dekodieren.

In der gespeicherten `PARAMSTRING`-Datei steht nur der innere String, hier
`Gruppe=A%26B&Status=2`, ohne `param=` oder `localparam=`. Eine Laufzeitaenderung
von `dataset.localparam` speichert dieses ERP-Feld nicht; fuer sichtbare neue
Querydaten ist der passende Query-Reload des vorhandenen Frameworks noetig.
URL-Kodierung ersetzt weder SQL-Quoting noch SQL-Escaping: Ob etwa `A` oder
`'A'` erwartet wird, entscheidet die SQL-Platzhalterstelle. Die Beispiele
zeigen Transport, keine Freigabe fuer beliebige SQL-Eingaben oder Rechte.

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

