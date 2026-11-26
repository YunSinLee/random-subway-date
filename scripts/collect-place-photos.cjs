// Use the public Naver Map place cards to find photos and attach them in batches.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { chromium } = require('playwright')

const root = path.resolve(__dirname, '..')
const coverageCommand = path.join(__dirname, 'check-data.cjs')
const importCommand = path.join(__dirname, 'import-place-photos.py')
const [state = '/tmp/subway-date-photo-progress.json', maxCount] = process.argv.slice(2)
const limit = maxCount === undefined ? Infinity : Number(maxCount)
const keyFor = ({ name, address }) => JSON.stringify([name, address])
const normalizeName = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
const addressAliases = {
  서울특별시: '서울', 인천광역시: '인천', 경기도: '경기',
  충청남도: '충남', 강원특별자치도: '강원', 강원도: '강원',
}
const normalizeAddress = (text) => text.trim().replace(/\s+/g, ' ')
  .replace(/([가-힣])(?=\d)/g, '$1 ').replace(/\s*\([^)]*\)$/, '')
  .replace(/경기도|서울특별시|인천광역시|충청남도|강원특별자치도|강원도/g, (value) => addressAliases[value])
const csvLine = (cells) => cells.map((cell) => '"' + String(cell).replace(/"/g, '""') + '"').join(',')

async function findPhoto(page, { name, address }) {
  const expectedAddress = normalizeAddress(address)
  const query = name + ' ' + expectedAddress.split(' ').slice(0, 3).join(' ')
  await page.goto('https://map.naver.com/p/search/' + encodeURIComponent(query), {
    waitUntil: 'domcontentloaded', timeout: 12000,
  })
  const entry = page.frameLocator('#entryIframe')
  const search = page.frameLocator('#searchIframe')
  const heading = entry.locator('h1').first()
  const list = search.locator('a[role="button"] > span:first-child').first()
  const waitForResult = Promise.any([
    heading.waitFor({ timeout: 5500 }),
    list.waitFor({ timeout: 5500 }),
  ])
  if (!await waitForResult.then(() => true, () => false)) return { status: 'no-result' }
  if (!await heading.isVisible()) {
    try {
      const options = search.locator('a[role="button"] > span:first-child')
      const names = await options.allTextContents()
      const matches = names.flatMap((text, index) => normalizeName(text) === normalizeName(name) ? [index] : [])
      if (matches.length !== 1 && !await page.locator('#entryIframe').count()) return { status: 'ambiguous' }
      if (matches.length === 1 && !await page.locator('#entryIframe').count()) {
        await options.nth(matches[0]).click({ timeout: 3500 })
      }
    } catch (error) {
      if (!await page.locator('#entryIframe').count()) throw error
    }
    await heading.waitFor({ timeout: 5500 })
  }
  if (normalizeName(await heading.innerText()) !== normalizeName(name)) return { status: 'different-name' }

  const addresses = await entry.getByRole('button').allTextContents()
  if (!addresses.some((text) => {
    const actual = normalizeAddress(text)
    if (!actual.startsWith(expectedAddress)) return false
    return !/[\d-]/.test(actual[expectedAddress.length] ?? '')
  })) return { status: 'different-address' }

  const iframeUrl = await page.locator('iframe#entryIframe').getAttribute('src')
  const placeId = new URL(iframeUrl).pathname.match(/^\/(?:place|restaurant|hospital|accommodation|hairshop)\/(\d+)(?:\/|$)/)?.[1]
  if (!placeId) return { status: 'missing-place-id' }
  const images = await entry.locator('img[src*="ldb-phinf.pstatic.net"]').evaluateAll((nodes) => nodes.map((image) => image.src))
  for (const image of images) {
    const url = new URL(image)
    const original = url.hostname === 'search.pstatic.net' ? url.searchParams.get('src') : image
    if (original && new URL(original).hostname === 'ldb-phinf.pstatic.net') {
      return { status: 'found', placeId, image }
    }
  }
  return { status: 'no-photo' }
}

async function main() {
  if (!(limit > 0)) throw new Error('Pass a positive maximum number of places, or omit it for all candidates.')
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'subway-place-photos-'))
  const progress = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {}
  const coverage = JSON.parse(execFileSync('node', [coverageCommand, '--photo-coverage'], { encoding: 'utf8' }))
  const remaining = coverage.missing.reverse().filter((place) => !progress[keyFor(place)]).slice(0, limit)
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage()
  const queue = []
  let attempts = 0
  let collected = 0
  let throttled = false
  let stop = false
  process.once('SIGINT', () => { stop = true })
  page.on('response', (response) => {
    const { hostname } = new URL(response.url())
    if (response.status() === 429 && /^(?:map|pcmap\.place)\.naver\.com$/.test(hostname)) throttled = true
  })

  function checkpoint() {
    if (queue.length) {
      const csv = path.join(workspace, 'photos.csv')
      fs.writeFileSync(csv, 'name,address,placeId,file\n' + queue.map(({ place, placeId, file }) =>
        csvLine([place.name, place.address, placeId, file])).join('\n') + '\n')
      execFileSync('python3', [importCommand, csv], { cwd: root, stdio: 'inherit' })
      for (const { place } of queue) progress[keyFor(place)] = 'imported'
      collected += queue.length
      queue.length = 0
    }
    const temporaryState = state + '.tmp'
    fs.writeFileSync(temporaryState, JSON.stringify(progress, null, 2) + '\n')
    fs.renameSync(temporaryState, state)
  }

  try {
    for (const place of remaining) {
      if (stop || throttled) break
      let result
      try {
        result = await findPhoto(page, place)
        if (throttled) break
        if (result.image) {
          const response = await fetch(result.image, { redirect: 'error', signal: AbortSignal.timeout(10000) })
          if (response.status === 429) { throttled = true; break }
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Photo unavailable')
          const file = path.join(workspace, `${attempts}.image`)
          fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
          queue.push({ place, placeId: result.placeId, file })
        } else progress[keyFor(place)] = result.status
      } catch (error) {
        console.error(`Could not verify ${place.name}: ${error.message.split('\n')[0]}`)
      }
      attempts++
      if (attempts % 8 === 0) {
        checkpoint()
        console.log(`Checked ${attempts}/${remaining.length}, registered ${collected}`)
      }
      if (!stop && !throttled) await delay(750)
    }
    checkpoint()
    console.log(`Checked ${attempts}/${remaining.length}, registered ${collected}${throttled ? ' (paused after HTTP 429)' : ''}`)
  } finally {
    await browser.close()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
