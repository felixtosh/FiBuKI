/**
 * Preset global partners - common companies for tax/accounting purposes
 * Includes FAANG, Austrian companies, and major international corporations
 */

export interface PresetPattern {
  pattern: string;
  field: "partner" | "name";
  confidence: number;
}

export interface PresetPartner {
  name: string;
  aliases: string[];
  country: string;
  website?: string;
  vatId?: string;
  /** Static patterns for matching bank transactions */
  patterns?: PresetPattern[];
}

/**
 * ~275 preset partners organized by category
 */
export const PRESET_PARTNERS: PresetPartner[] = [
  // ============ FAANG / Big Tech (15) ============
  { name: "Apple Inc.", aliases: ["Apple", "Apple Store", "Apple Distribution International"], country: "US", website: "apple.com", vatId: "IE9700053D", patterns: [
    { pattern: "*apple*", field: "name", confidence: 92 },
    { pattern: "*itunes*", field: "name", confidence: 92 },
    { pattern: "*icloud*", field: "name", confidence: 92 },
  ]},
  { name: "Amazon.com, Inc.", aliases: ["Amazon", "Amazon.de", "Amazon Prime", "AWS", "Amazon EU S.à r.l."], country: "US", website: "amazon.com", vatId: "LU20260743", patterns: [
    { pattern: "*amazon*", field: "name", confidence: 92 },
    { pattern: "*amzn*", field: "name", confidence: 92 },
    { pattern: "*prime video*", field: "name", confidence: 90 },
  ]},
  { name: "Alphabet Inc.", aliases: ["Google", "Google Cloud", "YouTube", "Google Ads", "Google Ireland Limited"], country: "US", website: "google.com", vatId: "IE6388047V", patterns: [
    { pattern: "*google*", field: "name", confidence: 92 },
    { pattern: "*youtube*", field: "name", confidence: 92 },
  ]},
  { name: "Meta Platforms, Inc.", aliases: ["Facebook", "Instagram", "WhatsApp", "Meta", "Meta Platforms Ireland Limited"], country: "US", website: "meta.com", vatId: "IE9692928F", patterns: [
    { pattern: "*facebook*", field: "name", confidence: 92 },
    { pattern: "*instagram*", field: "name", confidence: 92 },
    { pattern: "*whatsapp*", field: "name", confidence: 92 },
    { pattern: "*meta platforms*", field: "name", confidence: 92 },
  ]},
  { name: "Netflix, Inc.", aliases: ["Netflix", "Netflix International B.V."], country: "US", website: "netflix.com", patterns: [
    { pattern: "*netflix*", field: "name", confidence: 95 },
  ]},
  { name: "Microsoft Corporation", aliases: ["Microsoft", "Microsoft 365", "Azure", "Microsoft Ireland Operations Limited"], country: "US", website: "microsoft.com", vatId: "IE8256796U", patterns: [
    { pattern: "*microsoft*", field: "name", confidence: 92 },
    { pattern: "*msft*", field: "name", confidence: 90 },
    { pattern: "*azure*", field: "name", confidence: 90 },
  ]},
  { name: "NVIDIA Corporation", aliases: ["NVIDIA", "Nvidia"], country: "US", website: "nvidia.com" },
  { name: "Tesla, Inc.", aliases: ["Tesla", "Tesla Motors", "Tesla Germany GmbH"], country: "US", website: "tesla.com", patterns: [
    { pattern: "*tesla*", field: "name", confidence: 92 },
  ]},
  { name: "Adobe Inc.", aliases: ["Adobe", "Adobe Creative Cloud", "Adobe Systems Software Ireland"], country: "US", website: "adobe.com", patterns: [
    { pattern: "*adobe*", field: "name", confidence: 92 },
  ]},
  { name: "Salesforce, Inc.", aliases: ["Salesforce", "Salesforce.com EMEA Limited"], country: "US", website: "salesforce.com", patterns: [
    { pattern: "*salesforce*", field: "name", confidence: 92 },
  ]},
  { name: "Oracle Corporation", aliases: ["Oracle", "Oracle EMEA Limited"], country: "US", website: "oracle.com" },
  { name: "Intel Corporation", aliases: ["Intel"], country: "US", website: "intel.com" },
  { name: "Cisco Systems, Inc.", aliases: ["Cisco"], country: "US", website: "cisco.com" },
  { name: "IBM Corporation", aliases: ["IBM"], country: "US", website: "ibm.com" },
  { name: "SAP SE", aliases: ["SAP"], country: "DE", website: "sap.com" },

  // ============ Austrian Companies (75) ============
  // Energy & Utilities
  { name: "OMV AG", aliases: ["OMV"], country: "AT", website: "omv.com" },
  { name: "Verbund AG", aliases: ["Verbund"], country: "AT", website: "verbund.com", vatId: "ATU14703908" },
  { name: "Wien Energie GmbH", aliases: ["Wien Energie"], country: "AT", website: "wienenergie.at" },
  { name: "EVN AG", aliases: ["EVN"], country: "AT", website: "evn.at" },
  { name: "Energie Steiermark AG", aliases: ["Energie Steiermark", "E-Steiermark"], country: "AT", website: "e-steiermark.com" },
  { name: "Salzburg AG", aliases: ["Salzburg AG für Energie"], country: "AT", website: "salzburg-ag.at" },
  { name: "KELAG", aliases: ["KELAG-Kärntner Elektrizitäts-AG"], country: "AT", website: "kelag.at" },

  // Banking & Finance (patterns for bank names + common fee terms)
  { name: "Erste Group Bank AG", aliases: ["Erste Bank", "Erste Group", "Sparkasse", "George"], country: "AT", website: "erstegroup.com", patterns: [
    { pattern: "*erste bank*", field: "name", confidence: 90 },
    { pattern: "*erste group*", field: "name", confidence: 88 },
    { pattern: "*sparkasse*", field: "name", confidence: 75 },
    { pattern: "*kontoführung*erste*", field: "name", confidence: 92 },
    { pattern: "*rechnungsabschluss*erste*", field: "name", confidence: 92 },
  ]},
  { name: "Raiffeisen Bank International AG", aliases: ["Raiffeisen", "RBI", "Raiffeisenbank", "Mein ELBA"], country: "AT", website: "rbinternational.com", patterns: [
    { pattern: "*raiffeisen*", field: "name", confidence: 90 },
    { pattern: "*raiffeisenbank*", field: "name", confidence: 92 },
    { pattern: "*kontoführung*raiffeisen*", field: "name", confidence: 92 },
    { pattern: "*rechnungsabschluss*raiffeisen*", field: "name", confidence: 92 },
  ]},
  { name: "BAWAG Group AG", aliases: ["BAWAG", "BAWAG PSK", "easybank", "BAWAG P.S.K."], country: "AT", website: "bawaggroup.com", vatId: "ATU51286308", patterns: [
    { pattern: "*bawag*", field: "name", confidence: 92 },
    { pattern: "*easybank*", field: "name", confidence: 90 },
    { pattern: "*kontoführung*bawag*", field: "name", confidence: 92 },
    { pattern: "*rechnungsabschluss*bawag*", field: "name", confidence: 92 },
  ]},
  { name: "Oberbank AG", aliases: ["Oberbank"], country: "AT", website: "oberbank.at", patterns: [
    { pattern: "*oberbank*", field: "name", confidence: 92 },
  ]},
  { name: "Bank Austria", aliases: ["UniCredit Bank Austria AG", "UniCredit", "BA-CA"], country: "AT", website: "bankaustria.at", vatId: "ATU51507409", patterns: [
    { pattern: "*bank austria*", field: "name", confidence: 92 },
    { pattern: "*bankaustria*", field: "name", confidence: 90 },
    { pattern: "*unicredit*", field: "name", confidence: 85 },
    { pattern: "*kontoführung*austria*", field: "name", confidence: 90 },
  ]},
  { name: "Volksbank Wien AG", aliases: ["Volksbank", "Volksbanken"], country: "AT", website: "volksbank.at", patterns: [
    { pattern: "*volksbank*", field: "name", confidence: 88 },
  ]},

  // Insurance
  { name: "UNIQA Insurance Group AG", aliases: ["UNIQA"], country: "AT", website: "uniqa.at" },
  { name: "Vienna Insurance Group AG", aliases: ["VIG", "Wiener Städtische"], country: "AT", website: "vig.com" },
  { name: "Generali Versicherung AG", aliases: ["Generali"], country: "AT", website: "generali.at" },
  { name: "Allianz Elementar Versicherungs-AG", aliases: ["Allianz"], country: "AT", website: "allianz.at" },
  { name: "Helvetia Versicherungen AG", aliases: ["Helvetia"], country: "AT", website: "helvetia.at" },
  { name: "Merkur Versicherung AG", aliases: ["Merkur"], country: "AT", website: "merkur.at" },
  { name: "Grazer Wechselseitige Versicherung AG", aliases: ["GRAWE"], country: "AT", website: "grawe.at" },

  // Industrial & Manufacturing
  { name: "voestalpine AG", aliases: ["voestalpine", "Voest"], country: "AT", website: "voestalpine.com" },
  { name: "Andritz AG", aliases: ["Andritz"], country: "AT", website: "andritz.com" },
  { name: "Mayr-Melnhof Karton AG", aliases: ["Mayr-Melnhof", "MM Karton"], country: "AT", website: "mm.group" },
  { name: "Lenzing AG", aliases: ["Lenzing"], country: "AT", website: "lenzing.com" },
  { name: "AMAG Austria Metall AG", aliases: ["AMAG"], country: "AT", website: "amag.at" },
  { name: "Semperit AG Holding", aliases: ["Semperit"], country: "AT", website: "semperitgroup.com" },
  { name: "Palfinger AG", aliases: ["Palfinger"], country: "AT", website: "palfinger.com" },
  { name: "Zumtobel Group AG", aliases: ["Zumtobel"], country: "AT", website: "zumtobelgroup.com" },
  { name: "RHI Magnesita N.V.", aliases: ["RHI Magnesita"], country: "AT", website: "rhimagnesita.com" },

  // Telecom & Tech
  { name: "A1 Telekom Austria AG", aliases: ["A1", "A1 Austria", "Telekom Austria", "Yesss"], country: "AT", website: "a1.net", vatId: "ATU62895905" },
  { name: "Magenta Telekom", aliases: ["Magenta", "T-Mobile Austria"], country: "AT", website: "magenta.at", vatId: "ATU45011703" },
  { name: "Hutchison Drei Austria GmbH", aliases: ["Drei", "3 Austria", "Hutchison"], country: "AT", website: "drei.at" },
  { name: "Fabasoft AG", aliases: ["Fabasoft"], country: "AT", website: "fabasoft.com" },
  { name: "S&T AG", aliases: ["S&T", "Kontron"], country: "AT", website: "snt.at" },

  // Retail & Consumer
  { name: "SPAR Österreichische Warenhandels-AG", aliases: ["SPAR", "Interspar", "Eurospar"], country: "AT", website: "spar.at" },
  { name: "REWE International AG", aliases: ["BILLA", "BIPA", "Merkur", "Penny", "REWE"], country: "AT", website: "rewe-group.at" },
  { name: "Hofer KG", aliases: ["Hofer", "ALDI Süd Austria"], country: "AT", website: "hofer.at" },
  { name: "Lidl Österreich GmbH", aliases: ["Lidl"], country: "AT", website: "lidl.at" },
  { name: "MediaMarkt Austria", aliases: ["MediaMarkt", "Saturn"], country: "AT", website: "mediamarkt.at" },
  { name: "XXXLutz KG", aliases: ["XXXLutz", "Möbelix", "Mömax"], country: "AT", website: "xxxlutz.at" },
  { name: "dm drogerie markt GmbH", aliases: ["dm", "dm Drogerie"], country: "AT", website: "dm.at" },
  { name: "IKEA Austria GmbH", aliases: ["IKEA"], country: "AT", website: "ikea.at" },
  { name: "H&M Austria", aliases: ["H&M", "Hennes & Mauritz"], country: "AT", website: "hm.com" },

  // Transport & Logistics
  { name: "Österreichische Bundesbahnen", aliases: ["ÖBB", "Austrian Federal Railways"], country: "AT", website: "oebb.at" },
  { name: "Österreichische Post AG", aliases: ["Post", "Austrian Post"], country: "AT", website: "post.at", vatId: "ATU46674503" },
  { name: "Flughafen Wien AG", aliases: ["Vienna Airport", "VIE"], country: "AT", website: "viennaairport.com" },
  { name: "Austrian Airlines AG", aliases: ["Austrian Airlines", "Austrian", "AUA"], country: "AT", website: "austrian.com" },
  { name: "Wiener Linien GmbH & Co KG", aliases: ["Wiener Linien"], country: "AT", website: "wienerlinien.at" },

  // Real Estate & Construction
  { name: "IMMOFINANZ AG", aliases: ["IMMOFINANZ"], country: "AT", website: "immofinanz.com" },
  { name: "CA Immobilien Anlagen AG", aliases: ["CA Immo"], country: "AT", website: "caimmo.com" },
  { name: "S IMMO AG", aliases: ["S IMMO"], country: "AT", website: "simmoag.at" },
  { name: "PORR AG", aliases: ["PORR"], country: "AT", website: "porr-group.com" },
  { name: "STRABAG SE", aliases: ["STRABAG"], country: "AT", website: "strabag.com" },

  // Tourism & Hospitality
  { name: "DO & CO Aktiengesellschaft", aliases: ["DO & CO", "DOCO"], country: "AT", website: "doco.com" },
  { name: "Österreich Werbung", aliases: ["Austrian National Tourist Office"], country: "AT", website: "austria.info" },

  // Food & Beverage
  { name: "Red Bull GmbH", aliases: ["Red Bull"], country: "AT", website: "redbull.com" },
  { name: "Agrana Beteiligungs-AG", aliases: ["AGRANA"], country: "AT", website: "agrana.com" },
  { name: "Brau Union Österreich AG", aliases: ["Brau Union", "Gösser", "Zipfer", "Puntigamer"], country: "AT", website: "brauunion.at" },
  { name: "Stiegl Getränke & Service GmbH", aliases: ["Stiegl"], country: "AT", website: "stiegl.at" },
  { name: "Ottakringer Brauerei", aliases: ["Ottakringer"], country: "AT", website: "ottakringer.at" },
  { name: "Manner GmbH", aliases: ["Manner", "Josef Manner"], country: "AT", website: "manner.com" },

  // ATX & Major Industrials
  { name: "Wienerberger AG", aliases: ["Wienerberger"], country: "AT", website: "wienerberger.com" },
  { name: "AT&S AG", aliases: ["AT&S", "Austria Technologie & Systemtechnik"], country: "AT", website: "ats.net" },
  { name: "Schoeller-Bleckmann Oilfield Equipment AG", aliases: ["SBO", "Schoeller-Bleckmann"], country: "AT", website: "sbo.at" },
  { name: "Kapsch TrafficCom AG", aliases: ["Kapsch"], country: "AT", website: "kapsch.net" },
  { name: "Rosenbauer International AG", aliases: ["Rosenbauer"], country: "AT", website: "rosenbauer.com" },
  { name: "Frequentis AG", aliases: ["Frequentis"], country: "AT", website: "frequentis.com" },
  { name: "PIERER Mobility AG", aliases: ["KTM", "Husqvarna Motorcycles", "PIERER"], country: "AT", website: "pierermobility.com" },
  { name: "Egger Holzwerkstoffe GmbH", aliases: ["EGGER", "Egger Holz"], country: "AT", website: "egger.com" },
  { name: "Doppelmayr Seilbahnen GmbH", aliases: ["Doppelmayr", "Garaventa"], country: "AT", website: "doppelmayr.com" },
  { name: "D. Swarovski KG", aliases: ["Swarovski"], country: "AT", website: "swarovski.com" },
  { name: "Borealis AG", aliases: ["Borealis"], country: "AT", website: "borealisgroup.com" },
  { name: "Fronius International GmbH", aliases: ["Fronius"], country: "AT", website: "fronius.com" },
  { name: "AVL List GmbH", aliases: ["AVL"], country: "AT", website: "avl.com" },
  { name: "Miba AG", aliases: ["Miba"], country: "AT", website: "miba.com" },
  { name: "BWT AG", aliases: ["BWT", "Best Water Technology"], country: "AT", website: "bwt.com" },
  { name: "Novomatic AG", aliases: ["Novomatic"], country: "AT", website: "novomatic.com" },
  { name: "Wolford AG", aliases: ["Wolford"], country: "AT", website: "wolford.com" },

  // Additional Retail/Consumer commonly seen on Austrian invoices
  { name: "Julius Meinl", aliases: ["Meinl", "Julius Meinl am Graben"], country: "AT", website: "meinl.com" },
  { name: "Hornbach Baumarkt Austria GmbH", aliases: ["Hornbach"], country: "AT", website: "hornbach.at" },
  { name: "Deichmann Schuhvertriebsges.m.b.H.", aliases: ["Deichmann"], country: "AT", website: "deichmann.at" },
  { name: "Müller Handels GmbH & Co. KG", aliases: ["Müller Drogerie", "Müller"], country: "AT", website: "mueller.at" },
  { name: "Libro Handelsgesellschaft mbH", aliases: ["Libro", "Pagro"], country: "AT", website: "libro.at" },

  // Austrian Tech
  { name: "Bitpanda GmbH", aliases: ["Bitpanda"], country: "AT", website: "bitpanda.com" },
  { name: "TTTech Auto AG", aliases: ["TTTech"], country: "AT", website: "tttech-auto.com" },
  { name: "Dynatrace Austria GmbH", aliases: ["Dynatrace"], country: "AT", website: "dynatrace.com" },

  // Government, Quasi-Government & Public Services
  { name: "GIS Gebühren Info Service GmbH", aliases: ["GIS", "ORF-Beitrag", "Rundfunkgebühren"], country: "AT", website: "gis.at" },
  { name: "ÖAMTC", aliases: ["Österreichischer Automobil-, Motorrad- und Touring Club"], country: "AT", website: "oeamtc.at" },
  { name: "ARBÖ", aliases: ["Auto-, Motor- und Radfahrerbund Österreichs"], country: "AT", website: "arboe.at" },

  // Austrian Telecom MVNOs & Budget Carriers
  { name: "bob", aliases: ["bob A1"], country: "AT", website: "bob.at" },
  { name: "spusu", aliases: ["Mass Response Service GmbH"], country: "AT", website: "spusu.at" },
  { name: "HoT", aliases: ["Hofer Telekom", "Ventocom GmbH"], country: "AT", website: "hot.at" },

  // Food Delivery & Transport
  { name: "Wolt Österreich", aliases: ["Wolt"], country: "AT", website: "wolt.com" },
  { name: "Lieferando", aliases: ["Takeaway.com", "Just Eat Takeaway"], country: "AT", website: "lieferando.at" },
  { name: "Flixbus", aliases: ["FlixMobility GmbH", "Flixtrain"], country: "DE", website: "flixbus.at" },

  // Additional Austrian Retail
  { name: "C&A Mode GmbH & Co. KG", aliases: ["C&A"], country: "AT", website: "c-and-a.com" },
  { name: "Thalia Buch & Medien GmbH", aliases: ["Thalia"], country: "AT", website: "thalia.at" },
  { name: "Hervis Sport- und Modegesellschaft m.b.H.", aliases: ["Hervis"], country: "AT", website: "hervis.at" },
  { name: "Action Österreich GmbH", aliases: ["Action"], country: "AT", website: "action.com" },

  // Austrian Insurance (additional)
  { name: "Wüstenrot Versicherungs-AG", aliases: ["Wüstenrot"], country: "AT", website: "wuestenrot.at" },
  { name: "Donau Versicherung AG", aliases: ["Donau Versicherung"], country: "AT", website: "donauversicherung.at" },

  // Fitness & Wellness
  { name: "FitInn GmbH", aliases: ["FitInn", "Fit Inn"], country: "AT", website: "fitinn.at" },
  { name: "John Harris Fitness GmbH", aliases: ["John Harris"], country: "AT", website: "johnharris.at" },

  // Car Rental
  { name: "Europcar Austria GmbH", aliases: ["Europcar"], country: "AT", website: "europcar.at" },

  // Austrian Utilities & Housing
  { name: "Wiener Netze GmbH", aliases: ["Wiener Netze"], country: "AT", website: "wienernetze.at" },
  { name: "Netz Niederösterreich GmbH", aliases: ["Netz NÖ"], country: "AT", website: "netz-noe.at" },
  { name: "Wiener Wohnen", aliases: ["Stadt Wien - Wiener Wohnen"], country: "AT", website: "wienerwohnen.at" },
  { name: "Linz AG", aliases: ["Linz Strom", "Linz Gas"], country: "AT", website: "linzag.at" },
  { name: "Innsbrucker Kommunalbetriebe AG", aliases: ["IKB"], country: "AT", website: "ikb.at" },
  { name: "Energie Graz GmbH & Co KG", aliases: ["Energie Graz"], country: "AT", website: "energie-graz.at" },
  { name: "Stadtwerke Klagenfurt AG", aliases: ["STW Klagenfurt"], country: "AT", website: "stw.at" },

  // ============ German DAX Companies (40) ============
  { name: "Volkswagen AG", aliases: ["VW", "Volkswagen", "Audi", "Porsche", "SEAT", "Skoda"], country: "DE", website: "volkswagen.com", vatId: "DE115235681" },
  { name: "BMW AG", aliases: ["BMW", "MINI", "Rolls-Royce Motor Cars"], country: "DE", website: "bmw.com", vatId: "DE129273398" },
  { name: "Mercedes-Benz Group AG", aliases: ["Mercedes", "Mercedes-Benz", "Daimler"], country: "DE", website: "mercedes-benz.com" },
  { name: "Siemens AG", aliases: ["Siemens"], country: "DE", website: "siemens.com", vatId: "DE129274202" },
  { name: "BASF SE", aliases: ["BASF"], country: "DE", website: "basf.com" },
  { name: "Bayer AG", aliases: ["Bayer"], country: "DE", website: "bayer.com" },
  { name: "Deutsche Telekom AG", aliases: ["Telekom", "T-Mobile", "Deutsche Telekom"], country: "DE", website: "telekom.de", vatId: "DE123475223" },
  { name: "Allianz SE", aliases: ["Allianz"], country: "DE", website: "allianz.com" },
  { name: "Munich Re", aliases: ["Münchener Rück", "Munich Reinsurance"], country: "DE", website: "munichre.com" },
  { name: "Deutsche Bank AG", aliases: ["Deutsche Bank"], country: "DE", website: "db.com", vatId: "DE114103379" },
  { name: "Commerzbank AG", aliases: ["Commerzbank"], country: "DE", website: "commerzbank.de" },
  { name: "DHL Group", aliases: ["DHL", "Deutsche Post DHL"], country: "DE", website: "dpdhl.com", vatId: "DE169838187" },
  { name: "Adidas AG", aliases: ["adidas", "Adidas"], country: "DE", website: "adidas.com" },
  { name: "Henkel AG & Co. KGaA", aliases: ["Henkel", "Persil", "Schwarzkopf"], country: "DE", website: "henkel.com" },
  { name: "Continental AG", aliases: ["Continental", "Conti"], country: "DE", website: "continental.com" },
  { name: "Deutsche Börse AG", aliases: ["Deutsche Börse"], country: "DE", website: "deutsche-boerse.com" },
  { name: "E.ON SE", aliases: ["E.ON", "EON"], country: "DE", website: "eon.com" },
  { name: "RWE AG", aliases: ["RWE"], country: "DE", website: "rwe.com" },
  { name: "Infineon Technologies AG", aliases: ["Infineon"], country: "DE", website: "infineon.com" },
  { name: "Deutsche Lufthansa AG", aliases: ["Lufthansa", "Swiss", "Austrian Airlines"], country: "DE", website: "lufthansa.com" },
  { name: "Fresenius SE & Co. KGaA", aliases: ["Fresenius", "Fresenius Kabi"], country: "DE", website: "fresenius.com" },
  { name: "Merck KGaA", aliases: ["Merck"], country: "DE", website: "merck.com" },
  { name: "HeidelbergCement AG", aliases: ["Heidelberg Materials"], country: "DE", website: "heidelbergmaterials.com" },
  { name: "Vonovia SE", aliases: ["Vonovia"], country: "DE", website: "vonovia.de" },
  { name: "Covestro AG", aliases: ["Covestro"], country: "DE", website: "covestro.com" },
  { name: "Brenntag SE", aliases: ["Brenntag"], country: "DE", website: "brenntag.com" },
  { name: "Symrise AG", aliases: ["Symrise"], country: "DE", website: "symrise.com" },
  { name: "Beiersdorf AG", aliases: ["Beiersdorf", "Nivea", "Eucerin"], country: "DE", website: "beiersdorf.com" },
  { name: "Puma SE", aliases: ["Puma", "PUMA"], country: "DE", website: "puma.com" },
  { name: "Zalando SE", aliases: ["Zalando"], country: "DE", website: "zalando.de", vatId: "DE260543043" },
  { name: "Delivery Hero SE", aliases: ["Delivery Hero", "Foodora", "Mjam"], country: "DE", website: "deliveryhero.com" },
  { name: "HelloFresh SE", aliases: ["HelloFresh"], country: "DE", website: "hellofresh.com" },
  { name: "Sixt SE", aliases: ["Sixt"], country: "DE", website: "sixt.de" },
  { name: "Scout24 SE", aliases: ["Scout24", "ImmobilienScout24", "AutoScout24"], country: "DE", website: "scout24.com" },
  { name: "Sartorius AG", aliases: ["Sartorius"], country: "DE", website: "sartorius.com" },
  { name: "MTU Aero Engines AG", aliases: ["MTU"], country: "DE", website: "mtu.de" },
  { name: "HUGO BOSS AG", aliases: ["Hugo Boss", "BOSS"], country: "DE", website: "hugoboss.com" },
  { name: "Drägerwerk AG & Co. KGaA", aliases: ["Dräger"], country: "DE", website: "draeger.com" },
  { name: "LANXESS AG", aliases: ["LANXESS", "Lanxess"], country: "DE", website: "lanxess.com" },
  { name: "Knorr-Bremse AG", aliases: ["Knorr-Bremse"], country: "DE", website: "knorr-bremse.com" },

  // ============ European Multinationals (40) ============
  // Switzerland
  { name: "Nestlé S.A.", aliases: ["Nestlé", "Nestle", "Nespresso"], country: "CH", website: "nestle.com" },
  { name: "Novartis AG", aliases: ["Novartis"], country: "CH", website: "novartis.com" },
  { name: "Roche Holding AG", aliases: ["Roche"], country: "CH", website: "roche.com" },
  { name: "UBS Group AG", aliases: ["UBS"], country: "CH", website: "ubs.com" },
  { name: "Credit Suisse Group AG", aliases: ["Credit Suisse"], country: "CH", website: "credit-suisse.com" },
  { name: "ABB Ltd", aliases: ["ABB"], country: "CH", website: "abb.com" },
  { name: "Zurich Insurance Group AG", aliases: ["Zurich"], country: "CH", website: "zurich.com" },
  { name: "Swiss Re AG", aliases: ["Swiss Re"], country: "CH", website: "swissre.com" },
  { name: "Swatch Group AG", aliases: ["Swatch", "Omega", "Longines"], country: "CH", website: "swatchgroup.com" },
  { name: "Lindt & Sprüngli AG", aliases: ["Lindt", "Lindt & Sprüngli"], country: "CH", website: "lindt.com" },

  // Netherlands
  { name: "Shell plc", aliases: ["Shell", "Royal Dutch Shell"], country: "NL", website: "shell.com" },
  { name: "ASML Holding N.V.", aliases: ["ASML"], country: "NL", website: "asml.com" },
  { name: "Philips N.V.", aliases: ["Philips", "Royal Philips"], country: "NL", website: "philips.com" },
  { name: "Unilever N.V.", aliases: ["Unilever"], country: "NL", website: "unilever.com" },
  { name: "ING Group N.V.", aliases: ["ING", "ING Bank"], country: "NL", website: "ing.com" },
  { name: "Heineken N.V.", aliases: ["Heineken"], country: "NL", website: "heineken.com" },
  { name: "Booking Holdings Inc.", aliases: ["Booking.com", "Booking.com B.V."], country: "NL", website: "booking.com", vatId: "NL805734958B01" },

  // France
  { name: "LVMH Moët Hennessy Louis Vuitton SE", aliases: ["LVMH", "Louis Vuitton", "Dior", "Moët"], country: "FR", website: "lvmh.com" },
  { name: "L'Oréal S.A.", aliases: ["L'Oréal", "L'Oreal"], country: "FR", website: "loreal.com" },
  { name: "TotalEnergies SE", aliases: ["TotalEnergies", "Total"], country: "FR", website: "totalenergies.com", vatId: "FR59542051180" },
  { name: "Sanofi S.A.", aliases: ["Sanofi"], country: "FR", website: "sanofi.com" },
  { name: "BNP Paribas S.A.", aliases: ["BNP Paribas", "BNP"], country: "FR", website: "bnpparibas.com", vatId: "FR76662042449" },
  { name: "AXA S.A.", aliases: ["AXA"], country: "FR", website: "axa.com" },
  { name: "Carrefour S.A.", aliases: ["Carrefour"], country: "FR", website: "carrefour.com" },
  { name: "Airbus SE", aliases: ["Airbus"], country: "FR", website: "airbus.com" },
  { name: "Danone S.A.", aliases: ["Danone", "Evian", "Alpro"], country: "FR", website: "danone.com" },
  { name: "Michelin", aliases: ["Michelin", "Bibendum"], country: "FR", website: "michelin.com" },

  // UK (post-Brexit GB VAT IDs — not VIES-verifiable but useful for matching)
  { name: "BP p.l.c.", aliases: ["BP", "British Petroleum", "BP International"], country: "GB", website: "bp.com" },
  { name: "HSBC Holdings plc", aliases: ["HSBC"], country: "GB", website: "hsbc.com" },
  { name: "Barclays PLC", aliases: ["Barclays"], country: "GB", website: "barclays.com" },
  { name: "Tesco PLC", aliases: ["Tesco"], country: "GB", website: "tesco.com" },
  { name: "AstraZeneca PLC", aliases: ["AstraZeneca"], country: "GB", website: "astrazeneca.com" },
  { name: "GlaxoSmithKline plc", aliases: ["GSK", "GlaxoSmithKline", "GSK plc"], country: "GB", website: "gsk.com" },
  { name: "Vodafone Group Plc", aliases: ["Vodafone"], country: "GB", website: "vodafone.com" },
  { name: "British American Tobacco p.l.c.", aliases: ["BAT"], country: "GB", website: "bat.com" },

  // Nordic
  { name: "Spotify Technology S.A.", aliases: ["Spotify"], country: "SE", website: "spotify.com", vatId: "SE556703748501", patterns: [
    { pattern: "*spotify*", field: "name", confidence: 95 },
  ]},
  { name: "IKEA of Sweden AB", aliases: ["IKEA"], country: "SE", website: "ikea.com", patterns: [
    { pattern: "*ikea*", field: "name", confidence: 92 },
  ]},
  { name: "Volvo Group", aliases: ["Volvo", "Volvo AB"], country: "SE", website: "volvo.com", vatId: "SE556012579001" },
  { name: "Ericsson", aliases: ["Ericsson", "LM Ericsson", "Telefonaktiebolaget LM Ericsson"], country: "SE", website: "ericsson.com", vatId: "SE556016068001" },
  { name: "H&M Hennes & Mauritz AB", aliases: ["H&M", "Hennes & Mauritz"], country: "SE", website: "hm.com" },
  { name: "Novo Nordisk A/S", aliases: ["Novo Nordisk"], country: "DK", website: "novonordisk.com" },
  { name: "Maersk", aliases: ["A.P. Moller - Maersk", "A.P. Møller - Mærsk"], country: "DK", website: "maersk.com", vatId: "DK22756214" },
  { name: "LEGO A/S", aliases: ["LEGO"], country: "DK", website: "lego.com", vatId: "DK47458714" },
  { name: "Nokia Corporation", aliases: ["Nokia", "Nokia Oyj"], country: "FI", website: "nokia.com" },

  // ============ US Companies (40) ============
  // Retail
  { name: "Walmart Inc.", aliases: ["Walmart"], country: "US", website: "walmart.com" },
  { name: "Costco Wholesale Corporation", aliases: ["Costco"], country: "US", website: "costco.com" },
  { name: "Target Corporation", aliases: ["Target"], country: "US", website: "target.com" },
  { name: "The Home Depot, Inc.", aliases: ["Home Depot"], country: "US", website: "homedepot.com" },
  { name: "Lowe's Companies, Inc.", aliases: ["Lowe's"], country: "US", website: "lowes.com" },
  { name: "Best Buy Co., Inc.", aliases: ["Best Buy"], country: "US", website: "bestbuy.com" },
  { name: "eBay Inc.", aliases: ["eBay", "eBay GmbH"], country: "US", website: "ebay.com" },
  { name: "Etsy, Inc.", aliases: ["Etsy"], country: "US", website: "etsy.com" },

  // Finance & Payments
  { name: "JPMorgan Chase & Co.", aliases: ["JPMorgan", "Chase"], country: "US", website: "jpmorganchase.com" },
  { name: "Bank of America Corporation", aliases: ["Bank of America", "BofA"], country: "US", website: "bankofamerica.com" },
  { name: "Citigroup Inc.", aliases: ["Citibank", "Citi"], country: "US", website: "citi.com" },
  { name: "Goldman Sachs Group, Inc.", aliases: ["Goldman Sachs"], country: "US", website: "goldmansachs.com" },
  { name: "Morgan Stanley", aliases: ["Morgan Stanley"], country: "US", website: "morganstanley.com" },
  { name: "Visa Inc.", aliases: ["Visa"], country: "US", website: "visa.com" },
  { name: "Mastercard Incorporated", aliases: ["Mastercard"], country: "US", website: "mastercard.com" },
  { name: "American Express Company", aliases: ["Amex", "American Express"], country: "US", website: "americanexpress.com", patterns: [
    { pattern: "*amex*", field: "name", confidence: 90 },
    { pattern: "*american express*", field: "name", confidence: 92 },
  ]},
  { name: "PayPal Holdings, Inc.", aliases: ["PayPal", "Venmo", "PayPal (Europe) S.à r.l."], country: "US", website: "paypal.com", vatId: "LU22046007", patterns: [
    { pattern: "*paypal*", field: "name", confidence: 95 },
    { pattern: "*venmo*", field: "name", confidence: 92 },
  ]},
  { name: "Block, Inc.", aliases: ["Block", "Square", "Cash App"], country: "US", website: "block.xyz", patterns: [
    { pattern: "*square*", field: "name", confidence: 90 },
    { pattern: "*cash app*", field: "name", confidence: 92 },
  ]},
  { name: "Stripe, Inc.", aliases: ["Stripe", "Stripe Payments Europe Limited"], country: "US", website: "stripe.com", vatId: "IE3206488LH", patterns: [
    { pattern: "*stripe*", field: "name", confidence: 92 },
  ]},

  // Tech Services
  { name: "Uber Technologies, Inc.", aliases: ["Uber", "Uber Eats", "Uber B.V."], country: "US", website: "uber.com", patterns: [
    { pattern: "*uber*", field: "name", confidence: 92 },
  ]},
  { name: "Lyft, Inc.", aliases: ["Lyft"], country: "US", website: "lyft.com", patterns: [
    { pattern: "*lyft*", field: "name", confidence: 92 },
  ]},
  { name: "Airbnb, Inc.", aliases: ["Airbnb", "Airbnb Ireland UC"], country: "US", website: "airbnb.com", vatId: "IE9827384L", patterns: [
    { pattern: "*airbnb*", field: "name", confidence: 95 },
  ]},
  { name: "DoorDash, Inc.", aliases: ["DoorDash"], country: "US", website: "doordash.com", patterns: [
    { pattern: "*doordash*", field: "name", confidence: 92 },
  ]},
  { name: "Dropbox, Inc.", aliases: ["Dropbox", "Dropbox International Unlimited Company"], country: "US", website: "dropbox.com", vatId: "IE9852817J", patterns: [
    { pattern: "*dropbox*", field: "name", confidence: 95 },
  ]},
  { name: "Zoom Video Communications, Inc.", aliases: ["Zoom"], country: "US", website: "zoom.us", patterns: [
    { pattern: "*zoom*", field: "name", confidence: 90 },
  ]},
  { name: "Slack Technologies, LLC", aliases: ["Slack"], country: "US", website: "slack.com", patterns: [
    { pattern: "*slack*", field: "name", confidence: 90 },
  ]},
  { name: "Atlassian Corporation", aliases: ["Atlassian", "Jira", "Confluence", "Trello"], country: "US", website: "atlassian.com", patterns: [
    { pattern: "*atlassian*", field: "name", confidence: 92 },
    { pattern: "*jira*", field: "name", confidence: 90 },
    { pattern: "*confluence*", field: "name", confidence: 90 },
    { pattern: "*trello*", field: "name", confidence: 92 },
  ]},
  { name: "Intuit Inc.", aliases: ["Intuit", "QuickBooks", "TurboTax"], country: "US", website: "intuit.com" },
  { name: "Autodesk, Inc.", aliases: ["Autodesk"], country: "US", website: "autodesk.com", patterns: [
    { pattern: "*autodesk*", field: "name", confidence: 92 },
  ]},
  { name: "Shopify Inc.", aliases: ["Shopify", "Shopify International Limited"], country: "CA", website: "shopify.com", patterns: [
    { pattern: "*shopify*", field: "name", confidence: 92 },
  ]},

  // Food & Beverage
  { name: "McDonald's Corporation", aliases: ["McDonald's", "McDonalds"], country: "US", website: "mcdonalds.com" },
  { name: "Starbucks Corporation", aliases: ["Starbucks"], country: "US", website: "starbucks.com" },
  { name: "The Coca-Cola Company", aliases: ["Coca-Cola", "Coke"], country: "US", website: "coca-cola.com" },
  { name: "PepsiCo, Inc.", aliases: ["Pepsi", "PepsiCo"], country: "US", website: "pepsico.com" },
  { name: "Yum! Brands, Inc.", aliases: ["KFC", "Pizza Hut", "Taco Bell"], country: "US", website: "yum.com" },
  { name: "Subway IP LLC", aliases: ["Subway"], country: "US", website: "subway.com" },
  { name: "Chipotle Mexican Grill, Inc.", aliases: ["Chipotle"], country: "US", website: "chipotle.com" },

  // Entertainment & Media
  { name: "The Walt Disney Company", aliases: ["Disney", "Disney+", "Pixar", "Marvel", "Lucasfilm"], country: "US", website: "disney.com" },
  { name: "Comcast Corporation", aliases: ["Comcast", "NBC Universal", "Sky"], country: "US", website: "comcast.com" },
  { name: "Warner Bros. Discovery, Inc.", aliases: ["Warner Bros.", "HBO", "CNN"], country: "US", website: "wbd.com" },

  // ============ Fintech & Payments (20) ============
  { name: "Klarna Bank AB", aliases: ["Klarna"], country: "SE", website: "klarna.com", patterns: [
    { pattern: "*klarna*", field: "name", confidence: 95 },
  ]},
  { name: "Adyen N.V.", aliases: ["Adyen"], country: "NL", website: "adyen.com", patterns: [
    { pattern: "*adyen*", field: "name", confidence: 92 },
  ]},
  { name: "Revolut Ltd", aliases: ["Revolut"], country: "GB", website: "revolut.com", patterns: [
    { pattern: "*revolut*", field: "name", confidence: 95 },
  ]},
  { name: "N26 Bank GmbH", aliases: ["N26"], country: "DE", website: "n26.com", patterns: [
    { pattern: "*n26*", field: "name", confidence: 92 },
  ]},
  { name: "Wise Payments Limited", aliases: ["Wise", "TransferWise"], country: "GB", website: "wise.com", patterns: [
    { pattern: "*wise*", field: "name", confidence: 85 },
    { pattern: "*transferwise*", field: "name", confidence: 95 },
  ]},
  { name: "Sumup Limited", aliases: ["SumUp", "SumUp Payments"], country: "GB", website: "sumup.com", vatId: "IE9813461A", patterns: [
    { pattern: "*sumup*", field: "name", confidence: 92 },
  ]},
  { name: "iZettle AB", aliases: ["iZettle", "Zettle"], country: "SE", website: "zettle.com", patterns: [
    { pattern: "*zettle*", field: "name", confidence: 92 },
    { pattern: "*izettle*", field: "name", confidence: 92 },
  ]},
  { name: "Mollie B.V.", aliases: ["Mollie"], country: "NL", website: "mollie.com", vatId: "NL815839091B01", patterns: [
    { pattern: "*mollie*", field: "name", confidence: 90 },
  ]},
  { name: "Worldline S.A.", aliases: ["Worldline"], country: "FR", website: "worldline.com", vatId: "FR01378901946" },
  { name: "Nexi S.p.A.", aliases: ["Nexi"], country: "IT", website: "nexi.it", vatId: "IT10542790968" },

  // ============ Cloud, SaaS & Dev Tools ============
  { name: "Amazon Web Services, Inc.", aliases: ["AWS", "Amazon Web Services"], country: "US", website: "aws.amazon.com" },
  { name: "Google Cloud", aliases: ["Google Cloud Platform", "GCP"], country: "US", website: "cloud.google.com" },
  { name: "Cloudflare, Inc.", aliases: ["Cloudflare"], country: "US", website: "cloudflare.com" },
  { name: "DigitalOcean, LLC", aliases: ["DigitalOcean"], country: "US", website: "digitalocean.com" },
  { name: "MongoDB, Inc.", aliases: ["MongoDB"], country: "US", website: "mongodb.com" },
  { name: "Snowflake Inc.", aliases: ["Snowflake"], country: "US", website: "snowflake.com" },
  { name: "Twilio Inc.", aliases: ["Twilio"], country: "US", website: "twilio.com" },
  { name: "HubSpot, Inc.", aliases: ["HubSpot"], country: "US", website: "hubspot.com" },
  { name: "Notion Labs, Inc.", aliases: ["Notion"], country: "US", website: "notion.so" },
  { name: "Figma, Inc.", aliases: ["Figma"], country: "US", website: "figma.com" },
  { name: "Canva Pty Ltd", aliases: ["Canva"], country: "AU", website: "canva.com" },
  { name: "Vercel Inc.", aliases: ["Vercel"], country: "US", website: "vercel.com" },
  { name: "Netlify, Inc.", aliases: ["Netlify"], country: "US", website: "netlify.com" },
  { name: "Supabase, Inc.", aliases: ["Supabase"], country: "US", website: "supabase.com" },
  { name: "Airtable Inc.", aliases: ["Airtable"], country: "US", website: "airtable.com" },
  { name: "GitHub, Inc.", aliases: ["GitHub"], country: "US", website: "github.com", patterns: [
    { pattern: "*github*", field: "name", confidence: 92 },
  ]},

  // AI & Dev Tools
  { name: "OpenAI, LLC", aliases: ["OpenAI", "ChatGPT", "GPT-4", "OpenAI Ireland Ltd"], country: "US", website: "openai.com" },
  { name: "Anthropic PBC", aliases: ["Anthropic", "Claude"], country: "US", website: "anthropic.com" },
  { name: "JetBrains s.r.o.", aliases: ["JetBrains", "IntelliJ", "WebStorm", "PyCharm", "PhpStorm"], country: "CZ", website: "jetbrains.com" },
  { name: "Hetzner Online GmbH", aliases: ["Hetzner"], country: "DE", website: "hetzner.com", vatId: "DE812871812" },
  { name: "OVH SAS", aliases: ["OVH", "OVHcloud"], country: "FR", website: "ovhcloud.com", vatId: "FR22424761419" },
  { name: "Cursor / Anysphere Inc.", aliases: ["Cursor", "Anysphere"], country: "US", website: "cursor.com" },
  { name: "Linear Inc.", aliases: ["Linear"], country: "US", website: "linear.app" },
  { name: "Render Services, Inc.", aliases: ["Render"], country: "US", website: "render.com" },
  { name: "Railway Corporation", aliases: ["Railway"], country: "US", website: "railway.app" },
  { name: "Fly.io, Inc.", aliases: ["Fly.io", "Fly"], country: "US", website: "fly.io" },
  { name: "Sentry Software, Inc.", aliases: ["Sentry"], country: "US", website: "sentry.io" },
  { name: "PostHog, Inc.", aliases: ["PostHog"], country: "US", website: "posthog.com" },
  { name: "Resend, Inc.", aliases: ["Resend"], country: "US", website: "resend.com" },
  { name: "Neon, Inc.", aliases: ["Neon", "Neon Database"], country: "US", website: "neon.tech" },
  { name: "PlanetScale, Inc.", aliases: ["PlanetScale"], country: "US", website: "planetscale.com" },

  // ============ Hardware & Electronics (10) ============
  { name: "Dell Technologies Inc.", aliases: ["Dell"], country: "US", website: "dell.com" },
  { name: "HP Inc.", aliases: ["HP", "Hewlett-Packard"], country: "US", website: "hp.com" },
  { name: "Lenovo Group Limited", aliases: ["Lenovo"], country: "HK", website: "lenovo.com" },
  { name: "Samsung Electronics Co., Ltd.", aliases: ["Samsung"], country: "KR", website: "samsung.com" },
  { name: "Sony Group Corporation", aliases: ["Sony", "PlayStation"], country: "JP", website: "sony.com" },
  { name: "LG Electronics Inc.", aliases: ["LG"], country: "KR", website: "lg.com" },
  { name: "Panasonic Holdings Corporation", aliases: ["Panasonic"], country: "JP", website: "panasonic.com" },
  { name: "Canon Inc.", aliases: ["Canon"], country: "JP", website: "canon.com" },
  { name: "Logitech International S.A.", aliases: ["Logitech"], country: "CH", website: "logitech.com" },
  { name: "Bose Corporation", aliases: ["Bose"], country: "US", website: "bose.com" },

  // ============ Utilities & Services (10) ============
  { name: "Apple Services", aliases: ["iCloud", "Apple Music", "App Store"], country: "US", website: "apple.com" },
  { name: "Google Services", aliases: ["Google One", "Google Workspace"], country: "US", website: "google.com" },
  { name: "LinkedIn Corporation", aliases: ["LinkedIn", "LinkedIn Premium"], country: "US", website: "linkedin.com", patterns: [
    { pattern: "*linkedin*", field: "name", confidence: 92 },
  ]},
  { name: "Xero Limited", aliases: ["Xero"], country: "NZ", website: "xero.com" },
  { name: "FreshBooks", aliases: ["FreshBooks"], country: "CA", website: "freshbooks.com" },
  { name: "Mailchimp", aliases: ["Mailchimp", "Intuit Mailchimp"], country: "US", website: "mailchimp.com" },
  { name: "SendGrid, Inc.", aliases: ["SendGrid", "Twilio SendGrid"], country: "US", website: "sendgrid.com" },
  { name: "1Password", aliases: ["1Password", "AgileBits"], country: "CA", website: "1password.com" },
  { name: "LastPass", aliases: ["LastPass"], country: "US", website: "lastpass.com" },

  // ============ Additional Companies (5) ============
  { name: "DocuSign, Inc.", aliases: ["DocuSign"], country: "US", website: "docusign.com" },
  { name: "Workday, Inc.", aliases: ["Workday"], country: "US", website: "workday.com" },
  { name: "ServiceNow, Inc.", aliases: ["ServiceNow"], country: "US", website: "servicenow.com" },
  { name: "Datadog, Inc.", aliases: ["Datadog"], country: "US", website: "datadoghq.com" },
  { name: "CrowdStrike Holdings, Inc.", aliases: ["CrowdStrike"], country: "US", website: "crowdstrike.com" },
];

/**
 * Special identifier for preset partner source
 */
export const PRESET_SOURCE = "preset" as const;

/**
 * Count of preset partners
 */
export const PRESET_PARTNERS_COUNT = PRESET_PARTNERS.length;

/**
 * Generate a deterministic document ID for a preset partner.
 * Used for idempotent seeding: same partner always gets the same ID.
 *
 * Example: "Apple Inc." → "preset_apple_inc"
 */
export function generatePresetId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 60);
  return `preset_${slug}`;
}
