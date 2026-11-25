"""Register a CSV of venue photos supplied as local files."""
import argparse
import csv
import hashlib
import json
import re
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'data/place-photos.js'
PHOTOS = ROOT / 'assets/place-photos'
PREFIX = 'export default '
COLUMNS = {'name', 'address', 'placeId', 'file'}


def venue_key(row):
    return row['name'], row['address']


def import_photos(csv_path):
    existing = json.loads(MANIFEST.read_text(encoding='utf-8').removeprefix(PREFIX))
    photos = {venue_key(row): row for row in existing}
    coverage = json.loads(subprocess.check_output(
        ['node', str(ROOT / 'scripts/check-data.cjs'), '--photo-coverage'],
        text=True, encoding='utf-8',
    ))
    known = photos.keys() | {venue_key(row) for row in coverage['missing']}
    batch = {}
    with csv_path.open(encoding='utf-8-sig', newline='') as file:
        reader = csv.DictReader(file)
        if set(reader.fieldnames or ()) != COLUMNS:
            raise ValueError('CSV columns must be name,address,placeId,file')
        for row in reader:
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f'Line {reader.line_num}: invalid CSV row')
            key = venue_key(row)
            if key not in known or key in batch:
                raise ValueError(f'Line {reader.line_num}: unknown or duplicate venue {key}')
            if not re.fullmatch(r'[0-9]+', row['placeId']):
                raise ValueError(f'Line {reader.line_num}: invalid Naver Place ID')
            source = csv_path.parent / row['file']
            if not source.is_file():
                raise ValueError(f'Line {reader.line_num}: photo file not found: {source}')
            batch[key] = (row['placeId'], source)

    if not batch:
        raise ValueError('CSV contains no photos')

    # Encode a whole batch before replacing the manifest.
    with TemporaryDirectory(dir=ROOT) as workspace:
        temporary = Path(workspace)
        generated = {}
        for index, ((name, address), (place_id, source)) in enumerate(batch.items()):
            output = temporary / f'{index}.webp'
            subprocess.run([
                'cwebp', '-quiet', '-resize', '560', '0', '-q', '78',
                str(source), '-o', str(output),
            ], check=True)
            digest = hashlib.sha256(output.read_bytes()).hexdigest()[:16]
            image = f'{place_id}-{digest}.webp'
            generated[image] = output
            photos[name, address] = {
                'name': name, 'address': address, 'image': image, 'placeId': place_id,
            }
        manifest = temporary / MANIFEST.name
        manifest.write_text(PREFIX + json.dumps(list(photos.values()), ensure_ascii=False, indent=2) + '\n',
                            encoding='utf-8')
        for image, output in generated.items():
            output.replace(PHOTOS / image)
        manifest.replace(MANIFEST)

    print(f'Registered {len(batch)} photos. Coverage: {len(photos)}/{len(known)} venues.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path, help='CSV with local photo paths relative to the CSV file')
    args = parser.parse_args()
    try:
        import_photos(args.csv.resolve())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{error}\n')
