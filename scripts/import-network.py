"""Convert subway-etl's station_nodes.csv and station_edges.csv to map data."""

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

LINE_STYLES = {
    '1': ('1호선', '#0052a4'), '2': ('2호선', '#00864d'),
    '3': ('3호선', '#d15a12'), '4': ('4호선', '#008bbb'),
    '5': ('5호선', '#8247af'), '6': ('6호선', '#a35a18'),
    '7': ('7호선', '#68751b'), '8': ('8호선', '#d53875'),
    '9': ('9호선', '#8e7745'), '경의·중앙선': ('경의·중앙선', '#2a9c83'),
    '경춘선': ('경춘선', '#128b78'), '수인분당선': ('수인·분당선', '#ce8a00'),
    '신분당선': ('신분당선', '#bb2339'), '서해선': ('서해선', '#568c23'),
    '경강선': ('경강선', '#2869bb'), '인천국제공항선': ('공항철도', '#1886ac'),
    '인천지하철 1호선': ('인천 1호선', '#527db3'),
    '인천지하철 2호선': ('인천 2호선', '#db8317'),
    '의정부': ('의정부경전철', '#cf741d'),
    '수도권 경량도시철도 에버라인': ('용인 에버라인', '#509d2e'),
    '수도권 경량도시철도 우이신설선': ('우이신설선', '#738c29'),
    '수도권 경량도시철도 신림선': ('신림선', '#5267bc'),
    '김포도시철도': ('김포골드라인', '#a07b23'),
    'GTX-A': ('GTX-A', '#93365e'), '자기부상철도': ('인천공항 자기부상철도', '#aa803a'),
}


def read_rows(path):
    with open(path, encoding='utf-8-sig', newline='') as source:
        return list(csv.DictReader(source))


def import_network(nodes_path, edges_path):
    nodes = {row['id']: row for row in read_rows(nodes_path)}
    parents = {node_id: node_id for node_id in nodes}
    segments = defaultdict(set)

    def root(node_id):
        while node_id != parents[node_id]:
            node_id = parents[node_id]
        return node_id

    for edge in read_rows(edges_path):
        a, b = sorted((edge['from_node_id'], edge['to_node_id']))
        start, end = nodes[a], nodes[b]
        if edge['edge_type'] == 'TRANSFER' and start['station_name'] == end['station_name']:
            first, second = sorted((root(a), root(b)))
            parents[second] = first
        if edge['edge_type'] == 'RIDE':
            if start['line_key'] != end['line_key']:
                raise ValueError(f'Ride edge crosses lines: {a}, {b}')
            segments[start['line_key']].add((a, b))

    groups = defaultdict(list)
    for node in nodes.values():
        groups[root(node['id'])].append(node)

    stations = []
    for station_id, members in sorted(groups.items()):
        name = members[0]['station_name']
        stations.append({
            'id': station_id,
            'name': '서울역' if name == '서울' else name,
            'lat': round(sum(float(m['lat']) for m in members) / len(members), 6),
            'lon': round(sum(float(m['lon']) for m in members) / len(members), 6),
            'lines': list(dict.fromkeys(m['line_key'] for m in members)),
        })

    lines = []
    for line_id, (name, color) in LINE_STYLES.items():
        if line_id not in segments:
            continue
        edges = {tuple(sorted((root(a), root(b)))) for a, b in segments[line_id]}
        lines.append({
            'id': line_id, 'name': name, 'color': color,
            'edges': [edge for edge in sorted(edges) if edge[0] != edge[1]],
        })

    if set(segments) - LINE_STYLES.keys():
        raise ValueError(f'Missing styles: {set(segments) - LINE_STYLES.keys()}')
    return {'lines': lines, 'stations': stations}


if __name__ == '__main__':
    network = import_network(*sys.argv[1:])
    output = Path(__file__).resolve().parents[1] / 'data' / 'network.js'
    output.write_text('export default ' + json.dumps(network, ensure_ascii=False, separators=(',', ':')) + '\n',
                      encoding='utf-8')
    print(f"{len(network['lines'])} lines, {len(network['stations'])} stations")
