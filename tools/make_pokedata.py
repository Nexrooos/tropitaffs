# Construit data/pokemon.json : familles d'évolution des Pokémon implémentés dans Cobblemon 1.8.4,
# sans légendaires ni fabuleux, avec noms et talents en français (PokéAPI).
import json, glob, csv, re, sys, collections
SPEC = sys.argv[1]; P = sys.argv[2]; OUT = sys.argv[3]; SPAWN = sys.argv[4]
REGIONAL = {'alolan', 'galarian', 'hisuian', 'paldean'}  # formes régionales (les autres variantes comptent comme la forme de base)
norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())

fr_species = {int(r['pokemon_species_id']): r['name'] for r in csv.DictReader(open(P + 'pokemon_species_names.csv', encoding='utf-8')) if r['local_language_id'] == '5'}
ab_ident = {r['id']: norm(r['identifier']) for r in csv.DictReader(open(P + 'abilities.csv', encoding='utf-8'))}
fr_ability = {ab_ident[r['ability_id']]: r['name'] for r in csv.DictReader(open(P + 'ability_names.csv', encoding='utf-8')) if r['local_language_id'] == '5' and r['ability_id'] in ab_ident}
pk_species = {int(r['id']): r for r in csv.DictReader(open(P + 'pokemon_species.csv', encoding='utf-8'))}

species = {}
for f in glob.glob(SPEC + '/*/*.json'):
    d = json.load(open(f, encoding='utf-8'))
    if not d.get('implemented'): continue
    n = d['nationalPokedexNumber']
    labels = set(d.get('labels', []))
    if labels & {'legendary', 'mythical'} or pk_species[n]['is_legendary'] == '1' or pk_species[n]['is_mythical'] == '1':
        continue
    species[norm(d['name'])] = d

REGION_FR = {'alolan': "d'Alola", 'galarian': 'de Galar', 'hisuian': 'de Hisui', 'paldean': 'de Paldea'}
BREED_FR = {'combat': 'Race Combative', 'blaze': 'Race Flamboyante', 'aqua': 'Race Aquatique'}
forms = {}  # clé 'espece|aspect(|race)' -> (donnees espece, forme)
for k, d in species.items():
    for fm in d.get('forms', []):
        asp = fm.get('aspects', [])
        reg = [a for a in asp if a in REGIONAL]
        if not reg: continue
        breed = next((b for b in ('combat', 'blaze', 'aqua') if any(a.startswith(b) for a in asp)), 'combat' if 'Paldea-Combat' == fm.get('name') else None)
        key = k + '|' + reg[0] + ('|' + breed if breed and k == 'tauros' else '')
        forms[key] = (d, fm, reg[0], breed if k == 'tauros' else None)
missing_ab = set()
def ab_fr(a):
    k = norm(a)
    if k not in fr_ability: missing_ab.add(a); return a
    return fr_ability[k]

# Graphe d'évolution (uniquement entre espèces gardées)
parent = {k: k for k in species}
def find(x):
    while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
    return x
pre = {}
for k, d in species.items():
    for ev in d.get('evolutions', []):
        res = norm(str(ev.get('result', '')).split(' ')[0])
        if res in species and res != k:
            parent[find(res)] = find(k)
            pre.setdefault(res, k)
    for fm in d.get('forms', []):
        for ev in fm.get('evolutions', []):
            res = norm(str(ev.get('result', '')).split(' ')[0])
            if res in species and res != k:
                parent[find(res)] = find(k)
                pre.setdefault(res, k)
# Liens spéciaux que Cobblemon ne déclare pas comme évolution classique
for child, par in {'shedinja': 'nincada'}.items():
    if child in species and par in species:
        parent[find(child)] = find(par); pre.setdefault(child, par)
def depth(k, seen=()):
    return 0 if k not in pre or k in seen else 1 + depth(pre[k], seen + (k,))

# Rareté d'apparition dans la nature (meilleure rareté parmi les apparitions normales, forme de base)
ORDER = ['common', 'uncommon', 'rare', 'ultra-rare']
best, snack_only = {}, {}
for f in glob.glob(SPAWN + '/*.json'):
    d = json.load(open(f, encoding='utf-8'))
    if d.get('enabled') is False: continue
    for sp in d.get('spawns', []):
        parts = str(sp.get('pokemon', '')).split()
        # On ignore seulement les formes régionales ; les variantes simples (motif, sexe, couleur...) comptent
        if not parts or sp.get('bucket') not in ORDER: continue
        k = norm(parts[0])
        reg = [t for t in parts[1:] if t.split('=')[0] in REGIONAL]
        if reg:
            breed = [t.split('=')[1] for t in parts[1:] if t.startswith('bull_breed=')]
            k = k + '|' + reg[0] + ('|' + breed[0] if breed else '')
        target = snack_only if (sp.get('condition') or {}).get('isPokeSnack') else best
        if k not in target or ORDER.index(sp['bucket']) < ORDER.index(target[k]): target[k] = sp['bucket']
def rarity(k):
    if '|' in k and k not in best and k not in snack_only:
        # forme régionale : toutes races confondues si besoin
        cands = [v for kk, v in best.items() if kk.startswith(k)]
        if cands: return min(cands, key=ORDER.index)
        cands = [v for kk, v in snack_only.items() if kk.startswith(k)]
        if cands: return min(cands, key=ORDER.index) + '*'
        return 'none'
    if k in best: return best[k]
    if k in snack_only: return snack_only[k] + '*'
    return 'none'

fams = collections.defaultdict(list)
for k in species: fams[find(k)].append(k)
out = []
for root, members in fams.items():
    members.sort(key=lambda k: (depth(k), species[k]['nationalPokedexNumber']))
    mons = []
    for k in members:
        d = species[k]; n = d['nationalPokedexNumber']
        normal = [ab_fr(a) for a in d.get('abilities', []) if not a.startswith('h:')]
        hidden = [ab_fr(a[2:]) for a in d.get('abilities', []) if a.startswith('h:')]
        normal = list(dict.fromkeys(normal))
        mons.append({'id': str(n), 'n': n, 'fr': fr_species.get(n, d['name']), 'en': d['name'], 'ab': normal, 'tc': hidden[0] if hidden else None, 'r': rarity(k)})
        for fk, (fd, fm, reg, breed) in sorted(forms.items(), key=lambda kv: (kv[1][2], ['combat', 'blaze', 'aqua', None].index(kv[1][3]))):
            if fk.split('|')[0] != k: continue
            abl = fm.get('abilities') or d.get('abilities', [])
            fnormal = list(dict.fromkeys(ab_fr(a) for a in abl if not a.startswith('h:')))
            fhidden = [ab_fr(a[2:]) for a in abl if a.startswith('h:')]
            name = f"{fr_species.get(n, d['name'])} {REGION_FR[reg]}" + (f" ({BREED_FR[breed]})" if breed else '')
            mons.append({'id': f"{n}-{reg}" + (f"-{breed}" if breed else ''), 'n': n, 'fr': name, 'en': f"{d['name']} {fm.get('name')}",
                         'ab': fnormal, 'tc': fhidden[0] if fhidden else None, 'r': rarity(fk), 'reg': 1})
    out.append(mons)
out.sort(key=lambda fam: min(m['n'] for m in fam))
json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('familles', len(out), 'pokemon', sum(len(f) for f in out), 'talents non traduits', sorted(missing_ab))
