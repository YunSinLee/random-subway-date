// Coordinates use 360 × 880 units across the Web Mercator world.
export const mapWorldWidth = 360 * 880
const tileSize = 256
const tileUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

export function projectStation(lat, lon) {
  const sin = Math.sin(lat * Math.PI / 180)
  return {
    x: (lon + 180) / 360 * mapWorldWidth,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * mapWorldWidth,
  }
}

export function createBasemap(layer) {
  const imageNamespace = layer.ownerSVGElement?.namespaceURI
  const images = new Map()
  return ({ x, y, scale, width, height }) => {
    if (width <= 1 || height <= 1) return
    const zoom = Math.max(0, Math.min(16, Math.round(Math.log2(mapWorldWidth * scale / tileSize))))
    const count = 2 ** zoom
    const size = mapWorldWidth * scale / count
    const left = x * scale - width / 2
    const top = y * scale - height / 2
    const visible = new Set()
    for (let row = Math.max(0, Math.floor(top / size)); row < Math.min(count, Math.ceil((top + height) / size)); row++) {
      for (let column = Math.max(0, Math.floor(left / size)); column < Math.min(count, Math.ceil((left + width) / size)); column++) {
        const key = `${zoom}/${column}/${row}`
        visible.add(key)
        let image = images.get(key)
        if (!image) {
          const src = tileUrl.replace('{z}', zoom).replace('{x}', column).replace('{y}', row)
          if (imageNamespace) {
            image = document.createElementNS(imageNamespace, 'image')
            image.setAttribute('href', src)
            image.setAttribute('preserveAspectRatio', 'none')
          } else {
            image = document.createElement('img')
            image.alt = ''
            image.draggable = false
            image.decoding = 'async'
            image.src = src
          }
          images.set(key, image)
          layer.append(image)
        }
        // Use the same rounded edges for adjacent tiles to avoid hairline gaps.
        const px = Math.round(column * size - left)
        const py = Math.round(row * size - top)
        const pixelWidth = Math.round((column + 1) * size - left) - px
        const pixelHeight = Math.round((row + 1) * size - top) - py
        if (imageNamespace) {
          image.setAttribute('x', px)
          image.setAttribute('y', py)
          image.setAttribute('width', pixelWidth)
          image.setAttribute('height', pixelHeight)
        } else {
          image.style.transform = `translate(${px}px, ${py}px)`
          image.style.width = pixelWidth + 'px'
          image.style.height = pixelHeight + 'px'
        }
      }
    }
    for (const [key, image] of images) {
      if (visible.has(key)) continue
      image.remove()
      images.delete(key)
    }
  }
}
