// ─────────────────────────────────────────────────────────────────────────────
//  MedScribe AI — Proxy Server
//  Deploy on Render.com as a Node.js Web Service
//
//  Routes:
//  GET  /health              → health check
//  POST /anthropic           → proxies to Anthropic API (fixes CORS)
//  WS   /deepgram            → relays WebSocket to Deepgram (fixes iframe block)
// ─────────────────────────────────────────────────────────────────────────────

const express   = require('express')
const cors      = require('cors')
const http      = require('http')
const WebSocket = require('ws')
const fetch     = require('node-fetch')

const app    = express()
const server = http.createServer(app)

// WebSocket server attached to /deepgram path
const wss = new WebSocket.Server({ noServer: true })

const PORT = process.env.PORT || 3001

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '10mb' }))

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'MedScribe AI Proxy', port: PORT })
})

// ── Anthropic HTTP proxy ──────────────────────────────────────────────────────
app.post('/anthropic', async (req, res) => {
  const apiKey = req.headers['x-api-key']
  if (!apiKey) return res.status(400).json({ error: 'Missing x-api-key header' })

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    })
    const data = await upstream.json()
    res.status(upstream.status).json(data)
  } catch (e) {
    console.error('[Proxy] Anthropic error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Deepgram WebSocket relay ──────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname
  if (pathname === '/deepgram') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

wss.on('connection', (clientWs, req) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`)
  const dgKey  = url.searchParams.get('dgKey') || ''
  url.searchParams.delete('dgKey')

  const dgUrl  = `wss://api.deepgram.com/v1/listen?${url.searchParams.toString()}`
  console.log('[Proxy] Opening Deepgram relay for new client')

  const dgWs = new WebSocket(dgUrl, ['token', dgKey])

  dgWs.on('open', () => {
    console.log('[Proxy] Deepgram connected ✓')
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify({ type: 'ProxyOpen' }))
  })

  dgWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data)
  })

  dgWs.on('error', (err) => {
    console.error('[Proxy] Deepgram error:', err.message)
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify({ type: 'ProxyError', message: err.message }))
  })

  dgWs.on('close', (code) => {
    console.log('[Proxy] Deepgram closed:', code)
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close()
  })

  clientWs.on('message', (data) => {
    if (dgWs.readyState === WebSocket.OPEN) dgWs.send(data)
  })

  clientWs.on('close', () => {
    if (dgWs.readyState === WebSocket.OPEN) dgWs.close()
  })

  clientWs.on('error', (err) => {
    console.error('[Proxy] Client WS error:', err.message)
  })
})

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[MedScribe AI Proxy] Running on port ${PORT}`)
})
