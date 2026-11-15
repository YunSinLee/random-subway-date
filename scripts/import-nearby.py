"""Build nearby park or traditional market candidates from public CSV or JSON data."""
import csv
import json
import math
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
FIELD_NAMES = {
    'PARK_NM': '공원명', 'PARK_SE': '공원구분', 'RDNMADR': '소재지도로명주소',
    'LNMADR': '소재지지번주소', 'LATITUDE': '위도', 'LONGITUDE': '경도',
    'PARK_AR': '공원면적', 'MRKT_NM': '시장명', 'MRKT_TYPE': '시장유형',
    'STOR_NUMBER': '점포수',
}
PARK_TYPES = {'근린공원', '문화공원', '수변공원', '역사공원', '체육공원', '도시자연공원'}


def source_rows(path):
    if path.suffix == '.json':
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        rows = data if isinstance(data, list) else data.get('records', data.get('rows'))
        for row in rows:
            yield {key: row.get(key, row.get(label)) for key, label in FIELD_NAMES.items()}
        return
    raw = path.read_bytes()
    try:
        content = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        content = raw.decode('cp949')
    for row in csv.DictReader(content.splitlines()):
        yield {key: row.get(label) for key, label in FIELD_NAMES.items()}


def distance(a_lat, a_lon, b_lat, b_lon):
    dlat, dlon = map(math.radians, (b_lat - a_lat, b_lon - a_lon))
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(dlon / 2) ** 2
    return 12_742_000 * math.asin(math.sqrt(h))


def import_nearby(kind, path):
    if kind not in {"parks", "markets"}:
        raise ValueError("Expected parks or markets")
    is_park = kind == "parks"
    network = json.loads((PROJECT / 'data/network.js').read_text().removeprefix('export default '))
    places = {}
    for row in source_rows(path):
        name = (row['PARK_NM' if is_park else 'MRKT_NM'] or '').strip()
        address = (row['RDNMADR'] or row['LNMADR'] or '').strip()
        if not name or not address:
            continue
        try:
            lat, lon = (float(row[key] or 'nan') for key in ('LATITUDE', 'LONGITUDE'))
            size = float(str(row['PARK_AR' if is_park else 'STOR_NUMBER'] or 0).replace(',', ''))
        except ValueError:
            continue
        if not all(map(math.isfinite, (lat, lon, size))) or not (36.5 < lat < 38.3 and 126 < lon < 128.2):
            continue
        if is_park and (size < 5000 or row['PARK_SE'] not in PARK_TYPES):
            continue
        category = row['PARK_SE'] if is_park else (row['MRKT_TYPE'] or '전통시장')
        if not is_park and size > 0:
            category += f' · 공공데이터 기준 점포 {int(size):,}곳'
        places[name, address] = (lat, lon, category)

    result = {}
    for station in network['stations']:
        nearby = []
        for (name, address), (lat, lon, category) in places.items():
            if abs(station['lat'] - lat) > .012 or abs(station['lon'] - lon) > .015:
                continue
            meters = distance(station['lat'], station['lon'], lat, lon)
            if meters <= 1000:
                nearby.append((round(meters), name, address, category, lat, lon))
        if nearby:
            result[station['id']] = [
                [name, address, category, meters, lat, lon] for meters, name, address, category, lat, lon in sorted(nearby)[:3]
            ]

    (PROJECT / f'data/{kind}.js').write_text(
        'export default ' + json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n',
        encoding='utf-8',
    )
    print(f'{len(result)} stations with {kind} candidates, {sum(map(len, result.values()))} matches')


if __name__ == '__main__':
    import_nearby(sys.argv[1], Path(sys.argv[2]))
