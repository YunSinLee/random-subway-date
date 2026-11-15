"""Import nearby food and cafe candidates from the SE-MAS quarterly ZIP."""
import csv
import io
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from zipfile import ZipFile

PROJECT = Path(__file__).resolve().parents[1]
REGIONS = ('서울', '경기', '인천', '충남', '강원')
FOOD_GROUPS = {'한식', '중식', '일식', '서양식', '기타 간이', '기타 외국', '동남아시아'}


def grid(lat, lon):
    return math.floor(lat * 100), math.floor(lon * 100)


def select_candidates(candidates):
    ordered = sorted(candidates)
    selected = []
    addresses = set()
    for candidate in ordered:
        address = candidate[2]
        if address in addresses:
            continue
        addresses.add(address)
        selected.append(candidate)
        if len(selected) == 3:
            break
    for candidate in ordered:
        if len(selected) == 3:
            break
        if candidate not in selected:
            selected.append(candidate)
    return [
        [title, address, subtype, meters, lat, lon]
        for meters, title, address, subtype, lat, lon in selected
    ]


def import_shops(path):
    network = json.loads((PROJECT / 'data/network.js').read_text().removeprefix('export default '))
    shops = defaultdict(dict)
    periods = set()
    with ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.endswith('.csv') or not any(f'_{region}_' in name for region in REGIONS):
                continue
            period = re.search(r'_(\d{4})(0[1-9]|1[0-2])\.csv$', name)
            if not period:
                raise ValueError(f'Missing YYYYMM in {name}')
            periods.add(f'{period[1]}년 {int(period[2])}월')
            print(name)
            with archive.open(name) as member:
                reader = csv.DictReader(io.TextIOWrapper(member, encoding='utf-8-sig', newline=''))
                for row in reader:
                    if row['상권업종대분류명'] != '음식':
                        continue
                    group = row['상권업종중분류명'].strip()
                    subtype = row['상권업종소분류명'].strip()
                    if subtype == '카페':
                        category = 'cafe'
                    elif group in FOOD_GROUPS and subtype not in {'빵/도넛', '떡/한과', '아이스크림/빙수'}:
                        category = 'food'
                    else:
                        continue
                    title = ' '.join(filter(None, (row['상호명'].strip(), row['지점명'].strip())))
                    address = row['도로명주소'] or row['지번주소']
                    if not title or not address:
                        continue
                    try:
                        lat, lon = float(row['위도']), float(row['경도'])
                    except ValueError:
                        continue
                    if not (36.5 < lat < 38.3 and 126 < lon < 128.2):
                        continue
                    shops[grid(lat, lon)][category, title, address] = (lat, lon, subtype)

    if len(periods) != 1:
        raise ValueError('The archive must contain one source month')
    if not shops:
        raise ValueError('No matching shops found in the archive')
    results = {}
    for station in network['stations']:
        lat, lon = station['lat'], station['lon']
        row, column = grid(lat, lon)
        nearby = defaultdict(list)
        for i in range(row - 1, row + 2):
            for j in range(column - 1, column + 2):
                for (category, title, address), (shop_lat, shop_lon, subtype) in shops.get((i, j), {}).items():
                    distance = math.hypot((lat - shop_lat) * 111_195,
                                          (lon - shop_lon) * 111_195 * math.cos(math.radians(lat)))
                    if distance <= 800:
                        nearby[category].append((round(distance), title, address, subtype, shop_lat, shop_lon))
        if nearby:
            results[station['id']] = {
                category: select_candidates(candidates)
                for category, candidates in nearby.items()
            }
    (PROJECT / 'data/shops.js').write_text(
        'export default ' + json.dumps(results, ensure_ascii=False, separators=(',', ':')) + '\n',
        encoding='utf-8',
    )
    (PROJECT / 'data/shop-source.js').write_text(
        'export default ' + json.dumps(periods.pop(), ensure_ascii=False) + '\n', encoding='utf-8',
    )
    for category in ('food', 'cafe'):
        print(f'{category}: {sum(category in items for items in results.values())} stations')


if __name__ == '__main__':
    import_shops(Path(sys.argv[1]))
