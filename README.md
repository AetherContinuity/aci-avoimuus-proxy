# aci-avoimuus-proxy

Cloudflare Worker avoimuusrekisterin avoimelle rajapinnalle.
Valtiontalouden tarkastusviraston ylläpitämä rekisteri eduskuntaan ja
ministeriöihin kohdistuvasta vaikuttamistoiminnasta (avoimuusrekisterilaki
430/2023).

**Tämä proxy on rakennettu eri periaatteella kuin muut ACI-proxyt.**
Lue "Miksi tämä on erilainen" ennen kuin muutat mitään.

## Miksi tämä on olemassa

OGAS3:n ROE määrittelee `policy_proximity`-asteikon:

```
0.20  julkinen media
0.40  valiokuntalausunto TAI lausuntomenettely
0.70  suora kontakti valmisteluun
1.00  osallistuminen päätöksentekoon
```

Energiahankkeiden lausuntoaineistosta mitattiin 2 265 lausuntoa
50 hankkeesta. **Jokainen sai arvon 0.40** — koska lausuntomenettely
*on* määritelmän mukaan 0.40. Asteikon yläpää oli mittaamaton.

Avoimuusrekisterin toimintailmoitukset kertovat vaikuttamistoiminnan
kohteet: kehen otettiin yhteyttä, mistä aiheesta, millä tavalla. Se on
ainoa lähde tasolle 0.70.

Ja se on **authoritative**, ei self-reported hallinnon prosessikuvaus:
ilmoitusvelvollisuus on lakisääteinen.

## Miksi tämä on erilainen

Muut ACI-proxyt hakevat vapaasti ja välimuistittavat tuloksen. Tämä ei.
Syy on käyttöehdoissa, ja ne ovat poikkeuksellisen suorat:

> *"Rajapinta on tarkoitettu **kevyisiin käyttötapauksiin**, joissa
> suorituskyky ei ole kriittistä. Rajapintaa ei suositella suurten
> tietomäärien käsittelyyn, sillä **kapasiteetin riittävyyttä ei
> taata**."*

> *"Tietoaineiston tuottaja voi **rajoittaa yksittäisen käyttäjän
> pääsyä** rajapintaan, jos käytön volyymi häiritsee palvelun
> toimintaa."*

> *"Erityisesti **toimintailmoituksiin** liittyvien rajapintojen
> vastausnopeudessa voi ilmetä hitautta suuren datamäärän vuoksi."*

Kolmas koskee juuri sitä aineistoa jota OGAS3 tarvitsee.

**Ja Cloudflaren workerissa kaikki kutsut tulevat samasta IP:stä.**
Jos tämä proxy käyttäytyy huonosti, VTV sulkee pääsyn — eikä vain
tältä proxylta vaan kaikelta mikä tulee siitä osoitteesta. Volyymiraja
on jaettu.

Siksi:

| | |
|---|---|
| Välimuisti | **30 vrk, oletus eikä optimointi** |
| Sivukatto | **100, ei ohitettavissa** |
| Kutsujen väli | 500 ms, peräkkäin — ei rinnakkaisuutta |
| Massahaku | vaatii `?bulk=confirm` ja kirjaa varoituksen |
| Käyttötarkoitus | **neljännesvuosikaappaus, ei live-kysely** |

Ilmoituskaudet ovat kahdesti vuodessa. Neljännesvuosikadenssi on siis
jo tiheämpi kuin datan oma päivitystahti — tuoreempi välimuisti ei toisi
mitään mutta kuormittaisi ylävirtaa.

Sama kuvio kuin OGAS3:n `snapshots/` ja WEM:n EPP-snapshot: haetaan
kerran, tallennetaan, luetaan tallennetusta.

## Upstream

| | |
|---|---|
| Kanta | `https://public.api.avoimuusrekisteri.fi` |
| Swagger | `https://public.api.avoimuusrekisteri.fi/swagger` |
| Avain | ei tarvita |
| Lisenssi | CC BY 4.0 |
| Tuottaja | Valtiontalouden tarkastusvirasto |

**HUOM:** rajapinta EI ole avoindata.fi:ssä. Se on VTV:n omalla
palvelimella; avoindata.fi on vain luettelo. Avoindata.fi:n
bottiliikenne ja koneellisen käytön esto 9/2026 eivät koskeneet tätä.

## Reitit

    ?r=registrations   rekisteröinti-ilmoitukset
    ?r=activities      toimintailmoitukset      ← OGAS3:n kohde
    ?r=exits           poistumisilmoitukset
    ?r=periods         ilmoituskaudet
    ?r=reporting       raportointijaksot
    ?r=targets         vaikuttamistoiminnan kohteet

Kaikki tukevat `&limit=` (max 100) ja `&offset=`. Lisäksi
`&search=`, `&from=`, `&to=`, `&periodId=`, `&organizationId=`
välitetään ylävirtaan jos annettu.

Massahaku:

    ?bulk=confirm&r2=activities&pages=3

Ilman `confirm`-arvoa se kieltäytyy ja kertoo miksi.

## Lähdemerkintä on pakollinen

CC BY 4.0 edellyttää sen. Proxy palauttaa valmiin merkinnän
`attribution`-kentässä:

> Valtiontalouden tarkastusvirasto, Avoimuusrekisterin tietoaineisto,
> CC BY 4.0. https://public.api.avoimuusrekisteri.fi/swagger

Jos aineistoa on muokattu, se on mainittava erikseen.

## Ansat

**1 · Reittipolut ovat ARVAUKSIA.** `open-data`-etuliite on
dokumentaatiosta, mutta tarkat päätepisteet on tarkistettava
Swaggerista. Jos reitti antaa 404, korjaa `ROUTES`-taulukko — **älä
arvaa toista.**

Tämä on kirjattu ensimmäiseksi, koska sama virhe tehtiin Eduskunnan
äänestyspolussa neljä kertaa peräkkäin: väärä tunnusmuoto, väärä
johtopäätös tyhjästä 404:stä, turhat otsikkokokeilut, ja lopuksi
`URLSearchParams.get()` joka purki prosenttikoodauksen.

**2 · 403 ja 429 eivät ole tavallisia virheitä.** Ne tarkoittavat
volyymirajaa: käyttö on häirinnyt palvelua ja VTV on rajoittanut
pääsyä. Proxy erottaa ne muista virheistä ja sanoo lopettamaan.
Älä uusi pyyntöä.

**3 · Toimintailmoitukset ovat hitaita.** VTV sanoo sen itse. Odota,
älä uusi.

**4 · Tyhjä sivu ei ole nolla.** Se voi olla sivun loppu tai
`offset` joka ylitti aineiston. Vastauksen `status`-kenttä erottaa
kolme tilaa: sivu täyttyi (lisää voi olla), viimeinen sivu, tai tyhjä.

## Data-luokka

`authoritative (lakisääteinen ilmoitusvelvollisuus)`

Sama erottelu kuin muissa ACI-proxyissa:

- **measured** — mitattua (Fingrid, Eurostat, ECB)
- **authoritative** — lakia, kirjanpitoa tai virallista menettelyä
  (Valtiokonttori, Finlex, Lausuntopalvelu, **Avoimuusrekisteri**)
- **self-reported process data** — hallinnon oma kertomus itsestään
  (Hankeikkuna)

Näitä ei saa sekoittaa koosteissa.

**Ja tässä erottelu on poikkeuksellisen konkreettinen.** Syyskuussa
2026 uutisoitiin tapauksesta, jossa avoimuusrekisterin merkinnät ja
itseraportoitu vastaus viranomaiselle olivat ristiriidassa. Kumpi on
oikeassa, ei ole tämän proxyn asia — mutta se, että ne ovat eri
`data_class`, on koko luokittelun peruste.

## Deploy

    npx wrangler deploy

**EI** `npx wrangler versions upload` — se lataa version muttei ohjaa
tuotantoliikennettä siihen. Build näyttää onnistuneelta ja tuotanto
palvelee vanhaa koodia.

## Ensimmäinen ajo

    ?r=periods

Kevein reitti: ilmoituskaudet on pieni taulukko. Se kertoo kolme asiaa
kerralla — vastaako palvelu, ovatko polut oikein, ja missä muodossa
tulos on kääritty.

Vasta sen jälkeen `?r=activities&limit=5`. Massahakua ei ajeta ennen
kuin yksittäishaku on todennettu.
