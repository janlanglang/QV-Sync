# Projektdokumentation und Vorschauen

## Dokumentation

- Vorhandene passende Projektdokumentation aktualisieren, statt parallele
  Wahrheiten oder leere Dokumentgerüste anzulegen. Übliche Ablage ist `doc/`
  im zugehörigen Projektkontext; bestehende Ablageorte nicht ungefragt
  verschieben.
- Ist-Verhalten, gewünschtes Verhalten, Entwurf und offene Fragen trennen.
  Betriebsmodus (eigenständiges Quickview, eingebettetes Quickview oder
  Flowboard), relevante Query/Board-Dateien und Parameterquellen benennen.
- Nachweis klar kennzeichnen: Quellcode gelesen, lokal getestet, Export
  untersucht oder in einer freigegebenen Umgebung live geprüft. Ein
  vorhandenes Testergebnis nicht als selbst ausgeführt darstellen.
- Bei Datenverträgen Tabellen-/Feldnamen, ID-/GUID-Arten, Parameterquellen,
  SQL-Aliasse, JSON-/XML-Form, Leerwerte und relevante Rechte festhalten.
  Bei Änderungen über mehrere Dateien den gekoppelten Ablauf und Fehlerpfad
  beschreiben.
- Beispiele anonymisieren. Keine Zugangsdaten, Tokens, echten Kundendaten,
  produktiven Payloads oder unbereinigten Screenshots aufnehmen.
- Markdown ist nicht automatisch eine vom Sync verwaltete Ressource. Nur der
  Index entscheidet, ob Änderungen an einer Datei zurückgeschrieben werden.

## Vorschauen

Browserwerkzeuge können eine lesende Vorschau der laufenden APplus-Oberfläche
liefern. Vorher Zielsystem und vollständigen Kontext aus Nutzerangaben und
wirksamen Projekteinstellungen bestimmen. Keine Host- oder Navpage-Adresse
aus Dashboardname, GUID oder einer anderen Umgebung erraten.

- Beim eingebetteten Quickview müssen Fachseite, konkreter Fachdatensatz und
  Einbettung geklärt sein. Eine isolierte Dashboardseite ersetzt keine
  Prüfung in der Fachmaske.
- Eine Vorschau zeigt normalerweise den laufenden ERP-Stand, nicht
  automatisch ungespeicherte lokale Dateien; sie ist keine Sandbox.
- Keine Vorschau durch ungefragten ERP-Upload, Reload oder schreibende
  Aktionen erzwingen. Keine Buchungen, Kartenaktionen, Jobs oder
  Dokumentenuploads ausführen, sofern das nicht ausdrücklich beauftragt und
  für einen kontrollierten Test freigegeben ist.
- Bei fehlender Verbindung oder Anmeldung die Grenze benennen. Credentials
  nicht in URLs einfügen oder Schutzmaßnahmen umgehen.
- Ergebnis auseinanderhalten: Linkvorlage, tatsächlich geöffnete Seite und
  verifizierte UI-Abnahme sind unterschiedliche Nachweise.

## Kompakte Vorlage für eine Fachänderung

Nur passende Abschnitte verwenden und keine leere Vorlage im Projekt ablegen:

```markdown
# <Funktion>

Stand: <Datum>. Nachweis: <Code / lokale Tests / freigegebene Liveprüfung>.

## Zweck und Betriebsmodus
<Eigenständiges Quickview, navview in welcher Fachseite oder Flowboard.>

## Dateien und Datenvertrag
<Query/Board, Tabelle, ID-/GUID-Arten, Parameter, Aliasse und Datenform.>

## Ablauf und Fehlerbehandlung
<Laden, Rendern, Datensatzwechsel, Abbruch, Teilerfolg und Cleanup.>

## Plugin und Prüfung
<Was ist indiziert? Kann Speichern ins ERP schreiben? Welche Tests liefen?>
<Offene Laufzeit- oder Liveprüfung.>
```

Ist-Code, lokale Tests und Dokumentation können voneinander abweichen. Den
Widerspruch sichtbar machen und anhand des Zielvertrags klären, nicht
automatisch den Code an eine ältere Dokumentation anpassen.

