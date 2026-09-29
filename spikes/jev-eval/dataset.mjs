// Ground-truth dataset for the Jev spike, modeled on FiBuKI's real decision
// tasks. `expected` is the strict answer; `accept` widens it for genuinely
// ambiguous cases (reported separately as lenient accuracy).

export const DOC_TYPES = {
  invoice: "A tax invoice (Rechnung) issued to request or document payment; has issuer, amount, usually VAT",
  receipt: "A point-of-sale receipt (Kassenbon/Beleg) printed at purchase time in a shop, restaurant, parking, etc.",
  credit_note: "A credit note (Gutschrift/Storno-Rechnung) issued by a supplier reversing or reducing a prior invoice",
  reminder: "A payment reminder or dunning letter (Mahnung/Zahlungserinnerung) about an unpaid invoice",
  bank_statement: "A bank account statement (Kontoauszug) listing account transactions and balances",
  quote: "A quote or cost estimate (Angebot/Kostenvoranschlag) offering goods/services before any sale",
  other: "None of the above: order confirmations, delivery notes, contracts, payment confirmations, marketing",
};

export const DOCS = [
  {
    id: "at-invoice-standard", expected: "invoice",
    text: `RECHNUNG Nr. 2026-0142\nMuster IT Consulting e.U.\nInhaber: Thomas Muster\nHauptstraße 12, 4020 Linz\nUID: ATU61234567\n\nRechnungsempfänger:\nWild Digital GmbH, Praterstraße 1, 1020 Wien\n\nRechnungsdatum: 15.09.2026\nLeistungszeitraum: 01.09.-14.09.2026\n\nPos 1: IT-Beratung, 24 Std à EUR 120,00 .... EUR 2.880,00\nNettobetrag: EUR 2.880,00\nzzgl. 20% USt: EUR 576,00\nGesamtbetrag: EUR 3.456,00\n\nZahlbar binnen 14 Tagen auf IBAN AT61 1904 3002 3457 3201`,
  },
  {
    id: "rewe-kassenbon", expected: "receipt",
    text: `BILLA Dankt\nBILLA AG, IZ NOe Sued Strasse 3\n2355 Wiener Neudorf\n\nJa! Natuerlich Milch 1L    1,49 B\nSemmel                     0,45 B\nKaffee Bio 500g            8,99 A\n---------------------------------\nSUMME EUR                 10,93\nBankomat                  10,93\n\nMwSt A 20%: 1,50  MwSt B 10%: 0,18\nTSE-Signatur: QR-Code\nBon-Nr: 4711 Kasse 02 27.09.2026 17:42`,
  },
  {
    id: "restaurant-rechnung", expected: "receipt", accept: ["invoice"],
    text: `Gasthaus zur Linde\nLindengasse 4, 1070 Wien\nATU12345678\n\nRECHNUNG #08841 Tisch 7\n2x Wiener Schnitzel     35,80\n1x Gr. Apfelsaft g'spritzt  4,20\n2x Melange               9,00\nSumme:                  49,00\ninkl. 10% MwSt: 4,45\n\nBar bezahlt: 55,00 (inkl. Trinkgeld)\n27.09.2026 13:15 Kellner: M`,
  },
  {
    id: "gutschrift-supplier", expected: "credit_note",
    text: `GUTSCHRIFT Nr. GS-2026-018\nBüroBedarf Handels GmbH, UID ATU55511122\n\nzu Rechnung RE-2026-1044 vom 02.09.2026\nGrund: Retoure defekter Bürostuhl\n\nGutschriftsbetrag netto: EUR -249,00\nUSt 20%: EUR -49,80\nGesamt: EUR -298,80\n\nDer Betrag wird auf Ihr Konto rücküberwiesen.`,
  },
  {
    id: "storno-rechnung", expected: "credit_note", accept: ["invoice"],
    text: `STORNO-RECHNUNG Nr. 2026-0142-S\nMuster IT Consulting e.U., UID ATU61234567\n\nStorno zu Rechnung 2026-0142 vom 15.09.2026\nPos 1: IT-Beratung, 24 Std à EUR 120,00 .... EUR -2.880,00\nNettobetrag: EUR -2.880,00\n20% USt: EUR -576,00\nGesamtbetrag: EUR -3.456,00`,
  },
  {
    id: "mahnung", expected: "reminder",
    text: `2. MAHNUNG\n\nSehr geehrte Damen und Herren,\n\ntrotz unserer Zahlungserinnerung vom 10.09.2026 ist die Rechnung Nr. 2026-0089 vom 12.08.2026 über EUR 1.140,00 noch offen.\n\nWir bitten um Überweisung bis spätestens 05.10.2026 zzgl. Mahnspesen EUR 15,00.\nBei Nichtzahlung übergeben wir die Forderung unserem Inkassobüro.`,
  },
  {
    id: "zahlungserinnerung", expected: "reminder",
    text: `Zahlungserinnerung\n\nLiebe Kundin, lieber Kunde,\n\nsicher ist es Ihrer Aufmerksamkeit entgangen: unsere Rechnung R-4471 vom 01.09.2026 über EUR 89,90 ist noch nicht beglichen. Wir bitten höflich um Ausgleich innerhalb von 7 Tagen. Sollte sich die Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es als gegenstandslos.`,
  },
  {
    id: "kontoauszug", expected: "bank_statement",
    text: `Erste Bank der oesterreichischen Sparkassen AG\nKontoauszug 09/2026\nKonto: AT48 2011 1000 0342 2261 Girokonto\n\n01.09. Gehalt Wild Digital GmbH        +3.412,55\n03.09. REWE Dankt Filiale 4402            -54,20\n05.09. Miete Hausverwaltung Nowak      -1.150,00\n15.09. A1 Telekom Austria                 -39,90\n\nAlter Saldo: 2.201,10  Neuer Saldo: 4.369,55`,
  },
  {
    id: "angebot", expected: "quote",
    text: `ANGEBOT Nr. A-2026-77\nTischlerei Holzmann GmbH, 5020 Salzburg\n\nSehr geehrter Herr Muster,\n\nwie besprochen bieten wir an:\nSchreibtisch Eiche massiv, 180x80 ... EUR 1.890,00 netto\nLieferung und Montage ............... EUR 120,00 netto\n\nAngebot gültig bis 31.10.2026. Preise zzgl. 20% USt.\nWir freuen uns auf Ihren Auftrag!`,
  },
  {
    id: "en-saas-invoice", expected: "invoice",
    text: `INVOICE\nLinear Orbit Inc.\n548 Market St, San Francisco, CA\n\nBill to: Wild Digital GmbH, Vienna, Austria\nInvoice #INV-99231  Date: Sep 1, 2026\nBilling period: Sep 2026\n\nTeam plan, 12 seats x $14.00 ....... $168.00\nSubtotal: $168.00\nVAT (reverse charge, Art 196 EU VAT Directive): $0.00\nTotal due: $168.00\nPaid via card ending 4242`,
  },
  {
    id: "ocr-noisy-invoice", expected: "invoice",
    text: `R E C H N U N G Nr, 2O26/O88\nKFZ-VVerkstatt Ber9er Gmbh\nUlD: ATU4432l098\n\nRep@ratur Bremsen VW Cadd»\nArbeitszeit 3,5 5td ........ l92,50\nMateria1 Bremsbeläge ........ 8O,OO\nNett0 272,5O\nU5t 2O% 54,5O\nGE5AMT EUR 327,OO\nZahlbar prompt netto Kassa`,
  },
  {
    id: "bestellbestaetigung", expected: "other",
    text: `Bestellbestätigung\n\nVielen Dank für Ihre Bestellung bei OfficeDirect!\nBestellnummer: BD-88123 vom 26.09.2026\n\n1x Monitor 27" 4K ... EUR 429,00\nVoraussichtliche Lieferung: 30.09.2026\nDie Rechnung erhalten Sie separat nach Versand der Ware.`,
  },
  {
    id: "lieferschein", expected: "other",
    text: `LIEFERSCHEIN Nr. LS-2026-3341\nGroßhandel Steiner GmbH\n\nLieferadresse: Wild Digital GmbH, Praterstraße 1, 1020 Wien\n\n10x Druckerpapier A4 500 Blatt\n2x Toner HP 305X schwarz\n\nWarenübernahme bestätigt: ____________\nPreise laut gesonderter Rechnung.`,
  },
  {
    id: "paypal-confirmation", expected: "other",
    text: `PayPal\n\nSie haben eine Zahlung über 24,99 EUR an Spotify AB gesendet.\nTransaktionscode: 7XK882910L334\nDatum: 25. September 2026\n\nDies ist eine Zahlungsbestätigung, keine Rechnung. Ihre Rechnung erhalten Sie vom Händler.`,
  },
  {
    id: "amazon-invoice", expected: "invoice",
    text: `Amazon EU S.à r.l., Niederlassung Deutschland\nRechnung\n\nRechnungsnummer: DS-AEU-INV-DE-2026-448291\nBestellnummer: 028-4419001-2231148\nRechnungsdatum: 20.09.2026\n\nLogitech MX Master 3S ... 89,99 EUR (inkl. 20% USt)\nZwischensumme (netto): 74,99 EUR\nUSt 20%: 15,00 EUR\nRechnungsbetrag: 89,99 EUR\nUID des Verkäufers: ATU66296505`,
  },
  {
    id: "hotel-rechnung", expected: "invoice",
    text: `Hotel Goldener Hirsch, Salzburg\nRECHNUNG 2026/5512\nGast: Max Muster, Wild Digital GmbH\n\n2 Nächte EZ Komfort 24.-26.09.2026 à 145,00 ... 290,00\nOrtstaxe ... 3,00\nGesamt EUR 293,00\ndavon 10% USt (Nächtigung): 26,36\nBezahlt mit Visa ****8812\nUID: ATU33847201`,
  },
  {
    id: "parkschein", expected: "receipt",
    text: `WIPARK Garagen GmbH\nGarage Freyung 1010 Wien\n\nPARKENTGELT\nEinfahrt: 27.09.2026 09:12\nAusfahrt: 27.09.2026 11:47\nDauer: 2:35\n\nEntgelt: EUR 12,40 inkl. 20% USt (2,07)\nBeleg 118842 Automat 3 Kartenzahlung`,
  },
  {
    id: "proforma", expected: "other", accept: ["invoice", "quote"],
    text: `PROFORMA-RECHNUNG Nr. PF-2026-09\nExportech Handels GmbH\n\nNur für Zollzwecke - kein Steuerausweis, begründet keine Zahlungspflicht.\n\n5x Sensormodul XT-100 ... EUR 1.250,00\nGesamtwert: EUR 1.250,00\nUrsprungsland: Österreich`,
  },
  {
    id: "vertrag", expected: "other",
    text: `WERKVERTRAG\n\nabgeschlossen zwischen Wild Digital GmbH (Auftraggeber) und Design Studio Nord e.U. (Auftragnehmer).\n\n§1 Leistungsgegenstand: Gestaltung des Erscheinungsbilds...\n§2 Honorar: Das Honorar beträgt EUR 8.000 zzgl. USt, zahlbar in zwei Teilbeträgen.\n§3 Termine: Fertigstellung bis 15.12.2026.\n\nWien, am 20.09.2026, Unterschriften`,
  },
  {
    id: "bank-gutschrift-advice", expected: "other", accept: ["bank_statement", "credit_note"],
    text: `Raiffeisenlandesbank OÖ\nGutschriftsanzeige\n\nWir haben Ihrem Konto AT12 3400 0000 0123 4567 gutgeschrieben:\nBetrag: EUR 2.400,00\nAuftraggeber: Kunde Maier Projekt GmbH\nVerwendungszweck: RE 2026-31\nValuta: 26.09.2026`,
  },
  {
    id: "netflix-en-receipt", expected: "invoice", accept: ["receipt", "other"],
    text: `Netflix International B.V.\nTax Invoice / Receipt\n\nInvoice date: September 15, 2026\nMember: member@example.com\nStandard plan 15.09-14.10.2026 ... EUR 13.99\nVAT 20% (AT) included: EUR 2.33\nTotal charged to card: EUR 13.99\nVAT No: EU372060011`,
  },
];

// --- Column matching, modeled on lib/import/field-definitions.ts ---
export const COLUMN_FIELDS = {
  date: "Transaction/booking date column",
  amount: "The main transaction amount (signed or unsigned monetary value)",
  name: "Description or booking text of the transaction",
  partner: "Counterparty/partner name",
  reference: "Payment reference or transaction ID",
  partnerIban: "Counterparty IBAN",
  partnerBic: "Counterparty BIC/SWIFT code",
  category: "Bank-assigned category or transaction type",
  balance: "Account balance after the transaction",
  ignore: "Not a useful field for import (internal codes, duplicated currency columns, empty)",
};

export const CSVS = [
  {
    id: "erste-george",
    columns: [
      { header: "Buchungsdatum", samples: ["01.09.2026", "03.09.2026", "15.09.2026"], expected: "date" },
      { header: "Partnername", samples: ["REWE Dankt Filiale 4402", "A1 Telekom Austria AG", "Hausverwaltung Nowak"], expected: "partner" },
      { header: "Partner IBAN", samples: ["AT611904300234573201", "", "DE89370400440532013000"], expected: "partnerIban" },
      { header: "BIC/SWIFT", samples: ["GIBAATWWXXX", "", "COBADEFFXXX"], expected: "partnerBic" },
      { header: "Betrag", samples: ["-54,20", "-39,90", "+3.412,55"], expected: "amount" },
      { header: "Währung", samples: ["EUR", "EUR", "EUR"], expected: "ignore", accept: ["category"] },
      { header: "Buchungstext", samples: ["POS 4402 K1 27.09. REWE DANKT", "A1 Rechnung 09/26", "Miete Oktober"], expected: "name" },
      { header: "Zahlungsreferenz", samples: ["RF48 0000 1122 33", "", "MREF-99812"], expected: "reference" },
      { header: "Saldo", samples: ["4.369,55", "4.315,35", "2.201,10"], expected: "balance" },
    ],
  },
  {
    id: "n26-export",
    columns: [
      { header: "Date", samples: ["2026-09-01", "2026-09-05", "2026-09-14"], expected: "date" },
      { header: "Payee", samples: ["Amazon EU", "Shell Tankstelle", "Anna Gruber"], expected: "partner" },
      { header: "Account number", samples: ["DE89370400440532013000", "", "AT483200000012345864"], expected: "partnerIban" },
      { header: "Transaction type", samples: ["MasterCard Payment", "Direct Debit", "Outgoing Transfer"], expected: "category" },
      { header: "Payment reference", samples: ["", "Order 028-441", "Rueckzahlung Mittagessen"], expected: "reference" },
      { header: "Amount (EUR)", samples: ["-89.99", "-64.10", "25.00"], expected: "amount" },
      { header: "Amount (Foreign Currency)", samples: ["", "", ""], expected: "ignore" },
    ],
  },
  {
    id: "legacy-soll-haben",
    columns: [
      { header: "Valuta", samples: ["27.09.26", "26.09.26", "22.09.26"], expected: "date" },
      { header: "Text", samples: ["AUTOMAT 00447 K2", "SEPA-LASTSCHRIFT WIENER STAEDTISCHE", "UEBERWEISUNG DANKE"], expected: "name", accept: ["partner"] },
      { header: "Soll", samples: ["120,00", "", "45,80"], expected: "amount", accept: ["ignore"] },
      { header: "Haben", samples: ["", "2.400,00", ""], expected: "amount", accept: ["ignore"] },
      { header: "KtoNr", samples: ["00234573201", "00234573201", "00234573201"], expected: "ignore" },
    ],
  },
];

// --- Partner matching: extracted vendor vs existing partner list ---
export const PARTNER_CANDIDATES = {
  p1: "A1 Telekom Austria AG (telecom provider, UID ATU62895905)",
  p2: "A1 Digital International GmbH (cloud services)",
  p3: "BILLA AG (supermarket, REWE Group Austria)",
  p4: "REWE International AG (retail group headquarters)",
  p5: "Shell Austria GmbH (fuel stations)",
  p6: "Hausverwaltung Nowak KG (property management, monthly rent)",
  p7: "Spotify AB (music streaming, Sweden)",
  p8: "Wiener Städtische Versicherung AG (insurance)",
  none: "No existing partner matches this vendor",
};

export const PARTNER_CASES = [
  { id: "a1-invoice", state: "Invoice from: A1 Telekom Austria AG, Lassallestraße 9, 1020 Wien, UID ATU62895905. Mobilfunkrechnung 09/2026, EUR 39,90.", expected: "p1" },
  { id: "billa-bon", state: "Receipt header: 'BILLA Dankt, BILLA AG, IZ NOe Sued Strasse 3, 2355 Wiener Neudorf'. Groceries EUR 10,93.", expected: "p3" },
  { id: "rewe-pos-text", state: "Bank transaction counterparty text: 'POS 4402 K1 REWE DANKT 2355'. Amount EUR -54,20. (Note: REWE POS terminals in Austria are BILLA stores.)", expected: "p3", accept: ["p4"] },
  { id: "ocr-mangled-a1", state: "OCR of invoice header: 'Al Te1ekom Austr!a AG, Mobi1funkrechnung, Kundennr 883-112'. EUR 39,90 monthly.", expected: "p1" },
  { id: "unknown-vendor", state: "Invoice from: Tischlerei Holzmann GmbH, Salzburg. Schreibtisch Eiche massiv EUR 1.890,00.", expected: "none" },
  { id: "insurance-sepa", state: "Bank booking text: 'SEPA-LASTSCHRIFT WIENER STAEDTISCHE VERSICHERUNG POLIZZE 88-1123', EUR -45,80 monthly.", expected: "p8" },
];

// --- Match verification (Noul): does this document belong to this transaction? ---
export const MATCH_CASES = [
  {
    id: "exact-match", expected: true,
    state: { transaction: { date: "2026-09-20", amount: -89.99, currency: "EUR", partner: "Amazon EU", text: "AMAZON.DE 028-4419001" }, document: { type: "invoice", date: "2026-09-20", total: 89.99, currency: "EUR", vendor: "Amazon EU S.à r.l.", orderNumber: "028-4419001-2231148" } },
  },
  {
    id: "tip-difference", expected: true,
    state: { transaction: { date: "2026-09-27", amount: -55.0, currency: "EUR", partner: "Gasthaus zur Linde", text: "POS GASTHAUS LINDE WIEN" }, document: { type: "receipt", date: "2026-09-27", total: 49.0, currency: "EUR", vendor: "Gasthaus zur Linde", note: "cash paid 55.00 incl. tip" } },
  },
  {
    id: "card-settlement-lag", expected: true,
    state: { transaction: { date: "2026-09-29", amount: -12.4, currency: "EUR", partner: "", text: "POS WIPARK GARAGE FREYUNG 27.09." }, document: { type: "receipt", date: "2026-09-27", total: 12.4, currency: "EUR", vendor: "WIPARK Garagen GmbH" } },
  },
  {
    id: "same-amount-wrong-partner", expected: false,
    state: { transaction: { date: "2026-09-15", amount: -39.9, currency: "EUR", partner: "Magenta Telekom", text: "MAGENTA RECHNUNG 09/26" }, document: { type: "invoice", date: "2026-09-15", total: 39.9, currency: "EUR", vendor: "A1 Telekom Austria AG" } },
  },
  {
    id: "currency-mismatch", expected: false,
    state: { transaction: { date: "2026-09-01", amount: -168.0, currency: "EUR", partner: "Linear Orbit", text: "LINEAR ORBIT SF USD 168.00 CARD" }, document: { type: "invoice", date: "2026-09-01", total: 168.0, currency: "USD", vendor: "Linear Orbit Inc." } },
    accept: [true],
  },
  {
    id: "different-month-same-vendor", expected: false,
    state: { transaction: { date: "2026-08-15", amount: -13.99, currency: "EUR", partner: "Netflix", text: "NETFLIX.COM" }, document: { type: "invoice", date: "2026-09-15", total: 13.99, currency: "EUR", vendor: "Netflix International B.V.", period: "15.09-14.10.2026" } },
  },
];
