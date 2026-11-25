// Dedicated regression for covered markers: normal detail selection never relies on force clicks.
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const home = process.argv[2] ?? 'http://127.0.0.1:18473/'

async function checkDetails(page, key, closeWithEscape) {
  const card = page.locator(`#course [data-category="${key}"]`)
  const name = await card.locator('div[aria-live] > strong').innerText()
  const address = await card.locator('.place-address').innerText()
  const url = await card.locator('.course-actions a[href^="https://map.naver.com/p/search/"]').first().getAttribute('href')
  const trigger = page.locator(`[data-map-detail="${key}"]`)
  assert.match(await trigger.getAttribute('aria-label'), /지도 상세 보기$/)
  await trigger.focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#map-place-name').innerText(), name)
  assert.equal(await page.locator('#map-place-address').innerText(), address)
  const description = await page.locator('#map-place-description').innerText()
  assert.ok(description && (await card.locator('div[aria-live]').innerText()).includes(description))
  assert.match(await page.locator('#map-place-category').innerText(), new RegExp(({activity:'놀거리',food:'먹거리',cafe:'카페'})[key]))
  assert.equal(await page.locator('#map-place-actions a').getAttribute('href'), url)
  assert.equal(await page.locator(':focus').getAttribute('id'), 'map-place-name')
  assert.ok(await page.locator('#map-place-name').evaluate(n => { const r=n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }))
  if (closeWithEscape) await page.keyboard.press('Escape')
  else await page.getByRole('button', { name: '지도 장소 정보 닫기', exact: true }).click()
  assert.ok(await page.locator('#map-place').isHidden())
  assert.equal(await page.locator(':focus').getAttribute('data-map-detail'), key)
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce', isMobile: width < 900 })
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      await page.route('https://oapi.map.naver.com/**', r => r.abort())
      await page.route('https://tile.openstreetmap.org/**', r => r.abort())
      await page.goto(new URL('?course=0208', home).href)
      await page.locator('#show-course-location').click()
      // Keep real same-coordinate places without requiring a marker defect to persist.
      const coordinates = await page.evaluate(async () => {
        const { default: shops } = await import('./data/shops.js')
        return [shops['0208'].food[0].slice(4, 6), shops['0208'].cafe[0].slice(4, 6)]
      })
      assert.deepEqual(coordinates[0], coordinates[1])
      await checkDetails(page, 'food', true)
      await checkDetails(page, 'cafe', false)
      // A map-origin candidate change returns directly to the new place detail.
      await page.locator('[data-map-detail="food"]').click()
      await page.locator('[data-map-stop="food"]').click()
      const picker = page.locator('[data-category="food"] .candidate-picker')
      await picker.locator('summary').click()
      await picker.locator('li button').nth(1).click()
      assert.ok(await page.locator('#map-place').isHidden())
      const changedReturn = page.getByRole('button', { name: '바꾼 장소 지도에서 확인', exact: true })
      await changedReturn.focus()
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('#map-place-name').innerText(), await page.locator('[data-category="food"] div[aria-live] > strong').innerText())
      assert.equal(await page.locator(':focus').getAttribute('id'), 'map-place-name')
      await page.keyboard.press('Escape')
      assert.equal(await page.locator(':focus').getAttribute('data-map-detail'), 'food')
      await checkDetails(page, 'food', true)
      await page.reload()
      assert.ok(await page.locator('#map-place').isHidden())
      await page.locator('#show-course-location').click()
      await checkDetails(page, 'food', true)
      await page.goto(home)
      await page.goBack()
      assert.ok(await page.locator('#map-place').isHidden())
      await page.locator('#show-course-location').click()
      await page.locator('[data-map-detail="food"]').click()
      await page.getByRole('button', { name: '먹거리 빼기', exact: true }).click()
      assert.ok(await page.locator('#map-place').isHidden())
      assert.equal(await page.locator('[data-map-detail="food"]').count(), 0)
      await checkDetails(page, 'cafe', true)
      await page.getByRole('button', { name: '놀거리 빼기', exact: true }).click()
      assert.equal(await page.locator('[data-map-detail]').count(), 1)
      await page.getByRole('button', { name: '카페 빼기', exact: true }).click()
      assert.equal(await page.locator('[data-map-detail]').count(), 0)
      assert.ok(await page.locator('#map-place').isHidden())
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px real exact overlap: covered first and top place, identity/link/focus, change/removal, one/zero`)
      await page.close()
    }
    for (const separation of [0.000005, 0.02]) {
      const page = await browser.newPage({ viewport: { width: 320, height: 760 } })
      await page.route('https://oapi.map.naver.com/**', r => r.abort())
      await page.route(/\/data\/(parks|markets|shops)\.js$/, r => r.fulfill({ contentType:'application/javascript', body:'export default {}' }))
      const data = { '0208': { food: [['첫 장소', '주소 A', '첫 설명', 100, 37.5615, 127.037859], ['좌표 없는 후보', '주소 C', '미확인 설명']], cafe: [['둘째 장소', '주소 B', '둘째 설명', 100, 37.5615 + separation, 127.037859]] } }
      await page.route('**/data/places.js', r => r.fulfill({ contentType:'application/javascript', body:'export default ' + JSON.stringify(data) }))
      await page.goto(new URL('?course=0208', home).href)
      await page.locator('#show-course-location').click()
      await checkDetails(page, 'food', true)
      await checkDetails(page, 'cafe', false)
      for (const [index, mapped] of [[1, false], [0, true]]) {
        await page.locator('[data-map-stop="food"]').click()
        const picker = page.locator('[data-category="food"] .candidate-picker')
        await picker.locator('summary').click()
        await picker.locator('li button').nth(index).click()
        const back = page.getByRole('button', { name: mapped ? '바꾼 장소 지도에서 확인' : '지도 미표시 이유 확인', exact: true })
        await back.click()
        if (mapped) {
          assert.equal(await page.locator('#map-place-name').innerText(), '첫 장소')
          await page.keyboard.press('Escape')
        } else {
          assert.ok(await page.locator('#map-place').isHidden())
          assert.equal(await page.locator(':focus').getAttribute('data-map-stop'), 'food')
          assert.match(await page.locator('#course-map-missing').innerText(), /좌표가 없어.*좌표 없는 후보/)
          await page.locator('#edit-course-summary').click()
          for (const [order, step] of [['food,cafe,activity', 1], ['cafe,activity,food', 3], ['activity,food,cafe', 2]]) {
            await page.locator('#course-order').selectOption(order)
            const missing = page.locator('#course-map-missing [data-map-stop="food"]')
            const label = `${step}. 먹거리 · 좌표 없는 후보`
            assert.equal(await missing.innerText(), label)
            assert.equal(await missing.getAttribute('aria-label'), label + ' · 장소 카드로 이동')
          }
        }
      }
      console.log(`PASS ${separation < .001 ? 'near overlap' : 'separated'} coordinates: both details remain selectable`)
      await page.close()
    }
  } finally { await browser.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
