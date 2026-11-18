# Anonymisierte APplus-Muster

Die folgenden Muster verdichten Beobachtungen aus lokalen Quickview-, Flow-
und Integrationsbeispielen. Projekt-, Dashboard- und Query-Namen, GUIDs,
URLs, Geschäftsbelege und produktive Werte sind entfernt oder durch
Platzhalter ersetzt. Die Beispiele sind keine allgemeine APplus-Spezifikation:
Syntax und Laufzeitverhalten am aktuellen Projekt und Zielsystem prüfen.

## 1. Eine Query, mehrere Dashboardelemente

Eine gemeinsame `QVQUERY` kann in mehreren `QVDASHBOARDQUERY`-Zuordnungen
verwendet werden. Jede Zuordnung kann eigene Parameter und Diagrammoptionen
haben. Die Query-GUID bezeichnet die gemeinsame Query; jede Verwendung hat
eine eigene Zuordnungs-GUID.

- Für einen Filter nur eines Elements die zugehörige
  `QVDASHBOARDQUERY.PARAMSTRING` bearbeiten.
- Eine Änderung an `QVQUERY.STATEMENT` oder `QVQUERY.OPTIONS` betrifft die
  gemeinsame Query und kann alle verwendenden Elemente beeinflussen.
- Bei der Dateizuordnung immer die `QVDASHBOARDQUERY`-GUID aus dem Index
  verwenden, nicht die GUID der Query.

Anonymisiertes Muster für eine Zuordnung:

```text
State=2,4&Group='ALPHA'%2C'BETA'
```

In einem untersuchten Parametervertrag wurden numerische Listen ohne Quotes
und SQL-quotierte Textlisten verwendet; `%2C` repräsentierte innerhalb eines
Werts das Listenkomma. Ob diese Form für eine konkrete Query gilt, ergibt sich
aus deren `$P{...}`-Platzhaltern, Query-Options-Defaults und der
URL-Dekodierung im Zielsystem. `&` bleibt Paartrenner. Werte einzeln und
kontextgerecht kodieren, nicht den gesamten Parameterstring mehrfach kodieren.

## 2. Query-Default und Elementfilter zusammen

Ein untersuchtes Query-Options-XML definierte einen Parameter ohne
Defaulttext:

```xml
<config>
  <parameter>
    <p name="category" />
  </parameter>
</config>
```

Das Query-SQL verwendete den Parameter in einem Ausdruck nach dem Muster
`column = NULLIF('$P{category}', '')`. Bei leerem Default wird daraus ein
Vergleich mit `NULL`, der keine Zeile als Treffer liefert. Das leere XML-
Default, ein fehlendes Optionsfeld und ein fehlender `PARAMSTRING`-Schlüssel
sind verschiedene Situationen. Vor einer Änderung die tatsächliche
SQL-Ersetzung und Parameterpriorität des Zielsystems prüfen.

## 3. Query-Chart und Elementdarstellung

In untersuchten Chart-Queries lagen Gruppierung und Measure in
`QVQUERY.OPTIONS` unter einer `config/chart`-Struktur. Der darin genannte
Gruppenschlüssel und Measure-Alias mussten zu den Spaltenaliasen des
Query-SQL passen.

Davon getrennt lieferte `QVDASHBOARDQUERY.CHARTOPTIONS` im untersuchten
Chartpfad JSON-Optionen für das einzelne Element; `JSCHARTSCRIPT` war
ausführbarer JavaScript-Code. Daher:

1. Query-Chartdefinition, Query-SQL-Aliasse und Elementoptionen getrennt
   identifizieren.
2. Keine `CHARTOPTIONS`-Inhalte als JavaScript ausführen oder mit einer
   JavaScript-Hülle umgeben, nur weil die lokale Endung `.js` lautet.
3. Vorhandenes JSON und die tatsächlich installierte Chartintegration
   prüfen; der Sync validiert weder XML noch JSON.

## 4. Eingebettetes Quickview mit Fachdatensatz

Ein eingebettetes Quickview kann seinen Fachkontext über mehrere Ebenen
erhalten: Dashboardaufruf, verschachtelte Parameter, technische
Kontextknoten und elementbezogene lokale Parameter. Die sichtbare URL allein
ist dann keine vollständige Quelle.

Anonymisiertes Vorgehen:

1. Fachseite, geladenes Quickview und den tatsächlich angezeigten Datensatz
   bestimmen.
2. Queryparameter und technische Übergabe im bestehenden Element verfolgen.
3. Nur den eigenen Query-/Viewbereich aktualisieren; Ladeelemente, globale
   Kontextdaten und die umgebende Fachseite erhalten.
4. Datensatzwechsel, fehlenden Kontext und wiederholtes Laden testen.

Element-GUID, Dashboard-GUID, Query-GUID und fachliche Datensatz-ID sind
unterschiedliche Identitäten. Eine davon nicht aus einer anderen ableiten.

## 5. Flow-Karte und dynamische Lane

In untersuchten Flows stammten Kartenwerte aus SQL-Aliasen; XML-Templates
referenzierten diese Werte in einem kontextspezifischen Binding. Dialogwerte
und dynamische SQL-Werte verwendeten andere Bindungsformen.

Wenn eine Aktion eine Karte in eine dynamische Lane verschiebt, können
mehrere Fachfelder — etwa verantwortliche Ressource, Priorität und Status —
gemeinsam die Ziel-Lane bestimmen. Nur ein sichtbares Feld zu aktualisieren
belegt daher keinen korrekten Lanewechsel. SQL, XML-Templates, Dialogscope und
die vollständige Aktionsfolge gemeinsam prüfen.

Ein SQL-Alias, ein Dialogergebnis und eine dynamische Variable nicht
vertauschen. Beim Umbenennen eines Alias alle XML- und JavaScript-
Konsumenten nachziehen. Lane- oder Statuswerte nicht aus dem UI erfinden.

## 6. Gruppierte Fertigungspositionen und Nachfolgeaktionen

Ein anonymisiertes Fertigungsmuster zeigt zwei leicht verwechselbare
Datensatzarten:

- eine wiederverwendbare Stammdaten-Komponentenposition;
- eine konkrete Komponentenposition eines Fertigungsauftrags.

Eine gruppierte Anzeige hebt die Identität einzelner Auftragspositionen nicht
auf. Für Zuordnung und Buchung die konkrete Positions-ID/GUID erhalten und
nicht die Stammdaten-ID als Ersatz verwenden.

Wenn eine bestätigte Auswahl zuerst eine neue Serien-/Chargenidentität
erzeugt und anschließend eine Buchung davon abhängt, die Schritte sequenzieren.
Nach einem Fehler des Folgeschritts kann der erste Schritt bereits erfolgt
sein. Vor einer Wiederholung den bestehenden Zustand lesen und dieselbe
Identität wiederverwenden, statt unkontrolliert Duplikate zu erzeugen.
Mengen-, Gruppierungs- und Rundungsregeln bleiben fach- und projektspezifisch.

## 7. Dokumentmetadaten und Uploadbestätigung

Ein untersuchter Dokumentlistenpfad lieferte JSON-Strukturen, obwohl sein
Name ein XML-Format nahelegte; einzelne Felder waren zusätzlich als
Schlüssel/Wert-Paare verpackt. Daher Antworttyp und Wrapper anhand der
tatsächlichen Antwort normalisieren, nicht aus Methoden- oder Dateinamen
ableiten. Parsefehler sichtbar melden und nicht als „keine Dokumente“
interpretieren.

Eine fachliche Datensatz-ID ist keine DMS-Dokument-ID. Beim Vorschau- oder
Downloadpfad eine explizite, validierte Dokument-ID bevorzugen und keine ID
aus Dateiname oder fremder URL raten.

Ein HTTP-Erfolg oder das Schließen eines Uploaddialogs belegt nicht zwingend
die erfolgreiche Dokumentablage. Bestätigten Erfolg, Fehler und unklaren
Ausgang unterscheiden. Bei unklarem Ausgang keine blinde Wiederholung
starten, wenn dadurch Duplikate entstehen können.

