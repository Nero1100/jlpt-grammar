const BASE = new URL('.', self.location.href).pathname
const CACHE_PREFIX = BASE === '/' ? 'grammar-app-' : `grammar-app-${BASE.slice(1).replaceAll('/', '-')}`
const CACHE = `${CACHE_PREFIX}${new URL(self.location.href).searchParams.get('v') || 'legacy'}`
const AUDIO_CACHE = `${CACHE_PREFIX}audio-v1`
const MAX_CACHED_AUDIO = 200
const GRAMMAR_SHA256 = '0a5bffbddfffb69b70bbf72a141beb4dd798cb8022245aa12466c9c616d55d79'
const CORE = ['', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'data/grammar.json', 'data/metadata.json', 'data/audio-manifest.json', 'precache-assets.json'].map((path) => `${BASE}${path}`)

async function matchesGrammarHash(response) {
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer())
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return actual === GRAMMAR_SHA256
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    const page = await fetch(BASE)
    if (!page.ok) throw new Error('Unable to cache application shell')
    const manifest = await fetch(`${BASE}precache-assets.json`, { cache: 'no-store' })
    if (!manifest.ok) throw new Error('Unable to read application asset list')
    const assets = await manifest.json()
    if (!Array.isArray(assets) || !assets.every((path) => typeof path === 'string' && path.startsWith(`${BASE}assets/`))) throw new Error('Invalid application asset list')
    const resources = [...CORE.filter((path) => path !== BASE), ...assets]
    await Promise.all(resources.map(async (path) => {
      const response = await fetch(path)
      const type = response.headers.get('content-type') || ''
      if (!response.ok || type.includes('text/html') ||
        (path.endsWith('.js') && !type.includes('javascript')) ||
        (path.endsWith('.css') && !type.includes('text/css'))) {
        throw new Error(`Unable to cache application resource: ${path}`)
      }
      if (path === `${BASE}data/grammar.json` && !(await matchesGrammarHash(response))) {
        throw new Error('Unable to cache unverified grammar data')
      }
      await cache.put(path, response)
    }))
    await cache.put(BASE, page)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE && key !== AUDIO_CACHE).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (requestUrl.origin !== self.location.origin) return
  if (!requestUrl.pathname.startsWith(BASE)) return
  if (requestUrl.pathname === `${BASE}data/grammar.json` && requestUrl.searchParams.has('integrity-retry')) {
    event.respondWith(fetch(event.request))
    return
  }
  if (/^audio\/[^/]+\/v\d+\/[a-f0-9]{64}\.mp3$/.test(requestUrl.pathname.slice(BASE.length))) {
    event.respondWith((async () => {
      const cache = await caches.open(AUDIO_CACHE)
      const cached = await cache.match(event.request)
      if (cached) return cached
      const response = await fetch(event.request)
      const type = response.headers.get('content-type') || ''
      if (response.status === 200 && /^audio\/(mpeg|mp3)(;|$)/i.test(type)) {
        try {
          await cache.put(event.request, response.clone())
          const keys = await cache.keys()
          await Promise.all(keys.slice(0, -MAX_CACHED_AUDIO).map((key) => cache.delete(key)))
        } catch { /* Storage quota failures must not prevent playback. */ }
      }
      return response
    })())
    return
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) caches.open(CACHE).then((cache) => cache.put(BASE, response.clone()))
          return response
        })
        .catch(async () => (await caches.match(BASE)) || Response.error()),
    )
    return
  }
  event.respondWith(
    caches.match(event.request, { ignoreVary: true }).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok && requestUrl.pathname !== `${BASE}data/grammar.json`) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()))
          return response
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})
