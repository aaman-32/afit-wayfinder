const rad = (x) => (x * Math.PI) / 180
export function dist(a, b) { // a, b = [lat, lng]
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}
export const distLL = (a, b) => dist([a[1], a[0]], [b[1], b[0]]) // a, b = [lng, lat]
export function bearing(a, b) { // a, b = [lng, lat]
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]))
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]))
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}
export const fmt = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`)
export const mins = (m) => Math.max(1, Math.round(m / 80)) // ~4.8 km/h walking

// Graph of the admin-drawn campus paths. Vertices closer than 8 m are treated as connected.
export function buildGraph(paths) {
  const nodes = [], adj = []
  for (const p of paths) {
    let prev = -1
    for (const c of p.coords) {
      nodes.push(c); adj.push([])
      const i = nodes.length - 1
      if (prev >= 0) { const w = distLL(nodes[prev], c); adj[prev].push([i, w]); adj[i].push([prev, w]) }
      prev = i
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const w = distLL(nodes[i], nodes[j])
      if (w <= 8) { adj[i].push([j, w]); adj[j].push([i, w]) }
    }
  }
  return { nodes, adj }
}

// from / to = [lng, lat]. Returns { coords, distance } or null when the paths don't link both ends.
export function pathRoute(g, from, to, snap = 80) {
  const n = g.nodes.length
  if (!n) return null
  const near = (pt) => {
    let bi = -1, bd = Infinity
    for (let i = 0; i < n; i++) { const d = distLL(g.nodes[i], pt); if (d < bd) { bd = d; bi = i } }
    return bd <= snap ? [bi, bd] : null
  }
  const s = near(from), t = near(to)
  if (!s || !t) return null
  const d = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false)
  d[s[0]] = 0
  for (let k = 0; k < n; k++) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || d[i] < d[u])) u = i
    if (u < 0 || d[u] === Infinity) break
    done[u] = true
    if (u === t[0]) break
    for (const [v, w] of g.adj[u]) if (d[u] + w < d[v]) { d[v] = d[u] + w; prev[v] = u }
  }
  if (d[t[0]] === Infinity) return null
  const mid = []
  for (let u = t[0]; u >= 0; u = prev[u]) mid.push(g.nodes[u])
  mid.reverse()
  return { coords: [from, ...mid, to], distance: s[1] + d[t[0]] + t[1] }
}
