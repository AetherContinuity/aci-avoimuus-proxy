// aci-avoimuus-proxy
//
// Avoimuusrekisteri (VTV) — vaikuttamistoiminnan ilmoitukset.
// Kanta: https://public.api.avoimuusrekisteri.fi
// Lisenssi: CC BY 4.0, Valtiontalouden tarkastusvirasto.
//
// ── TÄMÄ PROXY ON RAKENNETTU ERI PERIAATTEELLA KUIN MUUT ────────────
//
// Muut ACI-proxyt hakevat vapaasti ja välimuistittavat tuloksen.
// Tämä EI. Syy on käyttöehdoissa, ja ne ovat poikkeuksellisen suorat:
//
//   "Rajapinta on tarkoitettu KEVYISIIN KÄYTTÖTAPAUKSIIN, joissa
//    suorituskyky ei ole kriittistä. Rajapintaa ei suositella suurten
//    tietomäärien käsittelyyn, sillä KAPASITEETIN RIITTÄVYYTTÄ EI
//    TAATA."
//
//   "Tietoaineiston tuottaja voi RAJOITTAA YKSITTÄISEN KÄYTTÄJÄN
//    PÄÄSYÄ rajapintaan, jos käytön volyymi häiritsee palvelun
//    toimintaa."
//
//   "Erityisesti toimintailmoituksiin liittyvien rajapintojen
//    vastausnopeudessa voi ilmetä hitautta suuren datamäärän vuoksi."
//
// Cloudflaren workerissa KAIKKI kutsut tulevat samasta IP:stä. Jos
// tämä proxy käyttäytyy huonosti, VTV sulkee pääsyn — eikä vain
// tältä proxylta vaan kaikelta mikä tulee tästä osoitteesta.
//
// Siksi:
//   1. Välimuisti on OLETUS, ei optimointi. 30 vrk.
//   2. Sivutuskatto on kova (100) eikä ohitettavissa.
//   3. Peräkkäiset kutsut, 500 ms väli. Ei rinnakkaisuutta.
//   4. Toimintailmoitusten massahaku on ERIKSEEN sallittava
//      (?bulk=confirm) ja se kirjaa varoituksen vastaukseen.
//   5. Käyttötarkoitus on NELJÄNNESVUOSIKAAPPAUS, ei live-kysely.
//      Sama kuvio kuin OGAS3:n snapshots/ ja WEM:n EPP-snapshot:
//      haetaan kerran, tallennetaan, luetaan tallennetusta.
//
// Ilmoituskaudet ovat kahdesti vuodessa. Neljännesvuosikadenssi on
// siis jo tiheämpi kuin datan oma päivitystahti.

const BASE = 'https://public.api.avoimuusrekisteri.fi';
const UA = 'ACI-avoimuus-proxy/1.0 (aethercontinuity.org; neljannesvuosikaappaus)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 30 vrk. Ilmoituskaudet ovat kahdesti vuodessa, joten tuoreempi
// välimuisti ei tuo mitään mutta kuormittaa ylävirtaa.
const CACHE = 'public, max-age=2592000';

const PAGE_MAX = 100;        // kova katto, ei ohitettavissa
const SPACING_MS = 500;      // peräkkäisten kutsujen väli
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sallitut polut. Valkolista eikä passthrough — avoin passthrough
// tekisi volyymirajasta kutsujan päätöksen, ja se on juuri se mitä
// käyttöehdot kieltävät.
// TODENNETUT POLUT (OpenAPI, haettu ?spec=1 -reitillä 2026-09-07).
//
// ARVAUS OLI VÄÄRÄ YHDELLÄ MERKILLÄ: polut ovat `open-data-`
// VÄLIVIIVALLA, eivät `open-data/` kauttaviivalla. Ensimmäinen ajo
// antoi 404 ja ansalista sanoi olemaan arvaamatta toista — se pidettiin,
// ja ?spec=1 luki oikeat polut määrittelystä. 89 polkua, joista 24
// open-data-alkuista.
const ROUTES = {
  registrations: 'open-data-register-notification',
  activities:    'open-data-activity-notification',
  exits:         'open-data-exit-notification',
  terms:         'open-data-term',                    // ilmoituskaudet
  terms_all:     'open-data-term/all',
  targets:       'open-data-target/targets',
  penalties:     'open-data-penalty-payments',        // uhkasakkomenettelyt
};

// VALMIIKSI AGGREGOIDUT RAPORTIT.
//
// Löytyivät määrittelystä eikä dokumentaatiosta. Nämä ovat se, mitä
// käyttöehtojen "kevyisiin käyttötapauksiin" tarkoittaa: VTV laskee
// koosteen puolestasi, jotta koko aineistoa ei tarvitse hakea.
//
// OGAS3:n kannalta `targets/topic-count` ja `top-topic-count` ovat
// suoraan käyttökelpoisia: ne kertovat mihin aiheisiin vaikuttaminen
// kohdistuu ilman että toimintailmoituksia haetaan massana.
//
// KÄYTÄ NÄITÄ ENSIN. Massahaku vasta jos kooste ei riitä.
const REPORTS = {
  topic_count:      'open-data-reporting/targets/topic-count/{termId}',
  top_topics:       'open-data-reporting/targets/top-topic-count/{termId}/{n}',
  top_topics_latest:'open-data-reporting/targets/latest-term/top-topic-count/{n}',
  activity_count:   'open-data-reporting/activity-notification/count/latest-term',
  activity_by_term: 'open-data-reporting/activity-notification/count-by-term/{termId}',
};

async function fj(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const url = `${BASE}/${path}${q ? '?' + q : ''}`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    cf: { cacheTtl: 2592000, cacheEverything: true },
  });
  const text = await r.text();
  if (!r.ok) {
    // 429 tai 403 = volyymiraja. Se EI ole tavallinen virhe: se
    // tarkoittaa että käyttö on häirinnyt palvelua. Erotellaan.
    if (r.status === 429 || r.status === 403)
      throw new Error(
        `VOLYYMIRAJA (${r.status}): VTV on rajoittanut pääsyä. ` +
        `Lopeta hakeminen ja odota. Käyttöehdot sallivat tämän ` +
        `nimenomaisesti. ${text.slice(0, 120)}`);
    throw new Error(`Avoimuusrekisteri ${path}: ${r.status} ${text.slice(0, 160)}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`Avoimuusrekisteri ${path}: vastaus ei ole JSONia`); }
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const p = u.searchParams;

    const ok = (data) => Response.json({
      source: 'Valtiontalouden tarkastusvirasto, Avoimuusrekisterin tietoaineisto',
      license: 'CC BY 4.0',
      attribution: 'VTV, Avoimuusrekisterin tietoaineisto, CC BY 4.0. ' +
                   'https://public.api.avoimuusrekisteri.fi/swagger',
      data_class: 'authoritative (lakisääteinen ilmoitusvelvollisuus)',
      usage_note: 'Rajapinta on tarkoitettu kevyisiin käyttötapauksiin. ' +
                  'Tämä proxy välimuistittaa 30 vrk ja rajaa sivukoon 100:aan. ' +
                  'Käyttötarkoitus on neljännesvuosikaappaus, ei live-kysely.',
      fetched: new Date().toISOString(),
      ...data,
    }, { headers: { ...CORS, 'Cache-Control': CACHE } });

    try {
      // ── MÄÄRITTELYN HAKU (lisätty 2026-09-07) ────────────────────
      // ?spec  hakee OpenAPI-määrittelyn, jotta reittipolut voi
      //        LUKEA eikä arvata. Ansalista sanoo: jos reitti antaa
      //        404, korjaa ROUTES Swaggerista — älä arvaa toista.
      //        Tämä on se työkalu jolla se tehdään.
      //
      // Ylävirran virhemuoto {"statusCode":404,"message":"Cannot GET
      // ...","error":"Not Found"} on NestJS. Se tarjoaa määrittelyn
      // tyypillisesti polulla <swagger-path>-json.
      if (p.get('spec')) {
        const cands = ['swagger-json', 'swagger/json', 'api-json',
                       'openapi.json', 'swagger.json', 'api/docs-json'];
        const tried = [];
        for (const c of cands) {
          const r = await fetch(`${BASE}/${c}`, {
            headers: { Accept: 'application/json', 'User-Agent': UA } });
          tried.push(`${c} -> ${r.status}`);
          if (r.ok) {
            const spec = await r.json();
            // Palautetaan VAIN polkuluettelo, ei koko määrittelyä:
            // se voi olla iso, ja tarve on tietää polut.
            const paths = Object.keys(spec.paths || {});
            // ?spec=<polku> palauttaa YHDEN polun parametrit.
            // Lisätty koska ?r=activities antoi 500 eikä syytä voinut
            // päätellä — ja parametrien arvaaminen on juuri se mitä
            // ansalista kieltää.
            const want = p.get('spec');
            if (want && want !== '1') {
              const key = paths.find(x => x === want || x === '/' + want.replace(/^\//, ''));
              if (!key) return ok({ route: 'spec', found_at: c,
                error_note: `polkua "${want}" ei ole määrittelyssä`,
                similar: paths.filter(x => x.includes(want.split('/')[0].replace(/^\//, ''))) });
              const def = spec.paths[key] || {};
              const ops = {};
              for (const [m, o] of Object.entries(def)) {
                ops[m] = {
                  summary: o.summary || null,
                  parameters: (o.parameters || []).map(x => ({
                    name: x.name, in: x.in, required: !!x.required,
                    type: (x.schema || {}).type || null,
                    default: (x.schema || {}).default,
                  })),
                  responses: Object.keys(o.responses || {}),
                };
              }
              return ok({ route: 'spec', found_at: c, path: key, operations: ops });
            }
            return ok({
              route: 'spec', found_at: c, tried,
              n_paths: paths.length,
              open_data_paths: paths.filter(x => /open-data/i.test(x)),
              all_paths: paths,
            });
          }
          await sleep(SPACING_MS);
        }
        throw new Error(`OpenAPI-määrittelyä ei löytynyt. Kokeillut: ${tried.join(', ')}`);
      }

      const route = p.get('r');
      if (route && ROUTES[route]) {
        const top = Math.min(Number(p.get('limit') || 50), PAGE_MAX);
        const skip = Number(p.get('offset') || 0);
        const params = { limit: String(top), offset: String(skip) };
        for (const k of ['search', 'from', 'to', 'periodId', 'organizationId']) {
          const v = p.get(k); if (v) params[k] = v;
        }
        const j = await fj(ROUTES[route], params);
        const rows = Array.isArray(j) ? j : (j.items || j.results || j.data || []);
        return ok({
          route, upstream_path: ROUTES[route],
          limit: top, offset: skip, n: rows.length,
          // Tyhjä EI ole virhe eikä nolla: se voi olla sivun loppu.
          // Sama erottelu kuin muualla tässä järjestelmässä.
          status: rows.length === 0
            ? 'tyhja sivu — joko tuloksia ei ole tai offset ylitti lopun'
            : (rows.length === top
                ? 'sivu tayttyi — lisaa voi olla, kasvata offsetia'
                : 'viimeinen sivu'),
          data: rows.length ? rows : (j || []),
        });
      }

      // Aggregoidut raportit — KÄYTÄ NÄITÄ ENNEN MASSAHAKUA.
      const rep = p.get('report');
      if (rep && REPORTS[rep]) {
        let path = REPORTS[rep];
        const termId = p.get('termId');
        const n = p.get('n') || '20';
        if (path.includes('{termId}')) {
          if (!termId) throw new Error(
            `?report=${rep} vaatii &termId=. Hae kaudet ensin: ?r=terms_all`);
          path = path.replace('{termId}', encodeURIComponent(termId));
        }
        path = path.replace('{n}', encodeURIComponent(n));
        const j = await fj(path);
        const rows = Array.isArray(j) ? j : (j.items || j.results || j.data || [j]);
        return ok({
          route: 'report', report: rep, upstream_path: path,
          n: rows.length,
          note: 'VTV:n valmiiksi laskema kooste. Kevyempi kuin massahaku ' +
                'ja käyttöehtojen mukainen ensisijainen tapa.',
          data: rows,
        });
      }

      // Massahaku — VAADITTU vahvistus.
      //
      // Toimintailmoitukset ovat OGAS3:n kannalta kiinnostavin aineisto
      // (vaikuttamistoiminnan kohteet = ROE:n policy_proximity 0.70,
      // jota lausunnoista ei voi mitata lainkaan). Mutta ne ovat myös
      // se aineisto jonka VTV nimeää hitaaksi.
      //
      // Siksi massahaku ei ole oletus vaan erikseen vahvistettava, ja
      // se kirjaa varoituksen vastaukseen jotta kutsuja näkee mitä
      // teki.
      if (p.get('bulk')) {
        if (p.get('bulk') !== 'confirm')
          throw new Error(
            'Massahaku vaatii ?bulk=confirm. Lue käyttöehdot ensin: ' +
            'rajapinta on tarkoitettu kevyisiin käyttötapauksiin eikä ' +
            'kapasiteetin riittävyyttä taata.');
        const route = p.get('r2') || 'activities';
        if (!ROUTES[route]) throw new Error(`tuntematon reitti: ${route}`);
        const maxPages = Math.min(Number(p.get('pages') || 3), 10);
        const out = [];
        const trace = [];
        for (let i = 0; i < maxPages; i++) {
          const j = await fj(ROUTES[route],
            { limit: String(PAGE_MAX), offset: String(i * PAGE_MAX) });
          const rows = Array.isArray(j) ? j : (j.items || j.results || j.data || []);
          trace.push(`sivu ${i}: ${rows.length}`);
          out.push(...rows);
          if (rows.length < PAGE_MAX) break;
          await sleep(SPACING_MS);          // peräkkäin, ei rinnakkain
        }
        return ok({
          route, bulk: true, pages_fetched: trace.length, n: out.length,
          trace,
          warning: 'MASSAHAKU AJETTU. Tallenna tulos tiedostoon äläkä ' +
                   'toista hakua. Sivukatto ' + maxPages + ', väli ' +
                   SPACING_MS + ' ms. Jos VTV palauttaa 403 tai 429, ' +
                   'lopeta — käyttöehdot sallivat pääsyn rajoittamisen.',
          data: out,
        });
      }

      return Response.json({
        service: 'aci-avoimuus-proxy',
        principle: 'Välimuisti on oletus, ei optimointi. Käyttötarkoitus on ' +
                   'neljännesvuosikaappaus, ei live-kysely. Ilmoituskaudet ' +
                   'ovat kahdesti vuodessa.',
        routes: Object.keys(ROUTES).map(k => `?r=${k}&limit=50&offset=0`),
        reports: Object.keys(REPORTS).map(k => `?report=${k}` + (REPORTS[k].includes('{termId}') ? '&termId=…' : '')),
        reports_first: 'KÄYTÄ RAPORTTEJA ENNEN MASSAHAKUA — VTV laskee koosteen puolestasi.',
        bulk: '?bulk=confirm&r2=activities&pages=3   (vaatii vahvistuksen)',
        spec: '?spec=1   polkuluettelo · ?spec=/open-data-activity-notification   yhden polun parametrit',
        limits: {
          page_max: PAGE_MAX,
          spacing_ms: SPACING_MS,
          cache_days: 30,
        },
        why_ogas3: 'Toimintailmoitusten vaikuttamistoiminnan kohteet ovat ' +
                   'ainoa lähde ROE:n policy_proximity-tasolle 0.70 ' +
                   '("suora kontakti valmisteluun"). Lausunnoista sitä ei ' +
                   'voi mitata: ne ovat kaikki tasoa 0.40.',
        terms: 'https://avoimuusrekisteri.fi/perustietoa/avoin-data',
        swagger: 'https://public.api.avoimuusrekisteri.fi/swagger',
        traps: [
          'REITIT OVAT ARVAUKSIA. open-data-etuliite on dokumentaatiosta, ' +
          'mutta tarkat polut on tarkistettava Swaggerista. Jos reitti ' +
          'palauttaa 404, korjaa ROUTES-taulukko — ÄLÄ arvaa toista.',
          'Toimintailmoitukset ovat VTV:n mukaan hitaita suuren datamäärän ' +
          'vuoksi. Odota, älä uusi pyyntöä.',
          '403 ja 429 EIVÄT ole tavallisia virheitä: ne tarkoittavat ' +
          'volyymirajaa. Lopeta hakeminen.',
          'Cloudflaren workerissa kaikki kutsut tulevat samasta IP:stä. ' +
          'Volyymiraja on jaettu kaiken tästä osoitteesta tulevan kesken.',
        ],
      }, { status: 400, headers: CORS });

    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: CORS });
    }
  },
};
