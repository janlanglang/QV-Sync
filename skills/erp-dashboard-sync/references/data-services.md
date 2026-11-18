# ERP-Daten und Dienste: Sicherheits- und Datenverträge

Diese Hinweise gelten, wenn ein materialisiertes Quickview oder Flow
zusätzliche ERP-Daten liest oder Aktionen auslöst. Sie ersetzen weder die
Dokumentation der Zielinstallation noch die Prüfung des konkreten Dienstes.

## Lesen und Datenform

- Vorhandene Projekthelper und freigegebene Querypfade bevorzugen. Keine
  neue SOAP-, SQL- oder `app.*`-API erfinden, nur weil sie in einer anderen
  APplus-Installation verwendet wird.
- Eine erfolgreiche HTTP-/SOAP-Antwort kann fachlich dennoch fehlerhaft oder
  unerwartet geformt sein. Antworttyp, Pflichtfelder und JSON/XML-Struktur
  prüfen; Transport-, Parse- und Berechtigungsfehler nicht als leere
  Ergebnisliste darstellen.
- Nicht gleichsetzen: Primärschlüssel, fachliche ID, GUID, Belegnummer,
  Board-Kartenkennung und Dokument-ID können verschiedene Identitäten sein.
  Zuordnung aus Datenvertrag und Index nehmen.
- Für wiederverwendbare SQL-/Queryänderungen Spaltenaliase, Datentyp,
  NULL/leer, Kardinalität und Ergebnisform dokumentieren. Neue Felder oder
  Statuscodes nicht aus dem UI ableiten.
- IDs und SQL-Identifier nicht aus unkontrollierter Nutzereingabe bilden.
  SQL-Werte, Identifier, URL, XML, HTML und JavaScript brauchen jeweils
  passende Validierung und Serialisierung.

## Schreibende Aktionen

- Fachliche Buchungen über nachgewiesene Fachservices durchführen. Direkte
  Tabellenupdates sind kein Ersatz für Geschäftslogik, Berechtigungsprüfung
  oder Statusübergänge.
- Vor einem Update Datensatz, fachlichen Zustand, Rechte und Pflichtfelder
  prüfen. Wenn der Vertrag optimistisches Locking verlangt, aktuellen
  Timestamp genau nach dokumentiertem Format lesen und verwenden.
- Abhängige Schreibschritte sequenzieren. Antwort und Rückgabewert prüfen;
  bei erforderlicher Folgeaktion erneut lesen und den aktuellen Zustand
  verifizieren.
- Mehrere SOAP-/HTTP-Aufrufe bilden keine implizite Transaktion. Bei Teilfehler
  den bereits erreichten Zustand benennen und keine unkontrollierten
  Wiederholungen starten.
- UI-Sichtbarkeit und Clientkonfiguration ersetzen keine Backendrechte.
  Fehlermeldungen, Abbruch und Sperrzustände explizit behandeln.

## Uploads und Dokumente

Dokumentablage und DMS-Uploads sind keine gewöhnlichen Textfeldänderungen.
Zielzuordnung, Endpoint, Berechtigungen und tatsächliche Serverbestätigung
müssen für das konkrete Projekt belegt sein. HTTP 200, Dialogende oder eine
generische Rückgabe sind nicht automatisch Ablagenachweis. Bei unklarem
Ausgang nicht blind wiederholen, wenn Duplikate oder Buchungen entstehen
können.

Keine echten Buchungen, Jobs, Änderungen oder Uploads zum bloßen Testen
ausführen. Keine Credentials, Tokens, realen Kundendaten oder vollständigen
produktiven Antworten in Skill, Dokumentation oder Tests übernehmen.

