// worker/worker.js — the small backend for viceadvice.com.
//
// Everything else on the site is plain files (served by Cloudflare straight from this repo).
// This Worker only runs for:
//   /admin, /admin/*     Command Center (page + its API). Locked twice:
//                        1) Cloudflare Access stops anyone who isn't the owner before they reach the site;
//                        2) this Worker checks Access's signed pass (JWT) on every request, and refuses if it's missing or fake.
//   /media/covers.json   landing-page image list + chances (saved in KV; falls back to the file in the repo)
//   /media/u/<file>      images uploaded from the Command Center (saved in KV)
//
// Storage: Cloudflare KV namespace "viceadvice-data" (binding KV)
//   covers          -> { "images": [ { "file": "cover1.jpg" | "u/<name>", "weight": 0-10 } ] }
//   img:<name>      -> image bytes (metadata: { type })

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const ADMIN_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_UPLOAD = 8 * 1024 * 1024;   // 8 MB per image
const FILE_RE = /^(u\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

// ---------- Cloudflare Access check ----------
let certs = null;
let certsAt = 0;

function b64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function accessKeys(env, force) {
  if (!certs || force || Date.now() - certsAt > 3600e3) {
    const r = await fetch(env.ACCESS_TEAM + '/cdn-cgi/access/certs');
    if (!r.ok) throw new Error('certs ' + r.status);
    certs = (await r.json()).keys || [];
    certsAt = Date.now();
  }
  return certs;
}

// Returns the signed-in identity, or null
async function verifyAccess(req, env) {
  try {
    const token = req.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM) return null;
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    if (header.alg !== 'RS256') return null;
    let jwk = (await accessKeys(env)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(env, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(h + '.' + p));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(b64url(p)));
    const now = Math.floor(Date.now() / 1000);
    if (!c.exp || c.exp < now) return null;
    if (c.nbf && c.nbf > now + 60) return null;
    if (c.iss !== env.ACCESS_TEAM) return null;
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    return { email: c.email || '' };
  } catch (e) {
    return null;
  }
}

// ---------- covers (landing images) ----------
async function readCovers(env, origin) {
  const saved = await env.KV.get('covers', 'json');
  if (saved && Array.isArray(saved.images)) return saved;
  // first run: start from the file in the repo
  const r = await env.ASSETS.fetch(new Request(origin + '/media/covers.json'));
  if (r.ok) { try { const j = await r.json(); if (Array.isArray(j.images)) return j; } catch (e) {} }
  return { images: [] };
}

function cleanList(list) {
  if (!Array.isArray(list) || list.length > 200) return null;
  const seen = new Set();
  const out = [];
  for (const i of list) {
    if (!i || typeof i.file !== 'string' || !FILE_RE.test(i.file) || i.file.includes('..')) return null;
    if (seen.has(i.file)) continue;
    seen.add(i.file);
    const w = Math.round(Number(i.weight));
    out.push({ file: i.file, weight: Number.isFinite(w) ? Math.min(10, Math.max(0, w)) : 5 });
  }
  return out;
}

function safeName(name, ext) {
  const base = String(name || 'image').replace(/\.[^.]*$/, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
  return `${Date.now().toString(36)}-${base}.${ext}`;
}

// ---------- Command Center API (/admin/api/*) ----------
async function adminApi(req, env, url) {
  const path = url.pathname.replace(/^\/admin\/api\/?/, '');
  if (req.method !== 'GET' && req.headers.get('x-va') !== '1') return json({ error: 'bad request' }, 400); // blocks cross-site form posts

  if (path === 'covers' && req.method === 'GET') return json(await readCovers(env, url.origin));

  if (path === 'covers' && req.method === 'PUT') {
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
    const images = cleanList(body && body.images);
    if (!images) return json({ error: 'bad list' }, 400);
    // uploaded images that were removed: delete their bytes too
    const before = await readCovers(env, url.origin);
    const keep = new Set(images.map((i) => i.file));
    await Promise.all(before.images.filter((i) => i.file.startsWith('u/') && !keep.has(i.file))
      .map((i) => env.KV.delete('img:' + i.file.slice(2))));
    await env.KV.put('covers', JSON.stringify({ images }));
    return json({ images });
  }

  if (path === 'upload' && req.method === 'POST') {
    const type = (req.headers.get('content-type') || '').split(';')[0].trim();
    const ext = IMAGE_TYPES[type];
    if (!ext) return json({ error: 'jpg, png or webp only' }, 415);
    const bytes = await req.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD) return json({ error: 'image too large (8 MB max)' }, 413);
    const name = safeName(decodeURIComponent(req.headers.get('x-filename') || ''), ext);
    await env.KV.put('img:' + name, bytes, { metadata: { type } });
    const current = await readCovers(env, url.origin);
    const images = [...current.images, { file: 'u/' + name, weight: 5 }];
    await env.KV.put('covers', JSON.stringify({ images }));
    return json({ images });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // Command Center: page + API, owner only
    if (p === '/admin' || p.startsWith('/admin/')) {
      const who = await verifyAccess(req, env);
      if (!who) return new Response('Forbidden', { status: 403, headers: ADMIN_HEADERS });
      if (p.startsWith('/admin/api/')) {
        const res = await adminApi(req, env, url);
        Object.entries(ADMIN_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }
      const res = await env.ASSETS.fetch(req);
      const out = new Response(res.body, res);
      Object.entries(ADMIN_HEADERS).forEach(([k, v]) => out.headers.set(k, v));
      return out;
    }

    // Public: image list for the landing page
    if (p === '/media/covers.json') {
      return json(await readCovers(env, url.origin));
    }

    // Public: uploaded images
    if (p.startsWith('/media/u/')) {
      const name = p.slice('/media/u/'.length);
      if (!FILE_RE.test(name)) return new Response('Not found', { status: 404 });
      const { value, metadata } = await env.KV.getWithMetadata('img:' + name, 'arrayBuffer');
      if (!value) return new Response('Not found', { status: 404 });
      return new Response(value, {
        headers: {
          'content-type': (metadata && metadata.type) || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    return env.ASSETS.fetch(req);
  },
};
