import { createBasemap, projectStation } from './data/basemap.js'
import network from './data/network.js'
import places from './data/places.js'
import parks from './data/parks.js'
import markets from './data/markets.js'
import shops from './data/shops.js'
import shopSourceMonth from './data/shop-source.js'

const byId = (id) => document.getElementById(id)
const appTitle = document.title
const map = byId('map')
const drawSettings = byId('draw-settings')
const renderBasemap = createBasemap(byId('map-background'))
const lines = new Map(network.lines.map((line) => [line.id, line]))
const stations = new Map(network.stations.map((station) => [station.id, {
  ...station,
  ...projectStation(station.lat, station.lon),
}]))
const networkBounds = stationBounds([...stations.values()])
const enabled = new Set(lines.keys())
let previewLine = null

function lineIsVisible(id) {
  return id === previewLine || enabled.has(id)
}
const filterInputs = new Map()
const lineCoverage = []
const railPaths = new Map()
const markers = new Map()
let keyboardStation = null
const arrowOffsets = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
const controls = { width: 1, height: 1, x: 0, y: 0, scale: 1 }
let fitScale = 1
let fitted = true
let selected = null
let visible = []
let drag = null
let moved = false
const mapTouches = new Map()
let pinch = null
let drawing = false
let drawTimer = null
let drawResult = null
let drawTrigger = null
let drawOrigin = null
const recentDraws = []
const drawnStations = new Set()
const courseSelection = new Map()
const omittedStops = new Set()
const courseCategories = [
  ['activity', '놀거리', '놀거리'],
  ['food', '먹거리', '맛집'],
  ['cafe', '카페', '카페'],
]
const courseColors = { activity: '#245342', food: '#a45124', cafe: '#6350a0' }
const maglevGuideUrl = 'https://airinfo.airport.kr/ap_ko/985/subview.do'
const completeStations = new Set([...stations.values()].filter((station) =>
  courseCategories.every(([key]) => courseCandidates(station, key).length)))
const drawNearbyMeters = 800
const nearbyStations = new Set([...completeStations].filter((station) =>
  courseCategories.every(([key]) => hasNearbyCandidate(station, key))))

function svg(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  return node
}

const railLayer = svg('g')
const stationLayer = svg('g')
map.append(railLayer, stationLayer)

for (const line of lines.values()) {
  const label = document.createElement('label')
  label.className = 'line-option'
  label.style.setProperty('--line', line.color)
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = true
  input.addEventListener('change', () => {
    if (input.checked) enabled.add(line.id)
    else enabled.delete(line.id)
    refreshFilters()
    saveDrawPreferences()
  })
  const swatch = document.createElement('span')
  swatch.className = 'swatch'
  swatch.setAttribute('aria-hidden', 'true')
  label.append(input, swatch, line.name)
  const lineStations = [...stations.values()].filter((station) => station.lines.includes(line.id))
  const completeCount = lineStations.filter((station) => completeStations.has(station)).length
  const nearbyCount = lineStations.filter((station) => nearbyStations.has(station)).length
  const coverage = document.createElement('span')
  coverage.id = 'line-coverage-' + line.id
  coverage.className = 'line-coverage'
  lineCoverage.push({ label, coverage, total: lineStations.length, completeCount, nearbyCount })
  input.setAttribute('aria-describedby', coverage.id)
  input.setAttribute('aria-label', line.name)
  label.append(coverage)
  byId('lines').append(label)
  filterInputs.set(line.id, input)

  const path = svg('path', { class: 'rail', stroke: line.color, 'data-line': line.id })
  railLayer.append(path)
  railPaths.set(line.id, path)
}

for (const station of stations.values()) {
  const marker = svg('g', { class: 'station', 'data-station': station.id, role: 'button',
    'aria-label': [station.name, ...station.lines.map((id) => lines.get(id).name)].join(' ') })
  const title = svg('title')
  title.textContent = station.name
  const circle = svg('circle')
  const label = svg('text', { x: 7, y: 4, 'font-size': 11, 'aria-hidden': 'true' })
  label.textContent = station.name
  marker.append(title, circle, label)
  function openStationCourse() {
    if (station === selected) {
      focusSection(byId('station-name'))
      return
    }
    selectStation(station)
    byId('station-name').focus({ preventScroll: true })
  }
  marker.addEventListener('click', () => {
    if (!moved) openStationCourse()
  })
  marker.addEventListener('focus', () => { keyboardStation = station })
  marker.addEventListener('keydown', (event) => {
    if (Object.hasOwn(arrowOffsets, event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      const [dx, dy] = arrowOffsets[event.key]
      const [x, y] = screenPoint(station)
      let nearest = null
      let best = Infinity
      for (const candidate of visible) {
        const point = screenPoint(candidate)
        if (!isMapPointVisible(point)) continue
        const offsetX = point[0] - x
        const offsetY = point[1] - y
        if (offsetX * dx + offsetY * dy <= 0) continue
        const score = Math.hypot(offsetX, offsetY) + Math.abs(offsetX * dy - offsetY * dx)
        if (score >= best) continue
        nearest = candidate
        best = score
      }
      if (nearest) {
        keyboardStation = nearest
        drawMap()
        markers.get(nearest.id).marker.focus({ preventScroll: true })
      }
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openStationCourse()
  })
  stationLayer.append(marker)
  markers.set(station.id, { marker, circle, label })
}

function isInCentralSeoul(station) {
  return station.lat >= 37.47 && station.lat <= 37.63 && station.lon >= 126.86 && station.lon <= 127.14
}

function stationBounds(stationList) {
  const xs = stationList.map((station) => station.x)
  const ys = stationList.map((station) => station.y)
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

function scaleToFit({ left, right, top, bottom }) {
  const padding = Math.min(controls.width < 450 ? 36 : 64, controls.width / 5, controls.height / 5)
  return Math.min(
    Math.max(1, controls.width - padding * 2) / Math.max(1, right - left),
    Math.max(1, controls.height - padding * 2) / Math.max(1, bottom - top),
    5,
  )
}

function fitNetwork(stationList = visible) {
  const bounds = stationList.length ? stationBounds(stationList) : networkBounds
  const { left, right, top, bottom } = bounds
  fitScale = scaleToFit(bounds)
  controls.scale = fitScale
  controls.x = (left + right) / 2
  controls.y = (top + bottom) / 2
  fitted = true
}

function screenPoint(station) {
  return [
    Math.round((station.x - controls.x) * controls.scale + controls.width / 2),
    Math.round((station.y - controls.y) * controls.scale + controls.height / 2),
  ]
}

function isMapPointVisible([x, y]) {
  return x >= -4 && x <= controls.width + 4 && y >= -4 && y <= controls.height + 4
}

function minimumMapScale() {
  return scaleToFit(networkBounds) / 1.12
}

function limitMapCenter(center, min, max, viewportSize) {
  const halfView = viewportSize / (2 * controls.scale)
  const margin = (max - min) * .12
  const inset = Math.min(halfView - margin, (max - min) / 2)
  return Math.max(min + inset, Math.min(max - inset, center))
}

function drawMap() {
  if (!controls.width || !controls.height) return
  controls.scale = Math.max(minimumMapScale(), controls.scale)
  const { left, right, top, bottom } = networkBounds
  controls.x = limitMapCenter(controls.x, left, right, controls.width)
  controls.y = limitMapCenter(controls.y, top, bottom, controls.height)
  renderBasemap(controls)
  const points = new Map(visible.map((station) => [station.id, screenPoint(station)]))
  for (const line of lines.values()) {
    const path = railPaths.get(line.id)
    if (!lineIsVisible(line.id)) continue
    path.setAttribute('d', line.edges.map(([a, b]) => 'M' + points.get(a).join(',') + 'L' + points.get(b).join(',')).join(' '))
  }

  const occupied = []
  const priority = [...visible].sort((a, b) => Number(b === selected) - Number(a === selected)
    || b.lines.length - a.lines.length)
  const keyboardPoint = points.get(keyboardStation?.id)
  const tabStation = keyboardPoint && isMapPointVisible(keyboardPoint)
    ? keyboardStation
    : priority.find((station) => isMapPointVisible(points.get(station.id)))
  for (const station of priority) {
    const { marker, circle, label } = markers.get(station.id)
    const [x, y] = points.get(station.id)
    const activeLines = station.lines.filter(lineIsVisible)
    const isSelected = station === selected
    const onScreen = isMapPointVisible([x, y])
    marker.setAttribute('transform', `translate(${x} ${y})`)
    marker.classList.toggle('selected', isSelected)
    marker.classList.toggle('transfer', activeLines.length > 1)
    marker.style.setProperty('--station', lines.get(activeLines[0]).color)
    marker.setAttribute('tabindex', station === tabStation ? '0' : '-1')
    const radius = activeLines.length > 1 ? 3.7 : 2.25
    circle.setAttribute('r', isSelected ? 7 : radius)

    const showNames = controls.scale >= fitScale * 2 || visible.length < 85
    const width = station.name.length * 11 + 12
    const box = [x + 4, y - 8, x + width, y + 8]
    const overlaps = occupied.some(([left, top, right, bottom]) =>
      box[0] < right && box[2] > left && box[1] < bottom && box[3] > top)
    const showLabel = onScreen && (isSelected || ((showNames || activeLines.length >= 3)
      && !overlaps && x + width < controls.width - 6 && y > 62 && y < controls.height - 54))
    label.style.display = showLabel ? '' : 'none'
    if (showLabel) occupied.push(box)
  }
  if (selected) {
    const marker = markers.get(selected.id).marker
    if (stationLayer.lastElementChild !== marker && document.activeElement !== marker) stationLayer.append(marker)
  }
}

function hasEnabledLine(station) {
  return station.lines.some((id) => enabled.has(id))
}

function drawExclusionReason(station) {
  if (!hasEnabledLine(station)) return '노선 꺼짐'
  return byId('nearby-course').checked ? '800m 후보 조건' : '장소 후보 조건'
}

function previewFor(station) {
  return station && !hasEnabledLine(station) ? station.lines[0] : null
}

function refreshFilters() {
  previewLine = previewFor(selected)
  for (const [id, input] of filterInputs) {
    input.checked = enabled.has(id)
    const rail = railPaths.get(id)
    rail.style.display = lineIsVisible(id) ? '' : 'none'
    rail.classList.toggle('preview-rail', id === previewLine)
  }
  visible = [...stations.values()].filter((station) => {
    const show = station.lines.some(lineIsVisible)
    markers.get(station.id).marker.style.display = show ? '' : 'none'
    return show
  })
  byId('count').textContent = `${enabled.size} / ${lines.size}`
  const mapLineCount = enabled.size + Number(previewLine !== null && !enabled.has(previewLine))
  let mapCount = `${mapLineCount}개 노선 · ${visible.length}개 역`
  if (previewLine !== null) {
    const previewStationCount = visible.filter((station) => !hasEnabledLine(station)).length
    mapCount += ` · 코스 미리보기 역 ${previewStationCount}곳 포함 (점선, 뽑기 제외)`
  }
  const mapCountNotice = byId('map-count')
  if (mapCountNotice.textContent !== mapCount) mapCountNotice.textContent = mapCount
  refreshDrawPool()
  byId('empty').hidden = Boolean(visible.length)
  for (const id of ['fit', 'zoom-in', 'zoom-out']) byId(id).disabled = !visible.length
  if (fitted || !selected) fitNetwork()
  drawMap()
  if (!stationSearchResults.hidden) renderStationMatches()
}

function eligibleStations(pool = visible.filter(hasEnabledLine)) {
  if (byId('nearby-course').checked) return pool.filter((station) => nearbyStations.has(station))
  if (!byId('complete-course').checked) return pool
  return pool.filter((station) => completeStations.has(station))
}

function refreshDrawPool() {
  const enabledStations = visible.filter(hasEnabledLine)
  const pool = eligibleStations(enabledStations)
  const nearbyOnly = byId('nearby-course').checked
  const placeConditionId = nearbyOnly ? 'nearby-course' : 'complete-course'
  const hasPlaceCondition = byId(placeConditionId).checked
  const activeCondition = byId('active-draw-condition')
  activeCondition.hidden = !hasPlaceCondition
  activeCondition.textContent = nearbyOnly ? '800m 이내 후보' : '세 분류 후보 있음'
  byId('lines').classList.toggle('complete-only', hasPlaceCondition)
  const coverageLabel = nearbyOnly
    ? '세 분류 모두 직선 800m 이내 후보가 있는 역'
    : '놀거리·먹거리·카페가 모두 있는 역'
  const coverageKey = byId('line-coverage-key')
  const coverageText = coverageLabel + ' / 전체 역'
  if (coverageKey.textContent !== coverageText) coverageKey.textContent = coverageText
  for (const { label, coverage, total, completeCount, nearbyCount } of lineCoverage) {
    const matching = nearbyOnly ? nearbyCount : completeCount
    const text = `${matching}/${total}`
    const description = `전체 ${total}개 역 중 ${coverageLabel} ${matching}곳`
    if (coverage.textContent !== text) coverage.textContent = text
    if (coverage.getAttribute('aria-label') !== description) coverage.setAttribute('aria-label', description)
    label.classList.toggle('line-without-complete-course', matching === 0)
  }
  const count = pool.length
  const selectedLines = [...lines.values()].filter((line) => enabled.has(line.id))
  byId('scope-summary').textContent = enabled.size === lines.size ? '전체 노선' : `선택한 노선 ${enabled.size}개`
  byId('scope-count').textContent = `후보 역 ${count}곳`
  byId('machine-count').textContent = `${count} STATIONS`
  byId('topbar-caption').textContent = `${enabled.size}개 노선 · ${count}개 역`
  const tags = byId('scope-tags')
  tags.replaceChildren(...selectedLines.slice(0, 4).map((line) => {
    const item = document.createElement('li')
    item.textContent = line.name
    item.style.setProperty('--line', line.color)
    return item
  }))
  if (selectedLines.length > 4) {
    const more = document.createElement('li')
    more.textContent = `+${selectedLines.length - 4}`
    tags.append(more)
  }
  const preview = lines.get(previewFor(selected))
  const previewNotice = byId('station-line-preview')
  const excludedByPlaces = selected && !preview && !pool.includes(selected)
  const missingCategories = excludedByPlaces
    ? courseCategories.filter(([key]) => nearbyOnly
      ? !hasNearbyCandidate(selected, key)
      : !courseCandidates(selected, key).length).map(([, label]) => label)
    : []
  previewNotice.hidden = !preview && !excludedByPlaces
  byId('station-line-preview-message').textContent = preview
    ? `${preview.name}은 지도에 미리 표시돼요. 뽑기에 넣으려면 노선 선택에서 켜 주세요.`
    : excludedByPlaces ? `${nearbyOnly ? '직선 800m 이내' : '기본'} 후보가 없는 항목은 ${missingCategories.join(', ')}예요. 세 가지 장소 후보가 모두 있는 역만 뽑고 있어요.` : ''
  const openPreviewSettings = byId('open-preview-line')
  openPreviewSettings.textContent = preview ? '노선 설정으로 이동' : '장소 후보 조건으로 이동'
  let message = '노선을 켜면 역을 뽑을 수 있어요.'
  if (count) message = `${count}개 역 중 1곳 · 역마다 1/${count}`
  else if (enabled.size) message = '조건에 맞는 역이 없어요. 장소 후보 조건을 끄거나 다른 노선을 켜보세요.'
  if (enabled.size && hasPlaceCondition) {
    const lineStationCount = enabledStations.length
    message = count
      ? `${count}개 역 중 1곳 · 선택한 노선의 전체 역 ${lineStationCount}곳 · 역마다 1/${count}`
      : `${message} 선택한 노선의 ${lineStationCount}개 역 중 장소 조건 충족 0곳`
    if (count && count < lineStationCount) message += ` · 장소 조건으로 ${lineStationCount - count}곳 제외`
  }
  if (enabled.size > 1 && pool.some((station) => station.lines.filter((id) => enabled.has(id)).length > 1)) {
    message += ' · 환승역은 한 번만 포함'
  }
  const drawPoolNotice = byId('draw-pool')
  if (drawPoolNotice.textContent !== message) drawPoolNotice.textContent = message
  byId('fit-seoul').disabled = !visible.some(isInCentralSeoul)
  byId('fit-selected').disabled = !enabledStations.length
  byId('map-hint').hidden = enabledStations.length > count
  byId('map-filter-hint').hidden = enabledStations.length === count
  const eligibleSet = new Set(pool)
  for (const station of visible) {
    const marker = markers.get(station.id).marker
    const eligible = eligibleSet.has(station)
    const lineEnabled = hasEnabledLine(station)
    marker.classList.toggle('excluded-by-place', hasPlaceCondition && !eligible && lineEnabled)
    if (eligible) marker.removeAttribute('aria-description')
    else {
      const description = `뽑기 후보 아님 (${drawExclusionReason(station)})` + (lineEnabled ? '' : ' · 점선 미리보기')
      if (marker.getAttribute('aria-description') !== description) marker.setAttribute('aria-description', description)
    }
  }
  const onlyCurrent = count === 1 && pool[0] === selected
  const otherCount = count - Number(pool.includes(selected))
  const courseCount = byId('course-draw-count')
  courseCount.hidden = !otherCount
  courseCount.textContent = otherCount ? `다른 후보 역 ${otherCount}곳 · 역마다 1/${otherCount}` : ''
  const canRelaxPlaceCondition = hasPlaceCondition && enabledStations.some((station) =>
    station !== selected)
  const courseUnavailable = byId('course-draw-unavailable')
  courseUnavailable.hidden = Boolean(count) && !onlyCurrent
  byId('course-draw-message').textContent = onlyCurrent
    ? '현재 보고 있는 역만 후보에 있어요. ' + (canRelaxPlaceCondition
      ? '장소 후보 조건을 끄면 다른 역을 뽑을 수 있어요.'
      : '노선을 더 켜면 다른 역을 뽑을 수 있어요.')
    : count ? '' : message
  byId('clear-place-condition').hidden = Boolean(count) || !enabled.size || !hasPlaceCondition
  byId('draw').disabled = drawing || !count
  byId('draw-from-course').disabled = drawing || !count || onlyCurrent
  byId('open-draw-filters').dataset.target = enabled.size && (!count || (onlyCurrent && canRelaxPlaceCondition))
    ? placeConditionId
    : 'line-filter-title'
}

const drawPreferencesKey = 'subway-date:draw-preferences'

function restoreDrawPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(drawPreferencesKey))
    if (!Array.isArray(preferences?.lines)) return
    const knownLines = preferences.lines.filter((id) => lines.has(id))
    if (knownLines.length || !preferences.lines.length) {
      enabled.clear()
      for (const id of knownLines) enabled.add(id)
    }
    byId('complete-course').checked = preferences.completeCourse === true
    byId('nearby-course').checked = preferences.nearbyCourse === true
  } catch {
    // Use the default filters if browser storage is unavailable.
  }
}

function saveDrawPreferences() {
  try {
    localStorage.setItem(drawPreferencesKey, JSON.stringify({
      lines: [...enabled],
      completeCourse: byId('complete-course').checked,
      nearbyCourse: byId('nearby-course').checked,
    }))
  } catch {
    // The current filters still work without storage.
  }
}

function setAll(show) {
  enabled.clear()
  if (show) for (const id of lines.keys()) enabled.add(id)
  refreshFilters()
  saveDrawPreferences()
}

function courseCandidates(station, category) {
  const curated = places[station.id]?.[category]
  if (curated) return curated
  if (category !== 'activity') return shops[station.id]?.[category] ?? []
  return [...(parks[station.id] ?? []), ...(markets[station.id] ?? [])]
    .sort((a, b) => a[3] - b[3])
}

function hasNearbyCandidate(station, category) {
  return courseCandidates(station, category).some(isNearbyCandidate)
}

function isNearbyCandidate([, , , meters]) {
  return Number.isFinite(meters) && meters <= drawNearbyMeters
}

const draftKey = 'subway-date:draft'
const editedCoursesKey = 'subway-date:edited-courses'

function editedCourseIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(editedCoursesKey))
    if (Array.isArray(ids)) return [...new Set(ids.filter((id) => stations.has(id)))]
  } catch {
    // The list can remain empty when browser storage is unavailable.
  }
  return []
}

function savedPlaceNames(params) {
  const order = courseOrders.find((keys) => keys.join(',') === params.get('order')) ?? courseOrders[0]
  return order.map((key) => {
    const value = params.get(key)
    return readCustomPlace(value)?.[0] ?? readPlaceIdentity(value, 160, 250)?.[0]
  }).filter(Boolean)
}

function renderSavedCourses() {
  const list = byId('saved-course-list')
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.stationId : null
  const items = editedCourseIds().flatMap((id) => {
    const draft = readDraft(id)
    if (!draft) return []
    const station = stations.get(id)
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.stationId = id
    if (!viewingSharedCourse && station === selected) button.setAttribute('aria-current', 'true')
    const selectedPlaces = savedPlaceNames(new URLSearchParams(draft.course))
    button.textContent = `${stationMapQuery(station)} · 선택한 장소 ${selectedPlaces.length}곳`
    if (selectedPlaces.length) {
      const preview = document.createElement('span')
      preview.className = 'saved-course-preview'
      preview.textContent = selectedPlaces.join(' → ')
      button.append(preview)
    }
    button.addEventListener('click', () => {
      selectStation(station, true)
    })
    item.append(button)
    return item
  })
  byId('saved-courses').hidden = !items.length
  list.replaceChildren(...items)
  if (focusedId) {
    const restored = items.map((item) => item.firstElementChild).find((button) => button.dataset.stationId === focusedId)
    const fallback = items.length ? byId('saved-courses').querySelector('summary') : byId('station-query')
    const focusTarget = restored ?? fallback
    focusTarget.focus({ preventScroll: true })
  }
}

function readDraft(stationId = null) {
  try {
    if (stationId) {
      const saved = localStorage.getItem(draftKey + ':' + stationId)
      if (saved !== null) return { station: stationId, course: saved }
    }
    const draft = JSON.parse(localStorage.getItem(draftKey))
    if (draft && (!stationId || stationId === draft.station) &&
        stations.has(draft.station) && typeof draft.course === 'string') return draft
  } catch {
    // The app still works when browser storage is unavailable.
  }
  return null
}

window.addEventListener('storage', (event) => {
  if (event.key === null || event.key === editedCoursesKey || event.key === draftKey || event.key.startsWith(draftKey + ':')) {
    renderSavedCourses()
    if (drawResult && reveal.open && reveal.classList.contains('landed')) refreshDrawCourseNotice()
    if (viewingSharedCourse) refreshSharedSaveActions()
    else if (selected) {
      byId('updated-course-actions').hidden = (readDraft(selected.id)?.course ?? null) === openedDraft
    }
  }
})

const courseOrders = courseCategories.flatMap(([first]) => {
  const [second, third] = courseCategories.filter(([key]) => key !== first)
  return [[first, second[0], third[0]], [first, third[0], second[0]]]
})
const courseOrder = byId('course-order')
const courseRadius = byId('course-radius')
const categoryLabels = new Map(courseCategories.map(([key, label]) => [key, label]))
for (const order of courseOrders) {
  const option = document.createElement('option')
  option.value = order.join(',')
  option.textContent = order.map((key) => categoryLabels.get(key)).join(' → ')
  courseOrder.append(option)
}

function visitOrder() {
  return courseOrder.value.split(',')
}

const customPlaces = new Map()
const preferredPlaces = new Map()
const unresolvedSharedPlaces = new Map()
const courseQueryKeys = ['order', 'radius', ...courseCategories.flatMap(([key]) => [key, `custom-${key}`, `preferred-${key}`])]

function courseParams({ includePreferences = true, preserveUnresolved = viewingSharedCourse } = {}) {
  const params = new URLSearchParams()
  if (courseOrder.selectedIndex > 0) params.set('order', courseOrder.value)
  if (courseRadius.value) params.set('radius', courseRadius.value)
  for (const [key] of courseCategories) {
    const custom = customPlaces.get(key)
    const selection = courseSelection.get(key)?.key
    if (custom && includePreferences) params.set('custom-' + key, custom)
    const preferred = preferredPlaces.get(key)
    if (preserveUnresolved && omittedStops.has(key) && unresolvedSharedPlaces.has(key)) {
      params.set('preferred-' + key, unresolvedSharedPlaces.get(key))
    } else if (includePreferences && preferred && preferred !== selection) {
      params.set('preferred-' + key, preferred)
    }
    if (omittedStops.has(key)) params.set(key, 'omit')
    else if (preserveUnresolved && unresolvedSharedPlaces.has(key)) params.set(key, unresolvedSharedPlaces.get(key))
    else if (selection) params.set(key, selection)
  }
  return params
}

let viewingSharedCourse = false
let openedDraft = null

function saveDraft(station, edited = true, saveShared = false) {
  const course = courseParams({ preserveUnresolved: !saveShared && viewingSharedCourse })
  const url = new URL(location.href)
  if (url.searchParams.has('station')) {
    for (const key of courseQueryKeys) url.searchParams.delete(key)
    if (viewingSharedCourse) {
      for (const [key, value] of course) url.searchParams.set(key, value)
    } else {
      url.searchParams.delete('station')
    }
    if (url.href !== location.href) history.replaceState(history.state, '', url.href)
  }
  if (viewingSharedCourse && !saveShared) return false
  try {
    const serialized = course.toString()
    localStorage.setItem(draftKey + ':' + station.id, serialized)
    openedDraft = serialized
    localStorage.setItem(draftKey, JSON.stringify({ station: station.id, course: serialized }))
    if (edited) {
      const ids = [station.id, ...editedCourseIds().filter((id) => id !== station.id)]
      localStorage.setItem(editedCoursesKey, JSON.stringify(ids))
    }
  } catch {
    // The active course remains available for this visit.
    return false
  }
  byId('updated-course-actions').hidden = true
  if (edited && !saveShared) renderSavedCourses()
  return true
}

function selectStation(station, centerOnMap = false, scroll = true, sharedCourse = null, useNearbyDefaults = false) {
  if (drawing) return
  if (selected && selected !== station) markers.get(selected.id).marker.removeAttribute('aria-current')
  selected = station
  markers.get(station.id).marker.setAttribute('aria-current', 'true')
  byId('course-walk').open = false
  viewingSharedCourse = Boolean(sharedCourse)
  for (const button of byId('saved-course-list').querySelectorAll('button')) {
    if (!sharedCourse && button.dataset.stationId === station.id) button.setAttribute('aria-current', 'true')
    else button.removeAttribute('aria-current')
  }
  byId('invalid-course-link').hidden = true
  byId('course-tools').open = false
  byId('course-settings').open = false
  const draft = readDraft(station.id)
  openedDraft = draft?.course ?? null
  byId('updated-course-actions').hidden = true
  byId('shared-course-actions').hidden = !sharedCourse
  byId('center-station').hidden = false
  if (previewLine !== previewFor(station)) refreshFilters()
  else refreshDrawPool()
  clearShareFeedback()
  const heading = byId('station-name')
  heading.textContent = stationDisplayName(station)
  byId('center-station').setAttribute('aria-label', `코스 역 ${heading.textContent}을 노선도 가운데에 표시`)
  document.title = `${heading.textContent} · ${appTitle}`
  byId('station-lines').replaceChildren(...station.lines.map((id) => {
    const line = lines.get(id)
    const tag = document.createElement('span')
    tag.textContent = line.name
    tag.style.setProperty('--line', line.color)
    return tag
  }))
  const queryPrefix = stationMapQuery(station)
  byId('place-links').replaceChildren(naverLink('역 위치', queryPrefix), stationDirectionsLink(station))
  if (station.lines.includes('자기부상철도')) byId('place-links').append(maglevGuideLink())
  const defaultCourse = useNearbyDefaults ? nearbyCourseParams(station) : null
  const savedCourse = draft && (!defaultCourse || editedCourseIds().includes(station.id))
    ? new URLSearchParams(draft.course)
    : null
  renderCourse(station, queryPrefix, sharedCourse ?? savedCourse ?? defaultCourse)
  if (!sharedCourse) saveDraft(station, false)
  byId('result').hidden = false
  if (centerOnMap) {
    centerStation(station)
    if (scroll) heading.focus({ preventScroll: true })
  }
  if (scroll) byId('result').scrollIntoView({ block: 'start' })
  drawMap()
}

function centerStation(station) {
  controls.x = station.x
  controls.y = station.y
  controls.scale = Math.max(controls.scale, Math.min(9, fitScale * 3))
  fitted = false
}

function stationDisplayName(station) {
  return station.name.endsWith('역') ? station.name : station.name + '역'
}

function stationMapQuery(station) {
  return stationDisplayName(station) + ' ' + lines.get(station.lines[0]).name
}

function stationDirectionsLink(station) {
  return directionsLink('public', '대중교통 길찾기 (앱) ↗', {
    ...station, name: stationMapQuery(station),
  })
}

function directionsLink(mode, label, destination, start = null) {
  const params = new URLSearchParams({
    dlat: destination.lat,
    dlng: destination.lon,
    dname: destination.name,
    appname: location.origin + location.pathname,
  })
  if (start) {
    params.set('slat', start.lat)
    params.set('slng', start.lon)
    params.set('sname', start.name)
  }
  const link = document.createElement('a')
  link.textContent = label
  link.href = `nmap://route/${mode}?` + params
  return link
}

function naverSearchUrl(query) {
  return 'https://map.naver.com/p/search/' + encodeURIComponent(query.toWellFormed())
}

function externalMapLink(label, url) {
  const link = document.createElement('a')
  link.textContent = label + ' ↗'
  link.setAttribute('aria-label', label + ' 네이버 지도에서 보기')
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  return link
}

function naverLink(label, query) {
  return externalMapLink(label, naverSearchUrl(query))
}

function maglevGuideLink() {
  const link = document.createElement('a')
  link.textContent = '자기부상열차 운행 안내 ↗'
  link.href = maglevGuideUrl
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  return link
}

function placeKey([name, address]) {
  return JSON.stringify([name, address])
}

function candidateMapQuery([name, address, , , , , mapSearch], stationQuery) {
  return mapSearch ?? name + ' ' + (address || stationQuery)
}

function straightDistance(meters, prefix = '직선') {
  const distance = meters < 10 ? '10m 미만' : `약 ${(Math.round(meters / 10) * 10).toLocaleString('ko-KR')}m`
  return prefix ? `${prefix} ${distance}` : distance
}

function outsideRadiusDistance(meters, radius) {
  if (Math.round(meters / 10) * 10 <= Number(radius)) return `직선 ${meters}m`
  return straightDistance(meters)
}

function readPlaceIdentity(value, nameLimit, addressLimit) {
  if (!value || value.length > 1500) return null
  try {
    const identity = JSON.parse(value)
    if (!Array.isArray(identity) || identity.length !== 2) return null
    const [name, address] = identity
    if (typeof name === 'string' && name.trim() && name.length <= nameLimit &&
        typeof address === 'string' && address.length <= addressLimit) {
      return [name.trim().toWellFormed(), address.trim().toWellFormed()]
    }
  } catch {
    // Invalid shared values fall back to the station candidates.
  }
  return null
}

function readCustomPlace(value) {
  if (!value?.startsWith('custom:') || value.length > 1000) return null
  const identity = readPlaceIdentity(value.slice(7), 80, 120)
  return identity ? [...identity, '직접 추가한 장소'] : null
}

function renderCourse(station, queryPrefix, sharedCourse) {
  courseSelection.clear()
  customPlaces.clear()
  preferredPlaces.clear()
  unresolvedSharedPlaces.clear()
  omittedStops.clear()
  const radius = sharedCourse?.get('radius')
  courseRadius.value = [...courseRadius.options].some((option) => option.value === radius) ? radius : ''
  const order = sharedCourse?.get('order')
  courseOrder.value = courseOrders.some((option) => option.join(',') === order)
    ? order
    : courseOrders[0].join(',')
  const candidateCounts = []
  let unmeasuredCount = 0
  let transitCandidateCount = 0
  let outsideRadiusCount = 0
  byId('course').replaceChildren(...courseCategories.map(([key, category, query]) => {
    const item = document.createElement('section')
    item.className = 'course-stop'
    item.dataset.category = key
    const title = document.createElement('h3')
    function changeRadius(value, showCandidates = false) {
      const previousRadius = Number(courseRadius.value)
      courseRadius.value = value
      courseRadius.dispatchEvent(new Event('change'))
      const card = byId('course').querySelector(`[data-category="${key}"]`)
      const picker = showCandidates ? card.querySelector('.candidate-picker') : null
      if (picker) {
        for (const option of picker.querySelectorAll('button[data-distance]')) {
          if (Number(option.dataset.distance) <= previousRadius) continue
          const added = document.createElement('span')
          added.className = 'candidate-source'
          added.textContent = '거리 확대 후 추가된 후보'
          option.append(added)
        }
        picker.open = true
        focusSection(picker.querySelector('summary'))
      } else {
        focusSection(card.querySelector('h3'))
      }
    }
    function radiusIncluding(meters) {
      return [...courseRadius.options].find((option) => option.value && Number(option.value) >= meters)
    }
    function radiusLabel(option) {
      return option.textContent.replace(/^직선 | 이내$/g, '')
    }
    title.textContent = category
    title.tabIndex = -1
    const content = document.createElement('div')
    content.setAttribute('aria-live', 'polite')
    const actions = document.createElement('div')
    actions.className = 'course-actions'
    const sharedValue = sharedCourse?.get(key)
    const sharedCustom = readCustomPlace(sharedValue)
    const sharedPlace = sharedCustom ? 'custom:' + placeKey(sharedCustom) : sharedValue
    const preferredValue = sharedCourse?.get('preferred-' + key) ?? sharedPlace
    const preferredCustom = readCustomPlace(preferredValue)
    const preferred = preferredCustom ? 'custom:' + placeKey(preferredCustom) : preferredValue
    const custom = readCustomPlace(sharedCourse?.get('custom-' + key)) ?? sharedCustom
    if (custom) customPlaces.set(key, 'custom:' + placeKey(custom))
    const allCandidates = courseCandidates(station, key)
    const candidateToken = (candidate) => (candidate === custom ? 'custom:' : '') + placeKey(candidate)
    if ([...allCandidates, ...(custom ? [custom] : [])].some((candidate) => candidateToken(candidate) === preferred)) {
      preferredPlaces.set(key, preferred)
    }
    const originalPlace = sharedPlace === 'omit' ? preferred : sharedPlace
    const sharedPlaceMissing = viewingSharedCourse && originalPlace
      && ![...allCandidates, ...(custom ? [custom] : [])].some((candidate) => candidateToken(candidate) === originalPlace)
    if (sharedPlaceMissing) unresolvedSharedPlaces.set(key, originalPlace)
    const defaults = courseRadius.value ? allCandidates.filter(([, , , meters]) =>
      meters === undefined || meters <= Number(courseRadius.value)) : allCandidates
    const candidates = custom ? [...defaults, custom] : defaults
    outsideRadiusCount += allCandidates.length - defaults.length
    const preferredOutsideRadius = allCandidates.find((candidate) =>
      candidateToken(candidate) === preferred && !defaults.includes(candidate))
    const preferenceNotice = document.createElement('p')
    preferenceNotice.className = 'place-source'
    if (preferredOutsideRadius) {
      const [name, , , meters] = preferredOutsideRadius
      preferenceNotice.textContent = `이전에 고른 장소는 거리 조건 밖에 있어요. ${name}까지 ${outsideRadiusDistance(meters, radius)}예요. 조건을 넓히면 다시 선택돼요.`
    }
    candidateCounts.push({ label: category, count: candidates.length })
    transitCandidateCount += candidates.filter((candidate) => candidate[8] === 'transit').length
    unmeasuredCount += candidates.filter(([, , , meters, , , , , access]) =>
      meters === undefined && access !== 'transit').length
    const customEntry = document.createElement('details')
    customEntry.className = 'custom-place'
    const addLabel = document.createElement('summary')
    addLabel.textContent = custom ? '직접 추가한 장소 수정' : '직접 추가'
    addLabel.setAttribute('aria-label', category + ' ' + addLabel.textContent)
    const form = document.createElement('form')
    const placeName = document.createElement('input')
    placeName.placeholder = '장소 이름'
    placeName.setAttribute('aria-label', category + ' 장소 이름')
    placeName.maxLength = 80
    placeName.required = true
    const address = document.createElement('input')
    address.placeholder = '주소 또는 동네 (선택)'
    address.setAttribute('aria-label', category + ' 장소 주소')
    const addressHint = document.createElement('small')
    addressHint.id = 'place-address-hint-' + key
    addressHint.textContent = '주소를 비우면 네이버 지도에서 장소 이름과 역 이름으로 검색해요.'
    address.setAttribute('aria-describedby', addressHint.id)
    address.maxLength = 120
    form.addEventListener('input', () => placeName.setCustomValidity(''))
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = '코스에 넣기'
    function applyCustomChange(params) {
      renderCourse(station, queryPrefix, params)
      clearShareFeedback()
      saveDraft(station)
      byId('course').querySelector(`[data-category="${key}"] .custom-place summary`).focus()
    }
    form.append(placeName, address, addressHint, submit)
    if (custom) {
      placeName.value = custom[0]
      address.value = custom[1]
      submit.textContent = '수정해서 코스에 넣기'
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '직접 추가한 장소 삭제'
      remove.addEventListener('click', () => {
        const params = courseParams()
        params.delete('custom-' + key)
        if (params.get('preferred-' + key)?.startsWith('custom:')) params.delete('preferred-' + key)
        if (params.get(key)?.startsWith('custom:')) params.delete(key)
        applyCustomChange(params)
      })
      form.append(remove)
    }
    customEntry.append(addLabel, form)
    customEntry.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !customEntry.open || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      customEntry.open = false
      addLabel.focus()
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const name = placeName.value.trim()
      if (!name) {
        placeName.setCustomValidity('장소 이름을 입력해 주세요.')
        placeName.reportValidity()
        return
      }
      const details = [name, address.value.trim()]
      const identity = placeKey(details)
      const existing = allCandidates.find((candidate) => placeKey(candidate) === identity)
      if (existing) {
        const message = defaults.includes(existing)
          ? '같은 이름과 주소의 후보가 이미 있어요.'
          : `같은 장소가 거리 조건 밖에 있어요 (역에서 ${outsideRadiusDistance(existing[3], radius)}). 조건을 넓히면 선택할 수 있어요.`
        placeName.setCustomValidity(message)
        placeName.reportValidity()
        return
      }
      const params = courseParams()
      const token = 'custom:' + identity
      params.set('custom-' + key, token)
      params.set(key, token)
      params.delete('preferred-' + key)
      applyCustomChange(params)
    })
    let restorePlace = () => {}
    let closeCandidates = () => {}
    const sharedReplacement = document.createElement('span')
    if (!candidates.length) {
      const filteredOut = allCandidates.length > 0 && Boolean(courseRadius.value)
      const nearest = filteredOut ? Math.min(...allCandidates.map(([, , , meters]) => meters)) : null
      const emptyMessage = document.createElement('p')
      emptyMessage.textContent = filteredOut
        ? `선택한 거리 안에 후보가 없어요. 가장 가까운 후보는 역에서 ${outsideRadiusDistance(nearest, radius)}예요. 거리 조건을 해제하면 ${allCandidates.length}곳을 볼 수 있어요.`
        : '등록된 후보가 없어요. 네이버 지도에서 찾거나 장소를 직접 추가할 수 있어요.'
      content.append(emptyMessage)
      if (filteredOut) {
        const wider = radiusIncluding(nearest)
        const choices = [['', '코스 거리 조건 해제', allCandidates.length]]
        if (wider) {
          const widerCount = allCandidates.filter(([, , , meters]) => meters <= Number(wider.value)).length
          choices.unshift([wider.value, `코스 거리 ${radiusLabel(wider)}로 넓히기`, widerCount])
        }
        for (const [value, label, count] of choices) {
          const changeDistance = document.createElement('button')
          changeDistance.type = 'button'
          changeDistance.textContent = `${label} · ${category} 후보 ${count}곳`
          changeDistance.addEventListener('click', () => changeRadius(value))
          actions.append(changeDistance)
        }
      }
      actions.append(naverLink(category + ' 검색', queryPrefix + ' ' + query))
    } else {
      const name = document.createElement('strong')
      const detail = document.createElement('p')
      const addressLine = document.createElement('p')
      addressLine.className = 'place-address'
      const source = document.createElement('p')
      source.className = 'place-source'
      const link = naverLink('네이버 지도', '')
      const guide = document.createElement('a')
      guide.textContent = '공식 방문 안내 ↗'
      guide.target = '_blank'
      guide.rel = 'noopener noreferrer'
      const isCurated = Boolean(places[station.id]?.[key])
      let index = Math.max(0, candidates.findIndex((candidate) => candidateToken(candidate) === preferred))
      function candidateSource(candidate) {
        if (candidate === custom) return '직접 추가'
        if (isCurated) return '직접 선정한 추천'
        if (key !== 'activity') return `소상공인시장진흥공단 상가정보 · ${shopSourceMonth}`
        return parks[station.id]?.includes(candidate) ? '전국도시공원정보' : '전국전통시장정보'
      }
      function showPlace() {
        const [place, address, description, meters, lat, lon, mapSearch, guideUrl, access] = candidates[index]
        const token = candidateToken(candidates[index])
        if (!preferredPlaces.has(key)) preferredPlaces.set(key, token)
        courseSelection.set(key, {
          key: token, name: place, category, address, description, meters, lat, lon, mapSearch, guideUrl, access,
          url: naverSearchUrl(candidateMapQuery(candidates[index], queryPrefix)),
        })
        clearShareFeedback()
        name.textContent = place
        if (sharedPlaceMissing) sharedReplacement.textContent = ` 현재 후보는 ‘${place}’입니다.`
        link.textContent = mapSearch ? '출발점 지도 ↗' : '네이버 지도 ↗'
        link.setAttribute('aria-label', place + (mapSearch ? ' 출발점' : '') + ' 네이버 지도에서 보기')
        const distance = meters === undefined ? '거리 미확인' : '역에서 ' + straightDistance(meters)
        detail.textContent = `${description} · ${access === 'transit' ? '대중교통 이동' : distance}`
        addressLine.textContent = address
        addressLine.hidden = !address
        const candidate = candidates[index]
        title.textContent = candidate === custom || isCurated ? category : category + ' · 가까운 후보'
        source.hidden = candidate === custom
        source.textContent = candidateSource(candidate)
        link.href = courseSelection.get(key).url
        guide.hidden = !guideUrl
        if (guideUrl) {
          guide.href = guideUrl
          guide.setAttribute('aria-label', place + ' 공식 방문 안내')
        } else {
          guide.removeAttribute('href')
          guide.removeAttribute('aria-label')
        }
      }
      content.append(name, detail, addressLine, source)
      const hiddenCandidates = allCandidates.length - defaults.length
      if (hiddenCandidates) {
        const filteredNote = document.createElement('p')
        filteredNote.className = 'place-source'
        filteredNote.textContent = `거리 조건 밖 ${category} 후보 ${hiddenCandidates}곳`
        content.append(filteredNote)
        if (!preferredOutsideRadius) {
          const nextDistance = Math.min(...allCandidates.filter((candidate) => !defaults.includes(candidate)).map((candidate) => candidate[3]))
          const wider = radiusIncluding(nextDistance)
          const showMore = document.createElement('button')
          showMore.type = 'button'
          const additionalCount = wider
            ? allCandidates.filter(([, , , meters]) => meters > Number(courseRadius.value) && meters <= Number(wider.value)).length
            : hiddenCandidates
          const label = wider ? `코스 거리 ${radiusLabel(wider)}로 넓히기` : '코스 거리 조건 해제'
          showMore.textContent = `${label} · ${category} 후보 ${additionalCount}곳 더 보기`
          showMore.addEventListener('click', () => changeRadius(wider?.value ?? '', true))
          actions.append(showMore)
        }
      }
      actions.append(link, guide)
      if (candidates.length > 1) {
        const picker = document.createElement('details')
        picker.className = 'candidate-picker'
        const summary = document.createElement('summary')
        summary.textContent = `장소 바꾸기 · ${candidates.length}곳`
        summary.setAttribute('aria-label', category + ' 후보 비교')
        const keyboardHint = document.createElement('p')
        keyboardHint.className = 'candidate-keyboard-hint'
        keyboardHint.id = `candidate-keyboard-hint-${key}`
        keyboardHint.textContent = '방향키로 이동하고 Enter로 선택할 수 있어요.'
        summary.setAttribute('aria-describedby', keyboardHint.id)
        const options = document.createElement('ul')
        const buttons = candidates.map((candidate, candidateIndex) => {
          const [label, address, description, meters, , , mapSearch, , access] = candidate
          const row = document.createElement('li')
          const option = document.createElement('button')
          option.type = 'button'
          if (Number.isFinite(meters)) option.dataset.distance = meters
          const name = document.createElement('strong')
          name.textContent = label
          const meta = document.createElement('span')
          const origin = document.createElement('span')
          origin.className = 'candidate-source'
          origin.textContent = candidateSource(candidate)
          const distance = access === 'transit' ? '대중교통 이동'
            : meters === undefined ? '거리 미확인' : straightDistance(meters)
          meta.textContent = [distance, address].filter(Boolean).join(' · ')
          option.append(name)
          if (candidate !== custom && isCurated) {
            const details = document.createElement('span')
            details.textContent = description
            option.append(details)
          }
          option.append(meta, origin)
          option.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const step = event.key === 'ArrowUp' ? -1 : 1
            buttons[(candidateIndex + step + buttons.length) % buttons.length].focus()
          })
          option.addEventListener('click', () => {
            const fromOverview = picker.dataset.fromOverview === 'true'
            closeCandidates()
            chooseCandidate(candidateIndex)
            const overviewButton = fromOverview && byId('course-overview').querySelector(`[data-change-category="${key}"]`)
            if (overviewButton) overviewButton.focus()
            else if (summary.isConnected) summary.focus()
          })
          const mapLink = naverLink(mapSearch ? '출발점 지도' : '지도', candidateMapQuery(candidate, queryPrefix))
          mapLink.setAttribute('aria-label', [label, mapSearch ? '출발점' : address, '네이버 지도에서 보기'].filter(Boolean).join(' · '))
          row.append(option, mapLink)
          options.append(row)
          return option
        })
        function chooseCandidate(candidateIndex) {
          const resolvingSharedPlace = unresolvedSharedPlaces.delete(key)
          preferenceNotice.remove()
          index = candidateIndex
          preferredPlaces.set(key, candidateToken(candidates[index]))
          showPlace()
          renderSharedCourseChanges()
          buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)))
          renderCourseMap(station)
          saveDraft(station)
          if (resolvingSharedPlace) {
            renderCourse(station, queryPrefix, courseParams())
            byId('course').querySelector(`[data-category="${key}"] h3`).focus()
          }
        }
        buttons[index].setAttribute('aria-pressed', 'true')
        summary.addEventListener('click', (event) => {
          if (event.detail !== 0 || picker.open) return
          event.preventDefault()
          picker.open = true
          buttons[index].focus()
        })
        closeCandidates = () => {
          picker.open = false
          delete picker.dataset.fromOverview
        }
        picker.addEventListener('toggle', () => {
          if (!picker.open) delete picker.dataset.fromOverview
        })
        picker.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape' || !picker.open || event.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          const overviewButton = picker.dataset.fromOverview === 'true'
            && byId('course-overview').querySelector(`[data-change-category="${key}"]`)
          closeCandidates()
          if (overviewButton) overviewButton.focus()
          else summary.focus()
        })
        picker.append(summary, keyboardHint, options)
        actions.append(picker)
      }
      restorePlace = showPlace
    }
    if (preferredOutsideRadius) {
      if (candidates.length) {
        const restore = document.createElement('button')
        restore.type = 'button'
        const wider = radiusIncluding(preferredOutsideRadius[3])
        restore.textContent = wider
          ? `코스 거리 ${radiusLabel(wider)}로 넓혀 이전 장소 선택`
          : '코스 거리 조건을 해제해 이전 장소 선택'
        restore.addEventListener('click', () => changeRadius(wider?.value ?? ''))
        preferenceNotice.append(' ', restore)
      }
      content.append(preferenceNotice)
    }
    if (sharedPlaceMissing) {
      const identity = readPlaceIdentity(originalPlace, 160, 250)
      const missingPlace = document.createElement('p')
      missingPlace.className = 'place-source'
      missingPlace.id = `shared-missing-place-${key}`
      title.setAttribute('aria-describedby', missingPlace.id)
      missingPlace.textContent = candidates.length
        ? '공유 링크의 장소가 현재 후보 목록에 없어 다른 후보를 표시했어요.'
        : '공유 링크의 장소가 현재 후보 목록에 없어요.'
      if (identity) {
        const [originalName, originalAddress] = identity
        missingPlace.textContent += ` 원래 장소 이름은 ‘${originalName}’입니다.`
        if (originalAddress) missingPlace.textContent += ` 주소는 ‘${originalAddress}’입니다.`
      }
      if (candidates.length) missingPlace.append(sharedReplacement)
      content.append(missingPlace)
      if (identity) {
        const [name, originalAddress] = identity
        const originalMapLink = naverLink('원래 장소 검색', name + ' ' + (originalAddress || queryPrefix))
        originalMapLink.setAttribute('aria-label', `원래 장소 검색 · ${name} 네이버 지도에서 보기`)
        actions.append(originalMapLink)
        if (!custom && name.length <= placeName.maxLength && originalAddress.length <= address.maxLength) {
          const restoreOriginal = document.createElement('button')
          restoreOriginal.type = 'button'
          restoreOriginal.textContent = '원래 장소 직접 추가'
          restoreOriginal.setAttribute('aria-describedby', missingPlace.id)
          restoreOriginal.addEventListener('click', () => {
            customEntry.open = true
            placeName.value = name
            address.value = originalAddress
            placeName.setCustomValidity('')
            placeName.focus()
          })
          actions.append(restoreOriginal)
        }
      }
    }

    actions.append(customEntry)
    const backToMap = document.createElement('button')
    backToMap.type = 'button'
    backToMap.className = 'back-to-course-map'
    backToMap.textContent = '코스 지도로 돌아가기'
    backToMap.hidden = true
    backToMap.addEventListener('click', () => {
      const mapButton = byId('course-location').querySelector(`button[data-map-stop="${key}"]`)
      focusSection(mapButton ?? byId('course-location-title'))
      backToMap.hidden = true
    })
    actions.append(backToMap)
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'course-toggle'
    function setOmitted(omitted) {
      content.hidden = omitted
      actions.hidden = omitted
      if (omitted) {
        closeCandidates()
        customEntry.open = false
        omittedStops.add(key)
        courseSelection.delete(key)
      } else {
        omittedStops.delete(key)
        restorePlace()
      }
      toggle.textContent = omitted ? '추가하기' : '빼기'
      toggle.setAttribute('aria-label', category + (omitted ? ' 추가하기' : ' 빼기'))
    }

    toggle.addEventListener('click', () => {
      setOmitted(!omittedStops.has(key))
      renderSharedCourseChanges()
      clearShareFeedback()
      renderCourseMap(station)
      saveDraft(station)
    })
    setOmitted(sharedCourse?.get(key) === 'omit')
    const header = document.createElement('div')
    header.className = 'course-stop-header'
    header.append(title, toggle)
    item.append(header, content, actions)
    return item
  }))
  const stats = byId('station-stats')
  renderSharedCourseChanges()
  const statsParts = [formatCandidateCounts(candidateCounts) || '장소 후보 없음']
  if (courseRadius.value) {
    statsParts.push(courseRadius.selectedOptions[0].textContent)
  }
  if (unmeasuredCount) statsParts.push(courseRadius.value
    ? `거리를 확인할 수 없는 후보 ${unmeasuredCount}곳은 계속 표시`
    : `거리를 확인할 수 없는 후보 ${unmeasuredCount}곳 포함`)
  if (transitCandidateCount) statsParts.push(courseRadius.value
    ? `대중교통 이동 후보 ${transitCandidateCount}곳은 거리 조건과 관계없이 표시`
    : `대중교통 이동 후보 ${transitCandidateCount}곳 포함`)
  if (outsideRadiusCount) statsParts.push(`거리 조건 밖 후보 ${outsideRadiusCount}곳 제외`)
  stats.textContent = statsParts.join(' · ')
  arrangeCourseStops()
  renderCourseMap(station)
}

function refreshSharedSaveActions() {
  if (!viewingSharedCourse) return
  const openLocal = byId('open-local-course')
  const saveShared = byId('save-shared-course')
  const moveFocus = openLocal === document.activeElement
  openLocal.hidden = !(editedCourseIds().includes(selected.id) && readDraft(selected.id))
  const hasChanges = !byId('shared-course-changes').hidden
  const courseLabel = hasChanges ? '현재 코스' : '받은 코스'
  saveShared.textContent = openLocal.hidden ? courseLabel + ' 저장' : courseLabel + '로 저장본 바꾸기'
  if (moveFocus && openLocal.hidden) saveShared.focus({ preventScroll: true })
}

function renderSharedCourseChanges() {
  const changedCategories = courseCategories.filter(([key]) =>
    viewingSharedCourse && unresolvedSharedPlaces.has(key) && !omittedStops.has(key))
  const sharedChanges = byId('shared-course-changes')
  const omittedNote = byId('share-omitted-note')
  omittedNote.hidden = ![...omittedStops].some((key) => customPlaces.has(key))
  const customNote = byId('share-custom-note')
  const customStops = [...courseSelection.values()].filter((stop) => stop.key.startsWith('custom:'))
  customNote.hidden = !customStops.length
  if (customStops.length) {
    customNote.textContent = customStops.some((stop) => stop.address)
      ? '직접 추가한 장소의 이름과 입력한 주소가 함께 공유돼요.'
      : '직접 추가한 장소의 이름이 함께 공유돼요.'
  }
  const descriptions = ['course-overview']
  if (changedCategories.length) descriptions.push('shared-course-changes')
  if (!omittedNote.hidden) descriptions.push(omittedNote.id)
  if (!customNote.hidden) descriptions.push(customNote.id)
  const localNote = byId('share-local-note')
  localNote.hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  byId('share-station').textContent = localNote.hidden ? '코스 링크 복사' : '이 기기용 코스 링크 복사'
  byId('share-device').hidden = typeof navigator.share !== 'function'
  for (const id of ['copy-course', 'share-station', 'share-device', 'share-course-primary']) {
    byId(id).setAttribute('aria-describedby', descriptions.join(' '))
  }
  if (!localNote.hidden) byId('share-station').setAttribute('aria-describedby', [...descriptions, localNote.id].join(' '))
  byId('share-replacement-note').hidden = !changedCategories.length
  const saveShared = byId('save-shared-course')
  saveShared.removeAttribute('aria-describedby')
  sharedChanges.hidden = !changedCategories.length
  sharedChanges.replaceChildren()
  if (changedCategories.length) {
    saveShared.setAttribute('aria-describedby', sharedChanges.id)
    sharedChanges.append('공유 링크의 장소를 확인해 주세요 · ')
    for (const [index, [key, category]] of changedCategories.entries()) {
      if (index) sharedChanges.append(', ')
      sharedChanges.append(courseJumpButton(key, category))
    }
  }
  refreshSharedSaveActions()
}

function arrangeCourseStops() {
  const course = byId('course')
  const stops = new Map([...course.children].map((item) => [item.dataset.category, item]))
  for (const key of visitOrder()) course.append(stops.get(key))
}

courseRadius.addEventListener('change', () => {
  if (!selected) return
  const params = courseParams()
  renderCourse(selected, stationMapQuery(selected), params)
  clearShareFeedback()
  saveDraft(selected)
})

courseOrder.addEventListener('change', () => {
  if (!selected) return
  arrangeCourseStops()
  renderCourseMap(selected)
  clearShareFeedback()
  saveDraft(selected)
})

function hasCoordinates(place) {
  return Number.isFinite(place?.lat) && Number.isFinite(place?.lon)
}

function distanceBetween(start, end) {
  const averageLat = (start.lat + end.lat) * Math.PI / 360
  return Math.hypot((end.lat - start.lat) * 111195,
    (end.lon - start.lon) * Math.cos(averageLat) * 111195)
}

function shortestCourseOrder(station) {
  const currentOrder = visitOrder()
  const activeKeys = currentOrder.filter((key) => !omittedStops.has(key))
  if (activeKeys.length < 2 || !activeKeys.every((key) => hasCoordinates(courseSelection.get(key)))) return null

  function length(order) {
    let total = 0
    let previous = station
    for (const key of order) {
      const stop = courseSelection.get(key)
      if (!stop) continue
      total += distanceBetween(previous, stop)
      previous = stop
    }
    return total
  }

  let best = null
  const current = length(currentOrder)
  let shortest = current
  for (const order of courseOrders) {
    if (order.some((key, index) => omittedStops.has(key) && currentOrder[index] !== key)) continue
    const total = length(order)
    if (total >= shortest - 1) continue
    best = order
    shortest = total
  }
  return best ? { order: best, savings: current - shortest } : null
}

const undoShortestOrder = byId('undo-shortest-order')
byId('shortest-order').addEventListener('click', () => {
  if (!selected) return
  const suggestion = shortestCourseOrder(selected)
  if (!suggestion) return
  const previousOrder = courseOrder.value
  courseOrder.value = suggestion.order.join(',')
  courseOrder.focus()
  courseOrder.dispatchEvent(new Event('change'))
  undoShortestOrder.value = previousOrder
  undoShortestOrder.hidden = false
  byId('course-order-status').textContent = `추천 방문 순서를 적용했어요. ${courseOrder.selectedOptions[0].textContent}`
})

undoShortestOrder.addEventListener('click', () => {
  courseOrder.value = undoShortestOrder.value
  courseOrder.focus()
  courseOrder.dispatchEvent(new Event('change'))
  byId('course-order-status').textContent = `이전 방문 순서로 돌아왔어요. ${courseOrder.selectedOptions[0].textContent}`
})

function focusSection(element) {
  if (drawSettings.contains(element) && !drawSettings.open) drawSettings.showModal()
  element.focus({ preventScroll: true })
  element.scrollIntoView({ block: 'center' })
}

byId('show-course-location').addEventListener('click', () => focusSection(byId('course-location-title')))
byId('open-preview-line').addEventListener('click', () => {
  const input = filterInputs.get(previewFor(selected)) ??
    byId(byId('nearby-course').checked ? 'nearby-course' : 'complete-course')
  focusSection(input)
})
byId('open-draw-filters').addEventListener('click', () => {
  focusSection(byId(byId('open-draw-filters').dataset.target))
})

function focusCourseStop(key, fromMap = false) {
  const card = byId('course').querySelector(`[data-category="${key}"]`)
  if (fromMap) card.querySelector('.back-to-course-map').hidden = false
  focusSection(card.querySelector('h3'))
}

function courseJumpButton(key, label, { needsSearch = false, fromMap = false } = {}) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  if (needsSearch) button.classList.add('course-search-stop')
  if (fromMap) button.dataset.mapStop = key
  button.addEventListener('click', () => focusCourseStop(key, fromMap))
  return button
}

function renderCourseMap(station) {
  undoShortestOrder.hidden = true
  byId('course-order-status').textContent = ''
  const included = visitOrder().filter((key) => !omittedStops.has(key))
  const route = [[null, station], ...included.map((key) => [key, courseSelection.get(key)])]
  const pendingStops = included.filter((key) => !courseSelection.has(key))
  const pending = byId('course-pending')
  pending.hidden = !pendingStops.length
  pending.textContent = pendingStops.length
    ? `장소를 고를 항목 ${pendingStops.length}개 · ${categoryLabels.get(pendingStops[0])}부터 고르기`
    : ''
  pending.onclick = pendingStops.length ? () => focusCourseStop(pendingStops[0]) : null
  const overview = byId('course-overview')
  overview.replaceChildren()
  if (!included.length) overview.textContent = '코스에 장소를 추가할 수 있어요.'
  for (const [key, place] of route.slice(1)) {
    const row = document.createElement('div')
    row.className = 'course-overview-row'
    const category = categoryLabels.get(key)
    const label = document.createElement('span')
    label.className = 'course-overview-category'
    label.textContent = category
    const destination = courseJumpButton(key, place?.name ?? category + ' 장소 고르기', { needsSearch: !place })
    const info = document.createElement('span')
    info.className = 'course-overview-distance'
    info.textContent = place?.access === 'transit' ? '대중교통 이동'
      : Number.isFinite(place?.meters) ? straightDistance(place.meters) : ''
    row.append(label, destination, info)
    const picker = byId('course').querySelector(`[data-category="${key}"] .candidate-picker`)
    if (picker && place) {
      const change = document.createElement('button')
      change.type = 'button'
      change.className = 'course-overview-change'
      change.dataset.changeCategory = key
      change.textContent = '바꾸기'
      change.setAttribute('aria-label', category + ' 바꾸기')
      change.addEventListener('click', () => {
        picker.dataset.fromOverview = 'true'
        picker.open = true
        focusSection(picker.querySelector('summary'))
      })
      row.append(change)
    }
    overview.append(row)
  }
  const stops = route.slice(1).filter(([, stop]) => hasCoordinates(stop))
  byId('course-no-map').hidden = Boolean(stops.length) || !courseSelection.size
  const suggestion = shortestCourseOrder(station)
  const shortestOrderButton = byId('shortest-order')
  shortestOrderButton.hidden = !suggestion
  if (suggestion) {
    const orderLabel = suggestion.order.filter((key) => !omittedStops.has(key))
      .map((key) => categoryLabels.get(key)).join(' → ')
    shortestOrderButton.textContent = `${orderLabel} 순서 적용 · 직선 거리 ${straightDistance(suggestion.savings, '')} 단축`
  }
  const locationButton = byId('show-course-location')
  locationButton.hidden = !stops.length
  locationButton.textContent = stops.length < courseSelection.size
    ? `코스 위치 보기 · ${stops.length}/${courseSelection.size}곳`
    : '코스 위치 보기'
  byId('course-location').hidden = !stops.length
  const distance = byId('course-distance')
  const unmapped = route.slice(1).filter(([, stop]) => stop && !hasCoordinates(stop))
  const missing = byId('course-map-missing')
  missing.hidden = !unmapped.length
  missing.replaceChildren()
  if (unmapped.length) {
    missing.append('좌표가 없어 지도에 표시되지 않은 장소 · ')
    for (const [index, [key, stop]] of unmapped.entries()) {
      if (index) missing.append(', ')
      missing.append(courseJumpButton(key, stop.name, { fromMap: true }))
    }
  }

  const width = 280
  const height = 150
  const points = stops.map(([key, stop]) => ({
    x: (stop.lon - station.lon) * Math.cos(station.lat * Math.PI / 180),
    y: station.lat - stop.lat,
    color: courseColors[key],
    step: included.indexOf(key) + 1,
    key,
    stop,
  }))
  const scale = 1 / Math.max(.000025, ...points.map(({ x, y }) =>
    Math.max(Math.abs(x) / 104, Math.abs(y) / 54)))
  const map = byId('course-map')
  map.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const center = { cx: width / 2, cy: height / 2 }
  const positions = new Map([[station, center], ...points.map(({ x, y, stop }) => [
    stop, { cx: center.cx + x * scale, cy: center.cy + y * scale },
  ])])
  const segments = []
  const walkLinks = []
  let transitSegments = 0
  let total = 0
  for (let i = 1; i < route.length; i += 1) {
    const start = route[i - 1][1]
    const end = route[i][1]
    const item = document.createElement('li')
    item.value = i
    if (!positions.has(start) || !positions.has(end)) {
      const missingSelection = !start || !end
      const transitStop = end?.access === 'transit' ? end : start?.access === 'transit' ? start : null
      if (transitStop && !missingSelection) transitSegments += 1
      item.className = 'course-segment-distance'
      const from = start?.name ?? categoryLabels.get(route[i - 1][0])
      const to = end?.name ?? categoryLabels.get(route[i][0])
      item.append(
        positions.has(start) ? from : courseJumpButton(route[i - 1][0], from),
        ' → ',
        positions.has(end) ? to : courseJumpButton(route[i][0], to),
        missingSelection ? ' · 장소 선택 필요' : transitStop ? ' · 대중교통 경로 확인' : ' · 좌표 미확인',
      )
      if (transitStop && !missingSelection) {
        const mapLink = externalMapLink('도착 장소 지도', end.url)
        mapLink.setAttribute('aria-label', end.name + ' 도착 장소 네이버 지도에서 보기')
        item.append(' · ', mapLink)
      }
      if (start === station && end?.access === 'transit' && end.guideUrl) {
        const guideLink = document.createElement('a')
        guideLink.href = transitStop.guideUrl
        guideLink.target = '_blank'
        guideLink.rel = 'noopener noreferrer'
        guideLink.textContent = '공식 안내 ↗'
        guideLink.setAttribute('aria-label', transitStop.name + ' 공식 안내')
        item.append(' · ', guideLink)
      }
      walkLinks.push(item)
      continue
    }
    const a = positions.get(start)
    const b = positions.get(end)
    segments.push(svg('line', {
      x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy,
      stroke: '#68756b', 'stroke-width': 2, 'stroke-dasharray': '3 4',
    }))
    const segmentDistance = distanceBetween(start, end)
    total += segmentDistance
    const origin = start === station ? { ...station, name: byId('station-name').textContent } : start
    const length = document.createElement('span')
    length.className = 'course-segment-distance'
    length.textContent = ` · ${straightDistance(segmentDistance)}`
    item.append(directionsLink('walk', `${origin.name} → ${end.name} ↗`, end, origin), length)
    walkLinks.push(item)
  }

  byId('course-walk-links').replaceChildren(...walkLinks)
  byId('course-walk').hidden = !stops.length && !transitSegments
  if (byId('course-walk').hidden) byId('course-walk').open = false
  byId('course-walk-summary').textContent =
    transitSegments
      ? `구간별 길찾기 · 도보 ${segments.length}구간 · 대중교통 확인 ${transitSegments}구간`
      : `구간별 도보 길찾기 (앱) · ${segments.length}/${route.length - 1}구간`
  const segmentCount = route.length - 1
  const distanceLabel = segments.length === segmentCount ? '코스 직선 거리 합계' : '계산 가능한 구간의 직선 거리 합계'
  distance.hidden = !segments.length
  distance.textContent = segments.length
    ? `${distanceLabel} · ${straightDistance(total, '')} (${segments.length}/${segmentCount}구간)`
    : ''
  if (!stops.length) return
  map.replaceChildren(...segments, svg('circle', { ...center, r: 9, fill: '#242722', stroke: 'white', 'stroke-width': 2 }))
  const targetMeters = 65 * 111195 / scale
  const magnitude = 10 ** Math.floor(Math.log10(targetMeters))
  const unit = [5, 2, 1].find((value) => value * magnitude <= targetMeters) * magnitude
  const barWidth = unit * scale / 111195
  const bar = svg('path', {
    d: `M 12 131 v 4 h ${barWidth} v -4`, class: 'course-scale-bar',
  })
  const scaleLabel = svg('text', {
    x: 12 + barWidth / 2, y: 127, class: 'course-scale-label',
  })
  scaleLabel.textContent = `${Number(unit.toPrecision(2))} m`
  map.append(bar, scaleLabel)
  const legend = byId('course-map-legend')
  legend.replaceChildren()
  const entries = [{ color: '#242722', label: byId('station-name').textContent }]
  for (const { color, stop, step, key } of points) {
    const { cx, cy } = positions.get(stop)
    const circle = svg('circle', { cx, cy, r: 8, fill: color, stroke: 'white', 'stroke-width': 2 })
    const label = svg('text', { x: cx, y: cy, class: 'course-map-step', 'aria-hidden': 'true' })
    label.textContent = step
    const marker = svg('g', { class: 'course-map-marker', 'aria-hidden': 'true' })
    marker.append(svg('circle', { cx, cy, r: 12, fill: 'transparent' }), circle, label)
    marker.addEventListener('click', () => focusCourseStop(key, true))
    map.append(marker)
    entries.push({ color, key, marker, label: `${step}. ${stop.category} · ${stop.name}` })
  }
  for (const { color, key, marker, label } of entries) {
    const item = document.createElement('li')
    item.style.setProperty('--dot', color)
    if (key) {
      const button = courseJumpButton(key, label, { fromMap: true })
      button.dataset.category = key
      const highlight = () => marker.classList.toggle('highlighted', button.matches(':hover, :focus'))
      for (const event of ['mouseenter', 'mouseleave', 'focus', 'blur']) {
        button.addEventListener(event, highlight)
      }
      marker.addEventListener('mouseenter', () => button.classList.add('highlighted'))
      marker.addEventListener('mouseleave', () => button.classList.remove('highlighted'))
      item.append(button)
    } else {
      item.textContent = label
    }
    legend.append(item)
  }
}

const stationQuery = byId('station-query')
const stationMatches = byId('station-matches')
const stationSearchResults = byId('station-search-results')

function normalizeStationName(name) {
  return name.normalize('NFC').toLowerCase().replace(/[\s·]+/g, '')
}

const stationSearchEntries = [...stations.values()].map((station) => {
  const name = normalizeStationName(station.name)
  const displayName = normalizeStationName(stationDisplayName(station))
  const qualifiedNames = new Set()
  for (const id of station.lines) {
    const line = normalizeStationName(lines.get(id).name)
    for (const lineName of new Set([line, line.replace(/^(\d+)호선$/, '$1')])) {
      for (const stationName of new Set([name, displayName])) {
        qualifiedNames.add(stationName + lineName)
        qualifiedNames.add(lineName + stationName)
      }
    }
  }
  return { station, name, qualifiedNames }
})

function renderStationMatches() {
  const query = normalizeStationName(stationQuery.value)
  const withoutSuffix = query.replace(/역$/, '')
  const terms = withoutSuffix && withoutSuffix !== query ? [query, withoutSuffix] : [query]
  stationMatches.replaceChildren()
  stationSearchResults.scrollTop = 0
  stationSearchResults.hidden = !query
  byId('station-search-status').textContent = ''
  if (!query) return
  const drawCandidates = new Set(eligibleStations())
  const matches = stationSearchEntries.flatMap(({ station, name, qualifiedNames }) => {
    if (terms.includes(name) || qualifiedNames.has(query)) return [{ station, score: 0 }]
    if (terms.some((term) => name.startsWith(term))) return [{ station, score: 1 }]
    if (terms.some((term) => name.includes(term))) return [{ station, score: 2 }]
    return []
  })
  matches.sort((a, b) =>
    a.score - b.score ||
    Number(drawCandidates.has(b.station)) - Number(drawCandidates.has(a.station)) ||
    a.station.name.localeCompare(b.station.name, 'ko'))
  const eligibleMatches = matches.filter(({ station }) => drawCandidates.has(station)).length
  byId('station-search-status').textContent = matches.length
    ? `검색 결과 ${matches.length}개 · 뽑기 후보 ${eligibleMatches}개`
    : '일치하는 역이 없어요. 역 이름만 입력하거나 ‘양평역 5호선’처럼 노선명을 함께 입력해 보세요.'
  if (!matches.length) return
  let rendered = 0
  function appendResults() {
    const previous = rendered
    const batch = matches.slice(previous, previous + 8)
    for (const { station } of batch) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = station.name + ' · ' + station.lines.map((id) => lines.get(id).name).join(', ')
      if (station === selected) {
        button.textContent += ' · 현재 코스'
        button.setAttribute('aria-current', 'true')
      }
      if (!drawCandidates.has(station)) {
        button.textContent += ` · 뽑기 후보 아님 (${drawExclusionReason(station)})`
      }
      button.addEventListener('click', () => {
        stationQuery.value = ''
        renderStationMatches()
        if (station === selected) {
          centerStation(station)
          drawMap()
          focusSection(byId('station-name'))
          return
        }
        selectStation(station, true)
      })
      item.append(button)
      stationMatches.append(item)
    }
    rendered += batch.length
    if (rendered < matches.length) {
      const row = document.createElement('li')
      const more = document.createElement('button')
      more.type = 'button'
      more.textContent = `검색 결과 더 보기 (${matches.length - rendered}개 남음)`
      more.addEventListener('click', () => {
        row.remove()
        appendResults()
        stationMatches.children[previous + batch.length].firstElementChild.focus()
      })
      row.append(more)
      stationMatches.append(row)
    }
  }
  appendResults()
}

stationQuery.addEventListener('input', renderStationMatches)
stationQuery.addEventListener('focus', (event) => {
  if (!byId('station-search').contains(event.relatedTarget)) renderStationMatches()
})
const stationSearch = byId('station-search')
stationSearch.addEventListener('focusout', (event) => {
  if (!stationSearch.contains(event.relatedTarget)) stationSearchResults.hidden = true
})
document.addEventListener('pointerdown', (event) => {
  if (!stationSearch.contains(event.target)) stationSearchResults.hidden = true
})
stationSearch.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && !stationSearchResults.hidden) {
    event.preventDefault()
    stationSearchResults.hidden = true
    stationQuery.focus()
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (stationSearchResults.hidden && event.target === stationQuery) renderStationMatches()
  if (stationSearchResults.hidden) return
  const buttons = [...stationMatches.querySelectorAll('button')]
  if (!buttons.length) return
  event.preventDefault()
  const current = buttons.indexOf(document.activeElement)
  if (event.key === 'ArrowDown') buttons[Math.min(current + 1, buttons.length - 1)].focus()
  else if (current > 0) buttons[current - 1].focus()
  else if (current === 0) stationQuery.focus()
  else buttons.at(-1).focus()
})

let composingStationQuery = false
stationQuery.addEventListener('compositionstart', () => { composingStationQuery = true })
stationQuery.addEventListener('compositionend', () => { composingStationQuery = false })

stationSearch.addEventListener('submit', (event) => {
  event.preventDefault()
  if (!composingStationQuery && !stationSearchResults.hidden) stationMatches.querySelector('button')?.click()
})

const reveal = byId('draw-reveal')
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)')
motionPreference.addEventListener('change', (event) => {
  if (event.matches) revealResult()
})

function drawLine(station) {
  return lines.get(station.lines.find((id) => enabled.has(id)))
}

function showTicket(station, preview = false) {
  const line = drawLine(station)
  if (!preview) reveal.style.setProperty('--draw-color', line.color)
  const name = stationDisplayName(station)
  byId('draw-station').textContent = name
  byId('draw-station').style.setProperty('--chars', [...name].length)
  const neighbors = line.edges.flatMap(([a, b]) => a === station.id ? [b] : b === station.id ? [a] : [])
  byId('draw-prev').textContent = stations.get(neighbors[0]) ? stationDisplayName(stations.get(neighbors[0])) : ''
  byId('draw-next').textContent = stations.get(neighbors[1]) ? stationDisplayName(stations.get(neighbors[1])) : ''
  byId('draw-line').textContent = line.name
}

function formatCandidateCounts(counts) {
  if (!counts.some(({ count }) => count > 0)) return ''
  return counts.map(({ label, count }) => `${label} ${count}곳`).join(' · ')
}

function refreshDrawCourseNotice(counts = courseCategories.map(([key, label]) => ({
  label,
  count: courseCandidates(drawResult, key).length,
}))) {
  const coverage = byId('draw-coverage')
  const nearbyOnly = byId('nearby-course').checked
  if (nearbyOnly) {
    counts = courseCategories.map(([key, label]) => ({
      label, count: courseCandidates(drawResult, key).filter(isNearbyCandidate).length,
    }))
  }
  coverage.textContent = counts.some(({ count }) => count)
    ? counts.map(({ label, count }) => `${label} ${count ? `${count}곳` : '후보 없음'}`).join(' · ')
    : '등록된 장소 후보 없음'
  const transitCategories = courseCategories.filter(([key]) => {
    const candidates = courseCandidates(drawResult, key)
    return candidates.length && candidates.every((candidate) => candidate[8] === 'transit')
  }).map(([, label]) => label)
  if (transitCategories.length) {
    coverage.textContent += ` · ${transitCategories.join('·')}까지 대중교통 이동`
  }
  if (nearbyOnly) coverage.textContent = `직선 800m 이내 · ${coverage.textContent}`
  coverage.hidden = false
  const savedCourseNotice = byId('draw-saved-course')
  const draft = editedCourseIds().includes(drawResult.id) ? readDraft(drawResult.id) : null
  savedCourseNotice.hidden = !draft
  byId('open-draw-result-label').textContent = savedCourseNotice.hidden ? '코스 보기' : '저장한 코스 보기'
  const resultDescription = ['draw-station', 'draw-line', 'draw-coverage']
  if (!savedCourseNotice.hidden) resultDescription.push(savedCourseNotice.id)
  byId('open-draw-result').setAttribute('aria-describedby', resultDescription.join(' '))
  if (draft) {
    const params = new URLSearchParams(draft.course)
    const radius = params.get('radius')
    const distanceLabel = [...courseRadius.options].find((option) => option.value && option.value === radius)?.textContent
    const savedSettings = distanceLabel ? `저장한 설정(후보 거리 ${distanceLabel})` : '이 기기에 저장한 설정'
    if (!nearbyOnly) coverage.textContent = `기본 후보 · ${coverage.textContent}`
    savedCourseNotice.textContent = `코스를 열면 ${savedSettings}이 적용돼요.`
    const names = savedPlaceNames(params)
    const savedPreview = document.createElement('span')
    savedPreview.className = 'draw-saved-preview'
    savedPreview.textContent = names.length ? `저장한 장소 ${names.length}곳 · ${names.join(' → ')}` : '저장한 장소 없음'
    savedCourseNotice.append(' ', savedPreview)
  }
  const preview = byId('draw-places')
  preview.replaceChildren()
  if (!draft) {
    for (const [key, label] of courseCategories) {
      const candidate = courseCandidates(drawResult, key).find((place) => !nearbyOnly || isNearbyCandidate(place))
      if (!candidate) continue
      const item = document.createElement('li')
      const category = document.createElement('span')
      category.className = 'draw-place-meta'
      category.textContent = label
      const name = document.createElement('strong')
      name.textContent = candidate[0]
      const description = document.createElement('span')
      description.className = 'draw-place-desc'
      description.textContent = candidate[2] ? ` · ${candidate[2]}` : ''
      category.append(description)
      item.append(category, name)
      if (candidate[8] === 'transit') {
        const access = document.createElement('small')
        access.textContent = candidate[2].includes('셔틀') ? '셔틀 이동' : '대중교통 이동'
        item.append(access)
      }
      preview.append(item)
    }
  }
  preview.hidden = !preview.childElementCount
  byId('draw-announcement').textContent = [
    `${reveal.dataset.history === 'true' ? '이전에 뽑은 역' : '오늘 내릴 역'}은 ${stationDisplayName(drawResult)}입니다.`,
    byId('draw-line').textContent,
    coverage.textContent,
    preview.hidden ? '' : [...preview.children].map((item) => [...item.children].map((part) => part.textContent).join(' ')).join(', '),
    byId('draw-remaining').hidden ? '' : byId('draw-remaining').textContent,
    byId('draw-origin').textContent,
    savedCourseNotice.hidden ? '' : savedCourseNotice.textContent,
  ].filter(Boolean).join(' ')
}

function showWinner(fromHistory = false) {
  showTicket(drawResult)
  byId('draw-station').removeAttribute('aria-hidden')
  byId('draw-line').removeAttribute('aria-hidden')
  if (drawResult.lines.length > 1) {
    const lineLabel = byId('draw-line')
    lineLabel.replaceChildren()
    for (const [active, label] of [[true, '선택한 노선'], [false, '다른 노선']]) {
      const group = drawResult.lines.filter((id) => enabled.has(id) === active)
      if (!group.length) continue
      if (lineLabel.childElementCount) lineLabel.append(' ')
      const row = document.createElement('span')
      row.className = 'draw-line-group'
      const groupLabel = document.createElement('span')
      groupLabel.className = 'draw-line-group-label'
      groupLabel.textContent = label
      row.append(groupLabel, ' ')
      group.forEach((id, index) => {
        if (index) row.append(', ')
        const line = lines.get(id)
        const tag = document.createElement('span')
        tag.className = 'draw-transfer-line'
        tag.textContent = line.name
        tag.style.setProperty('--line', line.color)
        row.append(tag)
      })
      lineLabel.append(row)
    }
  }
  reveal.dataset.history = String(fromHistory)
  const title = byId('draw-status').children
  title[0].textContent = fromHistory ? '이전에 뽑은 역은' : '오늘 내릴 역은'
  title[1].textContent = `${stationDisplayName(drawResult)}!`
  byId('draw-lead').textContent = '이 역에서 둘만의 데이트를 시작해 보세요.'
  byId('draw-caption').textContent = '우리의 다음 데이트가 기다리고 있어요.'
  byId('open-draw-result-station').textContent = `${stationDisplayName(drawResult)} `
  reveal.classList.add('landed')
  byId('open-draw-result').disabled = false
  const eligible = eligibleStations().filter((station) => station !== drawOrigin)
  const redraw = byId('redraw')
  redraw.hidden = eligible.length < 2
  const remaining = eligible.filter((station) => !drawnStations.has(station)).length
  redraw.textContent = '다시 뽑기'
  if (remaining === 1) redraw.textContent = '남은 역 뽑기'
  if (!remaining) redraw.textContent = '새로 한 바퀴 뽑기'
  const drawRemaining = byId('draw-remaining')
  const nextRoundCount = eligible.length - 1
  const previousStation = recentDraws[0]
  drawRemaining.textContent = remaining
    ? `이번 뽑기에서 아직 안 나온 역 ${remaining}곳 · 다음 뽑기에서 역마다 1/${remaining}`
    : `모든 후보 역을 한 번씩 뽑았어요. 다음 뽑기는 직전에 나온 역을 제외한 ${nextRoundCount}곳에서 시작해요. ${stationMapQuery(previousStation)} 제외 · 역마다 1/${nextRoundCount}`
  if (eligible.length === 1) drawRemaining.textContent = '현재 조건에서 뽑을 수 있는 역이 한 곳이에요.'
  drawRemaining.hidden = !eligible.length
  const origin = byId('draw-origin')
  origin.hidden = !drawOrigin
  origin.textContent = drawOrigin ? `현재 코스의 역 제외 · ${stationMapQuery(drawOrigin)}` : ''
  const counts = courseCategories.map(([key, label]) => ({
    label,
    count: courseCandidates(drawResult, key).length,
  }))
  const summary = formatCandidateCounts(counts)
  const mapSearch = byId('draw-map-search')
  const stationQuery = stationMapQuery(drawResult)
  mapSearch.replaceChildren(naverLink(summary ? '역 위치' : '역 주변 검색', stationQuery))
  if (drawResult.lines.includes('자기부상철도')) mapSearch.append(maglevGuideLink())
  for (const [index, { label, count }] of counts.entries()) {
    if (count) continue
    const link = naverLink(`${label} 검색`, `${stationQuery} ${courseCategories[index][2]}`)
    link.setAttribute('aria-label', `${stationQuery} 주변 ${label} 검색 네이버 지도에서 보기`)
    mapSearch.append(link)
  }
  mapSearch.hidden = false
  refreshDrawCourseNotice(counts)
  const history = byId('recent-draws')
  const duplicateNames = new Set(recentDraws.filter((station, index) =>
    recentDraws.findIndex((other) => stationDisplayName(other) === stationDisplayName(station)) !== index)
    .map(stationDisplayName))
  history.replaceChildren(...recentDraws.filter((station) => station !== drawResult).map((station) => {
    const button = document.createElement('button')
    button.type = 'button'
    const lineName = drawLine(station).name
    const name = stationDisplayName(station)
    button.textContent = duplicateNames.has(name) ? `${name} · ${lineName}` : name
    button.setAttribute('aria-label', `${name} · ${lineName}`)
    button.addEventListener('click', () => {
      drawResult = station
      showWinner(true)
      byId('open-draw-result').focus()
    })
    return button
  }))
  history.hidden = !history.childElementCount
}

function revealResult() {
  if (!reveal.open || !drawResult || reveal.classList.contains('landed')) return
  clearTimeout(drawTimer)
  drawTimer = null
  for (const animation of byId('draw-reel').getAnimations?.() ?? []) animation.cancel()
  const skip = byId('skip-draw')
  const moveFocus = document.activeElement === skip
  skip.hidden = true
  byId('open-draw-result').hidden = false
  drawnStations.add(drawResult)
  const previous = recentDraws.indexOf(drawResult)
  if (previous !== -1) recentDraws.splice(previous, 1)
  recentDraws.unshift(drawResult)
  recentDraws.splice(5)
  showWinner()
  if (moveFocus) byId('open-draw-result').focus()
}

function drawStation(previousWinner = null, trigger = null) {
  if (drawing) return
  const candidates = eligibleStations()
  if (!reveal.open) drawOrigin = candidates.includes(previousWinner) ? previousWinner : null
  const eligible = candidates.filter((station) => station !== drawOrigin)
  if (!eligible.length) return
  if (!reveal.open) drawnStations.clear()
  let pool = eligible.filter((station) => station !== previousWinner && !drawnStations.has(station))
  if (!pool.length) {
    drawnStations.clear()
    recentDraws.length = 0
    pool = eligible.length > 1 ? eligible.filter((station) => station !== previousWinner) : eligible
  }
  drawResult = pool[Math.floor(Math.random() * pool.length)]
  drawing = true
  if (trigger) drawTrigger = trigger
  refreshDrawPool()
  byId('open-draw-result').disabled = true
  byId('open-draw-result').hidden = true
  byId('draw-announcement').textContent = ''
  byId('draw-station').setAttribute('aria-hidden', 'true')
  byId('draw-line').setAttribute('aria-hidden', 'true')
  byId('draw-coverage').hidden = true
  byId('draw-places').hidden = true
  const mapSearch = byId('draw-map-search')
  mapSearch.hidden = true
  mapSearch.replaceChildren()
  byId('draw-saved-course').hidden = true
  byId('draw-remaining').hidden = true
  byId('draw-origin').hidden = true
  reveal.classList.remove('landed')
  reveal.style.removeProperty('--draw-color')
  byId('draw-status').children[0].textContent = '다음 역은…'
  byId('draw-status').children[1].textContent = '어디일까?'
  byId('draw-lead').textContent = '둘만의 목적지를 찾고 있어요.'
  byId('draw-caption').textContent = '두근두근, 잠시만 기다려 주세요.'
  byId('open-draw-result-station').textContent = ''
  if (!reveal.open) {
    recentDraws.length = 0
    reveal.returnValue = ''
    reveal.showModal()
  }
  byId('recent-draws').hidden = true
  byId('redraw').hidden = true
  reveal.scrollTop = 0

  if (motionPreference.matches || pool.length === 1) {
    revealResult()
    return
  }

  byId('skip-draw').hidden = false
  byId('draw-announcement').textContent = '역을 뽑는 중이에요.'
  const delays = [95, 100, 110, 130, 155, 190, 250, 325, 420]
  reveal.style.setProperty('--draw-duration', delays.reduce((total, delay) => total + delay, 0) + 'ms')
  let frame = 0
  const previews = pool.length === 2 ? pool : pool.filter((station) => station !== drawResult)
  let lastPreview = null
  let unseenPreviews = [...previews]
  const stationLabel = byId('draw-reel')
  function spin() {
    if (!reveal.open) return
    if (frame === delays.length) {
      revealResult()
      return
    }
    if (!unseenPreviews.length) unseenPreviews = [...previews]
    let index = Math.floor(Math.random() * unseenPreviews.length)
    if (unseenPreviews[index] === lastPreview) index = (index + 1) % unseenPreviews.length
    lastPreview = unseenPreviews.splice(index, 1)[0]
    showTicket(lastPreview, true)
    stationLabel.animate?.([
      { opacity: .58, transform: 'translateY(32px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: Math.min(delays[frame], 140), easing: 'ease-out' })
    drawTimer = setTimeout(spin, delays[frame])
    frame += 1
  }
  spin()
}

function nearbyCourseParams(station) {
  const params = new URLSearchParams({ radius: String(drawNearbyMeters) })
  for (const [key] of courseCategories) {
    const candidate = courseCandidates(station, key).find(isNearbyCandidate)
    if (candidate) params.set(key, placeKey(candidate))
  }
  return params
}

function finishDraw() {
  for (const animation of byId('draw-reel').getAnimations?.() ?? []) animation.cancel()
  byId('skip-draw').hidden = true
  const winner = reveal.returnValue === 'course' ? drawResult : null
  clearTimeout(drawTimer)
  drawTimer = null
  drawResult = null
  drawing = false
  refreshDrawPool()
  if (winner) {
    selectStation(winner, true, true, null, byId('nearby-course').checked)
  }
  else drawTrigger?.focus({ preventScroll: true })
  drawTrigger = null
  drawOrigin = null
}

byId('redraw').addEventListener('click', () => {
  drawing = false
  byId('dismiss-draw').focus()
  drawStation(recentDraws[0])
})
byId('skip-draw').addEventListener('click', revealResult)
byId('open-draw-result').addEventListener('click', () => reveal.close('course'))
byId('dismiss-draw').addEventListener('click', () => reveal.close())
reveal.addEventListener('close', finishDraw)

function zoom(factor, x = controls.width / 2, y = controls.height / 2) {
  if (!visible.length) return
  const next = Math.max(minimumMapScale(), Math.min(45, controls.scale * factor))
  controls.x += (x - controls.width / 2) * (1 / controls.scale - 1 / next)
  controls.y += (y - controls.height / 2) * (1 / controls.scale - 1 / next)
  controls.scale = next
  fitted = false
  drawMap()
}

byId('reset-course').addEventListener('click', () => {
  if (!selected || !window.confirm('이 역에서 변경한 장소와 설정을 기본값으로 되돌릴까요?')) return
  renderCourse(selected, stationMapQuery(selected), null)
  clearShareFeedback()
  saveDraft(selected, false)
  if (viewingSharedCourse) {
    byId('share-status').textContent = '열어 본 코스를 기본값으로 되돌렸어요.'
    return
  }
  try {
    const remaining = editedCourseIds().filter((id) => id !== selected.id)
    localStorage.setItem(editedCoursesKey, JSON.stringify(remaining))
  } catch {
    // The visible course was already reset.
  }
  renderSavedCourses()
  byId('share-status').textContent = '기본 코스로 되돌렸어요.'
})

byId('open-local-course').addEventListener('click', () => {
  if (selected && viewingSharedCourse) selectStation(selected, true)
})

byId('open-updated-course').addEventListener('click', () => {
  if (selected && !viewingSharedCourse) selectStation(selected, true)
})

byId('save-shared-course').addEventListener('click', () => {
  if (!selected) return
  clearShareFeedback()
  const saved = saveDraft(selected, true, true)
  const status = byId('share-status')
  if (saved) {
    viewingSharedCourse = false
    renderSavedCourses()
    const savedCourse = readDraft(selected.id)
    renderCourse(selected, stationMapQuery(selected), new URLSearchParams(savedCourse?.course ?? courseParams()))
    const url = new URL(location.href)
    url.searchParams.delete('station')
    for (const key of courseQueryKeys) url.searchParams.delete(key)
    history.replaceState(history.state, '', url.href)
    status.textContent = '받은 코스를 이 기기에 저장했어요.'
    status.focus({ preventScroll: true })
    byId('shared-course-actions').hidden = true
  } else {
    status.textContent = '이 기기에 코스를 저장하지 못했어요. 코스 링크를 복사해 보관할 수 있어요.'
  }
})

function sharedCourseUrl() {
  const url = new URL(location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('station', selected.id)
  for (const [key, value] of courseParams({ includePreferences: false, preserveUnresolved: false })) url.searchParams.set(key, value)
  return url.href
}

byId('share-station').addEventListener('click', (event) => {
  if (!selected) return
  copyResult(sharedCourseUrl(), '링크', event.currentTarget)
})

byId('share-course-primary').addEventListener('click', (event) => {
  if (!selected) return
  if (typeof navigator.share === 'function' && byId('share-local-note').hidden) {
    shareCourseOnDevice(event.currentTarget)
  } else {
    copyResult(courseText({ includeCourseLink: byId('share-local-note').hidden }), '코스 텍스트', event.currentTarget)
  }
})

byId('copy-course').addEventListener('click', (event) => {
  if (selected) copyResult(courseText(), '코스 텍스트', event.currentTarget)
})

byId('share-device').addEventListener('click', (event) => shareCourseOnDevice(event.currentTarget))

async function shareCourseOnDevice(trigger) {
  if (!selected) return
  clearShareFeedback()
  const attempt = copyAttempt
  const text = courseText({ includeCourseLink: byId('share-local-note').hidden })
  try {
    await navigator.share({ title: byId('station-name').textContent + ' 데이트 코스', text })
  } catch (error) {
    if (error?.name !== 'AbortError' && attempt === copyAttempt) copyResult(text, '코스 텍스트', trigger)
  }
}

function courseText({ includeCourseLink = true } = {}) {
  const heading = byId('station-name').textContent
  const queryPrefix = stationMapQuery(selected)
  const lineNames = selected.lines.map((id) => lines.get(id).name).join(', ')
  const header = [`${heading} 데이트 코스`, `노선 ${lineNames}`, `역 위치 ${naverSearchUrl(queryPrefix)}`]
  if (selected.lines.includes('자기부상철도')) header.push('자기부상열차 운행 안내', maglevGuideUrl)
  if (courseRadius.value) header.push(`후보 거리 ${courseRadius.selectedOptions[0].textContent}`)
  const courseDistance = byId('course-distance')
  if (!courseDistance.hidden) header.push(courseDistance.textContent)
  else if (courseSelection.size) header.push('직선 거리를 계산할 수 있는 구간이 없어요.')
  const activeStops = visitOrder().filter((key) => !omittedStops.has(key))
  const pendingStops = activeStops.length - courseSelection.size
  if (pendingStops) header.push(`선택한 장소 ${courseSelection.size}곳 · 장소를 고를 항목 ${pendingStops}개`)
  const selectedStops = [...courseSelection.values()]
  const transitStops = selectedStops.filter((stop) => stop.access === 'transit').length
  if (transitStops) header.push(`대중교통으로 이동할 장소 ${transitStops}곳`)
  const unmeasuredStops = selectedStops.filter((stop) => stop.access !== 'transit' && stop.meters === undefined).length
  if (unmeasuredStops) header.push(`역에서 거리를 확인할 수 없는 선택 장소 ${unmeasuredStops}곳`)
  if (viewingSharedCourse) {
    const changed = activeStops.filter((key) => unresolvedSharedPlaces.has(key)).map((key) => categoryLabels.get(key))
    if (changed.length) header.push(`원래 장소를 찾지 못해 현재 후보로 공유한 항목 · ${changed.join(', ')}`)
  }
  const text = [header.join('\n')]
  if (!activeStops.length) text.push('코스에 추가된 장소가 없어요.')
  for (const [index, key] of activeStops.entries()) {
    const stop = courseSelection.get(key)
    const number = `${index + 1}. `
    if (stop) {
      const label = number + stop.category + ' · ' + stop.name
      const distance = stop.access === 'transit' ? '대중교통 이동'
        : stop.meters === undefined ? '거리 미확인' : '역에서 ' + straightDistance(stop.meters)
      const mapLabel = stop.mapSearch ? '출발점 지도' : ''
      const guide = stop.guideUrl ? [stop.name + ' 공식 방문 안내', stop.guideUrl] : []
      text.push([label, stop.description, stop.address, distance, mapLabel, stop.url, ...guide].filter(Boolean).join('\n'))
    } else {
      const [, category, query] = courseCategories.find(([categoryKey]) => categoryKey === key)
      const distanceNote = courseRadius.value && courseCandidates(selected, key).length
        ? `코스 후보 없음 (${courseRadius.selectedOptions[0].textContent})`
        : ''
      text.push([
        number + category + ' · 네이버 지도에서 주변 검색',
        distanceNote,
        naverSearchUrl(queryPrefix + ' ' + query),
      ].filter(Boolean).join('\n'))
    }
  }
  if (includeCourseLink) {
    const openCourseLabel = byId('share-local-note').hidden ? '코스 열기' : '코스 열기 (원래 기기에서만)'
    text.push(openCourseLabel + '\n' + sharedCourseUrl())
  }
  return text.join('\n\n')
}

let copyAttempt = 0
let manualCopyTrigger = null

function clearShareFeedback() {
  copyAttempt += 1
  manualCopyTrigger = null
  byId('share-status').textContent = ''
  byId('manual-copy').hidden = true
  byId('manual-copy-value').value = ''
}

function dismissManualCopy() {
  const trigger = manualCopyTrigger
  clearShareFeedback()
  if (trigger && (trigger.id === 'share-course-primary' || byId('course-tools').open)) trigger.focus()
  else byId('course-tools').querySelector('summary').focus()
}

byId('dismiss-manual-copy').addEventListener('click', dismissManualCopy)
byId('select-manual-copy').addEventListener('click', () => {
  const field = byId('manual-copy-value')
  field.focus()
  field.select()
})
byId('manual-copy').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  dismissManualCopy()
})

async function copyResult(value, label, trigger) {
  clearShareFeedback()
  const attempt = copyAttempt
  const station = selected
  const status = byId('share-status')
  const isCurrent = () => selected === station && attempt === copyAttempt
  try {
    await navigator.clipboard.writeText(value)
    if (isCurrent()) status.textContent = `${label}를 복사했어요.`
  } catch {
    if (!isCurrent()) return
    manualCopyTrigger = trigger
    byId('manual-copy-label').textContent = label === '링크' ? '복사할 코스 링크' : '복사할 코스 텍스트'
    status.textContent = '아래에서 내용을 직접 복사할 수 있어요.'
    const field = byId('manual-copy-value')
    field.value = value
    byId('manual-copy').hidden = false
    field.focus()
    field.select()
  }
}

byId('open-settings').addEventListener('click', () => drawSettings.showModal())

byId('show-all').addEventListener('click', () => setAll(true))
byId('hide-all').addEventListener('click', () => setAll(false))
byId('draw').addEventListener('click', (event) => drawStation(null, event.currentTarget))
byId('draw-from-course').addEventListener('click', (event) => drawStation(selected, event.currentTarget))
for (const id of ['complete-course', 'nearby-course']) {
  byId(id).addEventListener('change', () => {
    refreshDrawPool()
    if (!stationSearchResults.hidden) renderStationMatches()
    saveDrawPreferences()
  })
}
byId('clear-place-condition').addEventListener('click', () => {
  byId('complete-course').checked = false
  const nearby = byId('nearby-course')
  nearby.checked = false
  nearby.dispatchEvent(new Event('change'))
  byId('draw').focus()
})
byId('center-station').addEventListener('click', () => {
  if (!selected) return
  centerStation(selected)
  drawMap()
})
byId('show-station-on-map').addEventListener('click', () => {
  if (!selected) return
  keyboardStation = selected
  centerStation(selected)
  drawMap()
  focusSection(markers.get(selected.id).marker)
})
function fitMapArea(stationList) {
  fitNetwork(stationList)
  fitted = false
  drawMap()
}
byId('fit-seoul').addEventListener('click', () => {
  fitMapArea(visible.filter(isInCentralSeoul))
})
byId('fit-selected').addEventListener('click', () => fitMapArea(visible.filter(hasEnabledLine)))
byId('fit').addEventListener('click', () => { fitNetwork(); drawMap() })
byId('zoom-in').addEventListener('click', () => zoom(1.5))
byId('zoom-out').addEventListener('click', () => zoom(1 / 1.5))
map.addEventListener('keydown', (event) => {
  if (event.target !== map || !visible.length || event.ctrlKey || event.metaKey || event.altKey) return
  if (['+', '=', '-'].includes(event.key)) {
    event.preventDefault()
    zoom(event.key === '-' ? 1 / 1.5 : 1.5)
    return
  }
  if (!Object.hasOwn(arrowOffsets, event.key)) return
  event.preventDefault()
  const [x, y] = arrowOffsets[event.key]
  controls.x += x * 48 / controls.scale
  controls.y += y * 48 / controls.scale
  fitted = false
  drawMap()
})
map.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return
  event.preventDefault()
  const rect = map.getBoundingClientRect()
  zoom(Math.exp(-event.deltaY * .015), event.clientX - rect.left, event.clientY - rect.top)
}, { passive: false })
map.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') {
    mapTouches.set(event.pointerId, [event.clientX, event.clientY])
    if (mapTouches.size > 1) {
      drag = null
      moved = true
      for (const pointerId of mapTouches.keys()) map.setPointerCapture(pointerId)
      updatePinch()
      return
    }
  }
  if (!event.isPrimary || event.button !== 0) return
  moved = false
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: controls.x, originY: controls.y }
})
map.addEventListener('pointermove', (event) => {
  if (mapTouches.has(event.pointerId)) {
    mapTouches.set(event.pointerId, [event.clientX, event.clientY])
    if (mapTouches.size > 1) {
      updatePinch()
      return
    }
  }
  if (drag?.id !== event.pointerId) return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y
  if (!moved && Math.hypot(dx, dy) < 5) return
  if (!moved) map.setPointerCapture(event.pointerId)
  moved = true
  fitted = false
  controls.x = drag.originX - dx / controls.scale
  controls.y = drag.originY - dy / controls.scale
  map.classList.add('dragging')
  drawMap()
})
function updatePinch() {
  const [[firstX, firstY], [secondX, secondY]] = [...mapTouches.values()]
  const distance = Math.max(1, Math.hypot(firstX - secondX, firstY - secondY))
  const rect = map.getBoundingClientRect()
  const x = (firstX + secondX) / 2 - rect.left
  const y = (firstY + secondY) / 2 - rect.top
  if (pinch) {
    controls.x += (pinch.x - x) / controls.scale
    controls.y += (pinch.y - y) / controls.scale
    zoom(distance / pinch.distance, x, y)
  }
  pinch = { x, y, distance }
}
function stopDragging(event) {
  if (event.type === 'lostpointercapture' && event.target !== map) return
  if (event.type === 'pointercancel') moved = true
  if (mapTouches.delete(event.pointerId)) {
    pinch = null
    if (mapTouches.size > 1) updatePinch()
  }
  if (drag?.id !== event.pointerId) return
  drag = null
  map.classList.remove('dragging')
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) map.addEventListener(event, stopDragging)
map.addEventListener('pointerleave', (event) => {
  if (!map.hasPointerCapture(event.pointerId)) stopDragging(event)
})

function sizeMap({ width, height }) {
  if (!width || !height) return
  controls.width = width
  controls.height = height
  map.setAttribute('viewBox', `0 0 ${width} ${height}`)
}
sizeMap(map.getBoundingClientRect())
new ResizeObserver(([entry]) => {
  sizeMap(entry.contentRect)
  if (fitted) fitNetwork()
  drawMap()
}).observe(map)
restoreDrawPreferences()
renderSavedCourses()
const sharedParams = new URLSearchParams(location.search)
const linkedStation = stations.get(sharedParams.get('station'))
refreshFilters()
if (linkedStation) {
  selectStation(linkedStation, true, false, sharedParams)
} else if (sharedParams.has('station')) {
  byId('invalid-course-link').hidden = false
} else {
  const draft = readDraft()
  const draftStation = draft && stations.get(draft.station)
  if (draftStation) selectStation(draftStation, true, false)
}
