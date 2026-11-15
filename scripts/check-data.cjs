const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const reportCoverage = process.argv.includes('--app-coverage')
const reportGaps = process.argv.includes('--coverage-gaps')

function readGeneratedData(name) {
  const file = path.join(__dirname, '..', 'data', name + '.js')
  const source = fs.readFileSync(file, 'utf8')
  assert.ok(source.startsWith('export default '), file)
  return JSON.parse(source.slice('export default '.length))
}

function checkCoordinates(lat, lon, context) {
  assert.ok(Number.isFinite(lat) && lat > 36.5 && lat < 38.3, context)
  assert.ok(Number.isFinite(lon) && lon > 126 && lon < 128.2, context)
}

function checkDistance(station, meters, lat, lon, context) {
  checkCoordinates(lat, lon, context)
  assert.ok(Number.isInteger(meters) && meters >= 0, context)
  const distance = Math.hypot(
    (station.lat - lat) * 111195,
    (station.lon - lon) * 111195 * Math.cos(station.lat * Math.PI / 180),
  )
  assert.ok(Math.abs(distance - meters) < 3, context + ' distance mismatch')
}

const network = readGeneratedData('network')
const covered = { activity: new Set(), food: new Set(), cafe: new Set() }
const generatedVenues = new Set()
const activityKeysByStation = new Map()
let associations = 0
const stations = new Map(network.stations.map((station) => [station.id, station]))
const lines = new Map(network.lines.map((line) => [line.id, line]))
assert.equal(stations.size, network.stations.length)
assert.equal(lines.size, network.lines.length)
const served = new Map([...lines.keys()].map((id) => [id, new Set()]))
for (const line of lines.values()) {
  const uniqueEdges = new Set()
  for (const [from, to] of line.edges) {
    assert.notEqual(from, to, line.id)
    const key = JSON.stringify([from, to].sort())
    assert.ok(!uniqueEdges.has(key), line.id + ' duplicate edge ' + key)
    uniqueEdges.add(key)
    for (const id of [from, to]) {
      assert.ok(stations.get(id)?.lines.includes(line.id), line.id + ' unknown endpoint ' + id)
      served.get(line.id).add(id)
    }
  }
}
for (const station of stations.values()) {
  checkCoordinates(station.lat, station.lon, station.id)
  assert.ok(station.name && station.lines.length, station.id)
  for (const id of station.lines) assert.ok(served.get(id)?.has(station.id), station.id + ' orphaned on ' + id)
}

function checkPlaces(entries, station, limit, context, keys = new Set()) {
  assert.ok(entries.length >= 1 && entries.length <= 3, context)
  for (const [name, address, description, meters, lat, lon] of entries) {
    assert.ok(name && address && description, context)
    const key = JSON.stringify([name, address])
    assert.ok(!keys.has(key), context + ' duplicate venue ' + name)
    keys.add(key)
    generatedVenues.add(key)
    associations += 1
    assert.ok(meters <= limit, context)
    checkDistance(station, meters, lat, lon, context + ' ' + name)
  }
}

for (const name of ['parks', 'markets', 'shops']) {
  const data = readGeneratedData(name)
  for (const [id, value] of Object.entries(data)) {
    const station = stations.get(id)
    assert.ok(station, name + ' invalid station ' + id)
    if (name === 'shops') {
      for (const [category, entries] of Object.entries(value)) {
        assert.ok(['food', 'cafe'].includes(category), category)
        covered[category].add(id)
        checkPlaces(entries, station, 800, name + ' ' + category + ' ' + id)
      }
    } else {
      covered.activity.add(id)
      if (!activityKeysByStation.has(id)) activityKeysByStation.set(id, new Set())
      checkPlaces(value, station, 1000, name + ' ' + id, activityKeysByStation.get(id))
    }
  }
}
const complete = [...stations.keys()].filter((id) =>
  Object.values(covered).every((ids) => ids.has(id)))
if (!reportCoverage && !reportGaps) {
  console.log(`Passed: ${lines.size} lines, ${stations.size} stations, and all generated venue coordinates and distances`)
  console.log(`Generated venue records: ${generatedVenues.size} unique (name + address), ${associations} station links`)
  console.log(`Stations covered by generated data: activity ${covered.activity.size}, food ${covered.food.size}, cafe ${covered.cafe.size}, all three ${complete.length}`)
}

async function checkCuratedPlaces() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'data', 'places.js'), 'utf8')
  const { default: curated } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const stationDeclarations = [...source.matchAll(/^ {2}'(\d+)':\s*\{/gm)].map((match) => match[1])
  assert.deepEqual(stationDeclarations.sort(), Object.keys(curated).sort(),
    'Each curated station must have a single entry containing all of its categories')
  let count = 0
  for (const [id, categories] of Object.entries(curated)) {
    assert.ok(stations.has(id), 'curated invalid station ' + id)
    for (const [category, entries] of Object.entries(categories)) {
      assert.ok(Object.hasOwn(covered, category), category)
      assert.ok(entries.length, id + ' ' + category)
      covered[category].add(id)
      const keys = new Set()
      for (const [name, address, description, meters, lat, lon, mapSearch, guideUrl, access] of entries) {
        assert.ok(name?.trim() && address?.trim() && description?.trim(), id + ' ' + category)
        if ([meters, lat, lon].some((value) => value !== undefined)) {
          checkDistance(stations.get(id), meters, lat, lon, id + ' ' + name)
        }
        if (mapSearch !== undefined) {
          assert.ok(typeof mapSearch === 'string' && mapSearch.trim(), id + ' invalid map search for ' + name)
        }
        if (guideUrl !== undefined) {
          assert.ok(typeof guideUrl === 'string' && new URL(guideUrl).protocol === 'https:', id + ' invalid visitor guide for ' + name)
        }
        if (access !== undefined) {
          assert.equal(access, 'transit', id + ' invalid access type for ' + name)
          assert.equal(meters, undefined, id + ' transit candidate must remain outside the distance filter: ' + name)
        }
        if (/별도 이동|버스 (?:환승|이용)|셔틀/.test(description)) {
          assert.equal(access, 'transit', id + ' missing transit marker for ' + name)
        }
        const key = JSON.stringify([name.trim(), address.trim()])
        assert.ok(!keys.has(key), id + ' duplicate curated venue ' + name)
        keys.add(key)
        count += 1
      }
    }
  }
  const combinedComplete = [...stations.keys()].filter((id) =>
    Object.values(covered).every((ids) => ids.has(id)))
  if (reportGaps) {
    const gaps = [...stations.values()].flatMap(({ id, name, lines: stationLines }) => {
      const missing = Object.keys(covered).filter((category) => !covered[category].has(id))
      return missing.length ? [{ id, name, lines: stationLines.map((lineId) => lines.get(lineId).name), missing }] : []
    })
    console.log(JSON.stringify(gaps, null, 2))
  } else if (reportCoverage) {
    const completeIds = new Set(combinedComplete)
    const parks = readGeneratedData('parks')
    const markets = readGeneratedData('markets')
    const shops = readGeneratedData('shops')
    const nearbyIds = new Set([...stations.keys()].filter((id) => {
      const candidates = curated[id] ?? {}
      return [
        candidates.activity ?? [...(parks[id] ?? []), ...(markets[id] ?? [])],
        candidates.food ?? shops[id]?.food ?? [],
        candidates.cafe ?? shops[id]?.cafe ?? [],
      ].every((entries) => entries.some(([, , , meters]) => Number.isFinite(meters) && meters <= 800))
    }))
    const byLine = Object.fromEntries([...served].map(([id, stationIds]) => [
      id, {
        total: stationIds.size,
        complete: [...stationIds].filter((stationId) => completeIds.has(stationId)).length,
        nearby: [...stationIds].filter((stationId) => nearbyIds.has(stationId)).length,
      },
    ]))
    console.log(JSON.stringify({ stations: stations.size, complete: combinedComplete.length, nearby: nearbyIds.size, byLine }))
  } else {
    console.log(`Passed: ${count} curated venue entries across ${Object.keys(curated).length} stations`)
    console.log(`Stations with app candidates: activity ${covered.activity.size}, food ${covered.food.size}, cafe ${covered.cafe.size}, all three ${combinedComplete.length}`)
    const coverageByLine = [...lines.values()].map((line) => {
      const stationIds = [...served.get(line.id)]
      const categories = Object.entries(covered)
      const missingByCategory = categories.map(([category, ids]) => {
        const count = stationIds.filter((id) => !ids.has(id)).length
        return { category, count }
      })
      const incomplete = stationIds.filter((id) => categories.some(([, ids]) => !ids.has(id))).length
      return { name: line.name, total: stationIds.length, incomplete, missingByCategory }
    })
    coverageByLine.sort((a, b) => b.incomplete - a.incomplete)
    const largestGaps = coverageByLine.filter((line) => line.incomplete).slice(0, 5)
    if (largestGaps.length) {
      console.log('Lines with the most stations missing a category:')
      for (const { name, total, incomplete, missingByCategory } of largestGaps) {
        const counts = missingByCategory.map(({ category, count }) => `${category} ${count}`).join(', ')
        console.log(`  ${name} ${incomplete}/${total} (${counts})`)
      }
    }
  }
}

checkCuratedPlaces().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
