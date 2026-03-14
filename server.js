const express = require('express')
const cors = require('cors')
const http = require('http')
const WebSocket = require('ws')
const fetch = require('node-fetch')

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ noServer: true })
const PORT = process.env.PORT || 3001

// Allow all origins including null (file:// protocol)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'DocuScribe MD Proxy' }))

app.post('/anthropic', async (req, res) => {
  const apiKey = req.headers['x-api-key']
  if (!apiKey) return res.status(400).json({ error: 'Missing x-api-key' })
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    })
    res.status(r.status).json(await r.json())
  } catch(e) { res.status(500).json({ error: e.message }) }
})

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/deepgram') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  else socket.destroy()
})

wss.on('connection', (client, req) => {
  const url = new URL(req.url, 'http://localhost')
  const dgKey = url.searchParams.get('dgKey')
  url.searchParams.delete('dgKey')

  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + url.searchParams.toString()
  console.log('[Proxy] Connecting to Deepgram:', dgUrl.substring(0, 80))

  const dg = new WebSocket(dgUrl, { headers: { Authorization: 'Token ' + dgKey } })

  dg.on('open', () => {
    console.log('[Proxy] Deepgram ready')
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'ProxyOpen' }))
  })
  dg.on('message', data => { if (client.readyState === 1) client.send(data) })
  dg.on('error', e => {
    console.error('[Proxy] DG error:', e.message)
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'ProxyError', message: e.message }))
  })
  dg.on('close', (code, reason) => {
    console.log('[Proxy] DG closed:', code, reason.toString())
    if (client.readyState === 1) client.close()
  })

  client.on('message', data => { if (dg.readyState === 1) dg.send(data) })
  client.on('close', () => { if (dg.readyState === 1) dg.close() })
  client.on('error', e => console.error('[Proxy] Client error:', e.message))
})

server.listen(PORT, () => console.log('DocuScribe MD Proxy running on port ' + PORT))

