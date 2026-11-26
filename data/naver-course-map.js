export function createNaverCourseMap(container, fallback, attribution) {
  const clientId = document.querySelector('meta[name="naver-maps-client-id"]')?.content.trim()
  if (!clientId) return () => {}

  let latestCourse
  let maps
  let map
  let overlays = []
  let requested = false
  let failed = false

  function clearOverlays() {
    for (const overlay of overlays) overlay.setMap(null)
    overlays = []
  }

  function showFallback() {
    clearOverlays()
    map?.destroy()
    map = null
    container.hidden = true
    fallback.removeAttribute('hidden')
    attribution.hidden = false
  }

  function fail() {
    failed = true
    showFallback()
    latestCourse?.renderFallback()
  }

  function draw() {
    if (!maps || !latestCourse || failed) return
    const { station, stops, connections, onStop } = latestCourse
    const toLatLng = ({ lat, lon }) => new maps.LatLng(lat, lon)
    const center = toLatLng(station)
    try {
      container.hidden = false
      map ??= new maps.Map(container, {
        center, zoom: 16, scrollWheel: false, zoomControl: true,
      })
      clearOverlays()
      for (const connection of connections) {
        overlays.push(new maps.Polyline({
          map, path: connection.map(toLatLng), strokeColor: '#245342',
          strokeWeight: 3, strokeStyle: 'shortdash',
        }))
      }

      const positions = [center]
      overlays.push(new maps.Marker({ map, position: center, title: station.name }))
      for (const { place, step, color, key } of stops) {
        const position = toLatLng(place)
        positions.push(position)
        const badge = document.createElement('span')
        badge.className = 'naver-course-stop'
        badge.style.backgroundColor = color
        badge.textContent = step
        const marker = new maps.Marker({
          map, position, title: place.name,
          icon: { content: badge, anchor: new maps.Point(14, 14) },
        })
        maps.Event.addListener(marker, 'click', () => onStop(key))
        overlays.push(marker)
      }
      if (positions.length > 1) map.fitBounds(positions, { top: 44, right: 44, bottom: 44, left: 44, maxZoom: 17 })
      else {
        map.setCenter(center)
        map.setZoom(16)
      }
      fallback.setAttribute('hidden', '')
      attribution.hidden = true
    } catch {
      fail()
    }
  }

  new ResizeObserver(() => {
    if (map && container.clientWidth && container.clientHeight) map.autoResize()
  }).observe(container)

  return (course) => {
    latestCourse = course
    if (!course) {
      showFallback()
      return
    }
    if (failed) return
    if (maps) {
      draw()
      return
    }
    if (requested) return
    requested = true

    window.navermap_authFailure = fail
    window.initSubwayDateNaverMap = () => {
      // The SDK can invoke the callback before assigning window.naver.maps.
      queueMicrotask(() => {
        maps = window.naver?.maps
        if (maps) draw()
        else fail()
      })
    }
    const script = document.createElement('script')
    const url = new URL('https://oapi.map.naver.com/openapi/v3/maps.js')
    url.searchParams.set('ncpKeyId', clientId)
    url.searchParams.set('callback', 'initSubwayDateNaverMap')
    script.src = url.href
    script.async = true
    script.addEventListener('error', fail, { once: true })
    document.head.append(script)
  }
}
