import http from 'node:http'
import https from 'node:https'

const port = Number(process.env.CARGO_PROXY_PORT || 38473)
const host = '127.0.0.1'

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}

function proxyRequest(targetUrl, res, redirects = 0) {
  const client = targetUrl.startsWith('https:') ? https : http
  const req = client.get(targetUrl, (upstream) => {
    const status = upstream.statusCode || 502
    const location = upstream.headers.location
    if ([301, 302, 303, 307, 308].includes(status) && location && redirects < 5) {
      upstream.resume()
      proxyRequest(new URL(location, targetUrl).toString(), res, redirects + 1)
      return
    }
    const headers = { ...upstream.headers }
    delete headers['transfer-encoding']
    res.writeHead(status, headers)
    upstream.pipe(res)
  })
  req.on('error', (error) => {
    send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, `proxy error: ${error.message}`)
  })
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${host}:${port}`)
  if (requestUrl.pathname === '/index/config.json') {
    send(
      res,
      200,
      { 'content-type': 'application/json; charset=utf-8' },
      JSON.stringify({
        dl: `http://${host}:${port}/api/v1/crates`,
        api: 'https://crates.io',
      }),
    )
    return
  }
  if (requestUrl.pathname.startsWith('/index/')) {
    const upstream = `http://rsproxy.cn${requestUrl.pathname}${requestUrl.search}`
    proxyRequest(upstream, res)
    return
  }
  if (requestUrl.pathname.startsWith('/api/v1/crates/')) {
    const upstream = `https://rsproxy.cn${requestUrl.pathname}${requestUrl.search}`
    proxyRequest(upstream, res)
    return
  }
  send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
})

server.listen(port, host, () => {
  console.log(`cargo proxy listening on http://${host}:${port}`)
})
