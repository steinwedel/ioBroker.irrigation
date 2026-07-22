"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var dwd_poi_stations_exports = {};
__export(dwd_poi_stations_exports, {
  DWD_POI_STATIONS: () => DWD_POI_STATIONS
});
module.exports = __toCommonJS(dwd_poi_stations_exports);
const DWD_POI_STATIONS = `
10505|Aachen-Orsbach
10309|Ahaus
10442|Alfeld
10954|Altenstadt
10520|Andernach
10291|Angerm\xFCnde
10091|Arkona
10460|Artern
10852|Augsburg
10526|Bad Marienberg
10542|Bad Hersfeld
10430|Bad Lippspringe
10325|Bad Salzuflen
10675|Bamberg
10180|Barth
10376|Baruth
10312|Belm
10238|Bergen-Hohne
10385|Berlin-Brandenburg
10381|Berlin-Dahlem
10382|Berlin-Tegel
10384|Berlin-Tempelhof
10704|Berus
10249|Boizenburg
10161|Boltenhagen
10519|Bonn-Roleber
10452|Braunlage
10348|Braunschweig
10224|Bremen
10129|Bremerhaven
10139|Bremerv\xF6rde
10453|Brocken
10613|B\xFCchel
10335|B\xFCckeburg
10574|Carlsfeld
10343|Celle
10577|Chemnitz
10982|Chieming
10496|Cottbus
10131|Cuxhaven
10615|Deuselbach
10321|Diepholz
10490|Doberlug-Kirchhain
10150|D\xF6rnick
10488|Dresden-Flughafen
10400|D\xFCsseldorf
10540|Eisenach
10130|Elpersb\xFCttel
10200|Emden-Flugplatz
10554|Erfurt
10410|Essen
10522|Euskirchen
10246|Fa\xDFberg
10282|Feldberg/Mecklenburg
10908|Feldberg/Schwarzwald
10756|Feuchtwangen
10578|Fichtelberg
10033|Flensburg
10637|Frankfurt am Main
10803|Freiburg
10815|Freudenstadt
10210|Friesoythe-Altenoythe
10439|Fritzlar
10895|F\xFCrstenzell
10359|Gardelegen
10963|Garmisch
10500|Geilenkirchen
10628|Geisenheim
10777|Gelbelsee
10365|Genthin
10567|Gera
10532|Gie\xDFen
10499|G\xF6rlitz
10444|G\xF6ttingen
10168|Goldberg
10872|Gottfrieding
10791|Gro\xDFer Arber
10184|Greifswald
10097|Greifswalder Oie
10289|Gr\xFCnow
10616|Hahn
10147|Hamburg-Fuhlsb\xFCttel
10338|Hannover
10850|Harburg
10458|Harzgerode
10015|Helgoland
10685|Hof
10962|Hohenpei\xDFenberg
10534|Hoherodskopf
10038|Hohn
10476|Holzdorf
10495|Hoyerswerda
10618|Idar-Oberstein
10860|Ingolstadt
10142|Itzehoe
10427|Kahler Asten
10747|Kaisersbach-Cronh\xFCtte
10946|Kempten
10046|Kiel-Holtenau
10658|Bad Kissingen
10635|Kleiner Feldberg
10818|Klippeneck
10513|K\xF6ln/Bonn
10929|Konstanz
10771|K\xFCmmersbruck
10267|Kyritz
10172|Laage
10805|Lahr
10837|Laupheim
10671|Lautertal-Oberlauter
10856|Lechfeld
10022|Leck
10449|Leinefelde
10471|Leipzig
10469|Leipzig/Schkeuditz
10124|Leuchtturm Alte Weser
10044|Leuchtturm Kiel
10945|Leutkirch-Herlazhofen
10591|Lichtenhain
10393|Lindenberg
10303|Lingen-Baccum
10020|List/Sylt
10156|L\xFCbeck
10253|L\xFCchow
10418|L\xFCdenscheid
10433|L\xFCgde
10361|Magdeburg
10729|Mannheim
10396|Manschnow
10579|Marienberg
10264|Marnitz
10548|Meiningen
10827|Me\xDFstetten
10648|Michelstadt-Vielbrunn
10736|M\xFChlacker
10875|M\xFChldorf
10865|M\xFCnchen Stadt
10870|M\xFCnchen-Flughafen
10315|M\xFCnster/Osnabr\xFCck
10537|Neu-Ulrichstein
10853|Neuburg/Donau
10557|Neuhaus am Rennweg
10646|Neuh\xFCtten/Spessart
10271|Neuruppin-Alt Ruppin
10743|Niederstetten
10502|N\xF6rvenich
10113|Norderney
10136|Nordholz
10506|N\xFCrburg-Barweiler
10763|N\xFCrnberg
10948|Oberstdorf
10742|\xD6hringen
10641|Offenbach-Wetterpark
10042|Olpenitz
10480|Oschatz
10565|Osterfeld
10152|Pelzerhaken
10569|Plauen
10379|Potsdam
10093|Putbus
10146|Quickborn
10776|Regensburg
10731|Rheinstetten
10765|Roth
10708|Saarbr\xFCcken
10441|Schauenburg-Elgershausen
10564|Schleiz
10035|Schleswig
10037|Schleswig-Jagel
10552|Schm\xFCcke
10162|Schwerin
10261|Seehausen
10235|Soltau
10028|St. Peter-Ording
10836|St\xF6tten
10788|Straubing
10738|Stuttgart-Echterdingen
10739|Stuttgart-Schnarrenberg
10706|Tholey
10609|Trier
10281|Trollenhagen
10193|Ueckerm\xFCnde
10007|UFS Deutsche Bucht
10004|UFS TW Ems
10840|Ulm-M\xE4hringen
10356|Ummendorf
10733|Waibstadt
10782|Waldm\xFCnchen
10435|Warburg
10268|Waren
10170|Warnem\xFCnde
10544|Wasserkuppe
10688|Weiden
10863|Weihenstephan
10724|Weinbiet
10761|Wei\xDFenburg-Emetzheim
10424|Werl
10454|Wernigerode
10055|Westermarkelsdorf
10368|Wiesenburg
10474|Wittenberg
10126|Wittmundhafen
10655|W\xFCrzburg
10686|Wunsiedel-Sch\xF6nbrunn
10334|Wunstorf
10582|Zinnwald-Georgenfeld
10961|Zugspitze
10796|Zwiesel
`.trim().split("\n").map((line) => {
  const [value, label] = line.split("|");
  return { label, value };
}).sort((a, b) => a.label.localeCompare(b.label, "de"));
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DWD_POI_STATIONS
});
//# sourceMappingURL=dwd-poi-stations.js.map
