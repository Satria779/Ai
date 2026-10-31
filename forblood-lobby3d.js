/* For Blood LOBBY 3D v2 — karakter di lobi memakai model bald_man (FB_BALD, rig 65 tulang)
 * yang SAMA dengan avatar yang dilihat pemain lain di dalam game.
 * Anggota party (mabar) ikut tampil di samping karakter kamu.
 * Dimuat setelah script FB_BALD di index.html. Jika Three.js / model gagal dimuat,
 * gambar lama (#lobbyChar) tetap dipakai sebagai cadangan.
 *
 * Perubahan v2 (API publik tetap: fbLobby3D.setParty / isReady):
 *  - Karakter di TENGAH layar, kaki menapak lingkaran platform di latar (tinggi karakter 71% layar).
 *  - Pencahayaan ala hanggar: key hangat, fill biru, rim merah, cahaya merah dari platform.
 *  - Warna kulit/pakaian dibaking dari tekstur asli ke warna-per-vertex (khusus lobi), karena atlas
 *    tekstur asli terpecah jadi ribuan pulau kecil (lihat catatan di README) sehingga mip-mapping
 *    mencampur warna latar cokelat ke kulit. Jika gagal, tekstur asli tetap dipakai.
 *  - Render dijeda saat panel layar-penuh menutupi lobi (hemat baterai HP).
 *  - API tambahan: setWeapon(key|null), punch(), status().
 */
(function () {
  'use strict';

  /* ---------- fungsi murni (bisa dites di Node) ---------- */
  function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

  /**
   * Bake warna tekstur ke warna-per-vertex.
   * pos: Float32Array(nv*3), uv: Uint16Array(nv*2, ternormalisasi), idx: Uint16Array/Uint32Array,
   * rgba: Uint8ClampedArray(S*S*4) (baris 0 = atas; model memakai flipY=false), S: lebar tekstur,
   * smooth: 0..1 campuran ke rata-rata tetangga (0 = mati).
   * Return Float32Array(nv*3) warna LINEAR (siap dipakai material.vertexColors).
   */
  function bakeVertexColors(pos, uv, idx, rgba, S, smooth) {
    const nv = pos.length / 3;
    const col = new Float32Array(nv * 3);
    const mx = S - 1;
    for (let i = 0; i < nv; i++) {
      const x = (uv[i * 2] / 65535) * S - 0.5, y = (uv[i * 2 + 1] / 65535) * S - 0.5;
      let x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      let x1 = x0 + 1, y1 = y0 + 1;
      x0 = x0 < 0 ? 0 : x0 > mx ? mx : x0; x1 = x1 < 0 ? 0 : x1 > mx ? mx : x1;
      y0 = y0 < 0 ? 0 : y0 > mx ? mx : y0; y1 = y1 < 0 ? 0 : y1 > mx ? mx : y1;
      const a = (y0 * S + x0) * 4, b = (y0 * S + x1) * 4, c = (y1 * S + x0) * 4, d = (y1 * S + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      for (let k = 0; k < 3; k++) {
        col[i * 3 + k] = (rgba[a + k] * w00 + rgba[b + k] * w10 + rgba[c + k] * w01 + rgba[d + k] * w11) / 255;
      }
    }
    // satukan vertex kembar (posisi sama, UV beda) -> tidak ada jahitan warna
    const map = new Map(), wid = new Int32Array(nv);
    let nw = 0;
    for (let i = 0; i < nv; i++) {
      const key = Math.round(pos[i * 3] * 1e4) + ',' + Math.round(pos[i * 3 + 1] * 1e4) + ',' + Math.round(pos[i * 3 + 2] * 1e4);
      let w = map.get(key);
      if (w === undefined) { w = nw++; map.set(key, w); }
      wid[i] = w;
    }
    let acc = new Float32Array(nw * 3);
    const cnt = new Float32Array(nw);
    for (let i = 0; i < nv; i++) {
      const w = wid[i]; cnt[w]++;
      acc[w * 3] += col[i * 3]; acc[w * 3 + 1] += col[i * 3 + 1]; acc[w * 3 + 2] += col[i * 3 + 2];
    }
    for (let w = 0; w < nw; w++) { const n = cnt[w] || 1; acc[w * 3] /= n; acc[w * 3 + 1] /= n; acc[w * 3 + 2] /= n; }
    if (smooth > 0 && idx && idx.length >= 3) {
      const ns = new Float32Array(nw * 3), nc = new Float32Array(nw);
      const add = (p, q) => { ns[p * 3] += acc[q * 3]; ns[p * 3 + 1] += acc[q * 3 + 1]; ns[p * 3 + 2] += acc[q * 3 + 2]; nc[p]++; };
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const p = wid[idx[t]], q = wid[idx[t + 1]], r = wid[idx[t + 2]];
        if (p === q || q === r || p === r) continue;
        add(p, q); add(q, p); add(q, r); add(r, q); add(r, p); add(p, r);
      }
      const sm = new Float32Array(nw * 3), k0 = 1 - smooth;
      for (let w = 0; w < nw; w++) {
        const n = nc[w];
        for (let k = 0; k < 3; k++) sm[w * 3 + k] = n ? acc[w * 3 + k] * k0 + (ns[w * 3 + k] / n) * smooth : acc[w * 3 + k];
      }
      acc = sm;
    }
    const out = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      const w = wid[i];
      out[i * 3] = srgbToLinear(acc[w * 3]); out[i * 3 + 1] = srgbToLinear(acc[w * 3 + 1]); out[i * 3 + 2] = srgbToLinear(acc[w * 3 + 2]);
    }
    return out;
  }

  if (typeof window === 'undefined') { if (typeof module !== 'undefined' && module.exports) module.exports = { bakeVertexColors: bakeVertexColors }; return; }

  const THREE_URLS = [
    'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.min.js',
    'https://unpkg.com/three@0.152.2/build/three.min.js',
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/build/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.152.2/three.min.js'
  ];

  /* ---------- tata letak (persen layar) ---------- */
  // Geometri lingkaran platform di gambar latar hanggar (piksel pada gambar asli 1672x941).
  // Latar memakai object-fit:cover + object-position:50% 100% (lihat CSS #lobbyBg di index.html),
  // jadi posisi lingkaran di layar dihitung ulang tiap resize -> kaki karakter selalu di tengah lingkaran.
  const RING = { iw: 1672, ih: 941, cx: 851, cy: 816, rw: 842, rh: 176 };
  const SLOT_OFFS = [0.95, -0.95, -1.8];   // jarak anggota party dari pemain (meter, sumbu X dunia)
  const SLOT_SCALE = [0.95, 0.95, 0.88];
  const CHAR_H = 1.9;                      // tinggi model bald_man (meter)
  const CHAR_FRAC = 0.71;                  // karakter = 71% tinggi layar
  const VIEW_H = CHAR_H / CHAR_FRAC;       // tinggi dunia yang terlihat
  const SKIN_SMOOTH = 0.35;                // 0 = mati. Rata-rata ringan warna tetangga (noise warna tekstur)
  const COARSE = !!(window.matchMedia && matchMedia('(pointer:coarse)').matches);
  const FPS_STEP = COARSE ? 1 / 30 : 1 / 58;
  const URLP = (function () { try { return new URLSearchParams(location.search); } catch (_) { return { get: () => null }; } })();
  const USE_BAKE = URLP.get('lobbymat') !== 'orig';   // ?lobbymat=orig -> pakai tekstur asli (untuk perbandingan)

  let renderer = null, scene = null, camera = null, canvas = null, lobbyEl = null, glow = null;
  let mainWX = 0;   // posisi X dunia pemain utama (mengikuti lingkaran platform)
  let me = null, partyDefs = [], party = new Map();
  let raf = 0, last = 0, acc = 0, started = false, ok = false, aspect = 16 / 9;
  let skin = null, skinFailed = false, skinTimer = 0, covered = false, coverTimer = 0, ctxLost = false;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = res; s.onerror = () => rej(new Error('gagal ' + src));
      document.head.appendChild(s);
    });
  }
  async function ensureThree() {
    if (window.THREE) return true;
    for (const u of THREE_URLS) { try { await loadScript(u); if (window.THREE) return true; } catch (_) {} }
    return false;
  }

  function nameSprite(text) {
    const THREE = window.THREE;
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = '700 30px Arial,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = Math.min(244, g.measureText(text).width + 28);
    g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath();
    if (g.roundRect) g.roundRect((256 - w) / 2, 8, w, 48, 10); else g.rect((256 - w) / 2, 8, w, 48);
    g.fill();
    g.fillStyle = '#fff'; g.fillText(String(text).slice(0, 20), 128, 33);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(1.0, 0.25, 1);
    return sp;
  }
  function shadowSprite() {
    const THREE = window.THREE;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    gr.addColorStop(0, 'rgba(0,0,0,.62)'); gr.addColorStop(.55, 'rgba(0,0,0,.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    sp.scale.set(1.35, 0.36, 1); sp.position.set(0, 0.03, -0.3); sp.renderOrder = -1;
    return sp;
  }
  function meshOf(r) { return r && r.body && r.body.children.find(o => o.isSkinnedMesh); }

  function weaponBuilder(k, hands) {
    return typeof window.fbBuildRemoteWeapon === 'function' ? window.fbBuildRemoteWeapon(k, hands) : null;
  }

  function makeAvatar(id, nick, off, showName, turn) {
    const THREE = window.THREE;
    // buildWeapon baru diisi ketika setWeapon() dipanggil, supaya lobi tidak membangun model senjata yang tak terlihat
    const ctx = { scene: scene, hitMeshes: [], buildWeapon: null, makeLabel: (n) => { const s = nameSprite(n); s.visible = showName; return s; }, depthAt: null };
    const r = window.FB_BALD && window.FB_BALD.create(THREE, id, nick, ctx);
    if (!r) return null;
    r.lobbyCtx = ctx;
    r.target.unarmed = true; r.target.alive = true; r.target.weapon = 'ak';
    r.off = off; r.turn = turn;
    r.group.position.set(mainWX + off, 0, 0);
    r.group.rotation.y = Math.PI + turn;       // hadap kamera (sedikit serong)
    const sh = shadowSprite(); r.group.add(sh); r.shadow = sh;
    r.label.position.y = 2.28;
    applySkinTo(r);
    return r;
  }
  function disposeAvatar(r) { try { if (r.shadow) { r.shadow.material.map.dispose(); r.shadow.material.dispose(); } r.dispose(); } catch (_) {} }

  /* ---------- material kulit/pakaian (khusus lobi) ---------- */
  function applySkinTo(r) {
    const m = meshOf(r);
    if (m && skin) { m.geometry = skin.geo; m.material = skin.mat; }
  }
  function prepareSkin() {
    if (skin || skinFailed || !me || !USE_BAKE) { if (skin || skinFailed || !USE_BAKE) clearInterval(skinTimer); return; }
    const mesh = meshOf(me); if (!mesh) return;
    const src = mesh.material;
    if (!src || !src.map || !src.map.image) return;           // tekstur asli belum selesai dimuat
    clearInterval(skinTimer);
    try {
      const THREE = window.THREE, img = src.map.image;
      const S = img.naturalWidth || img.width;
      const cv = document.createElement('canvas'); cv.width = cv.height = S;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, S, S);
      const px = cx.getImageData(0, 0, S, S).data;
      const g = mesh.geometry;
      const colors = bakeVertexColors(g.attributes.position.array, g.attributes.uv.array, g.index ? g.index.array : null, px, S, SKIN_SMOOTH);
      const geo = g.clone();
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.0 });
      skin = { geo: geo, mat: mat };
      applySkinTo(me); party.forEach(applySkinTo);
    } catch (e) {
      skinFailed = true;
      console.warn('[LOBBY3D] bake warna gagal, memakai tekstur asli:', e);
    }
  }

  function layoutAll() {
    if (!renderer || !lobbyEl) return;
    const w = Math.max(1, lobbyEl.clientWidth), h = Math.max(1, lobbyEl.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, COARSE ? 1.75 : 2);
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
    aspect = w / h;
    // posisi lingkaran platform di layar (object-fit:cover, rata bawah)
    const sc = Math.max(w / RING.iw, h / RING.ih);
    const ox = (w - RING.iw * sc) / 2, oy = h - RING.ih * sc;
    const rcx = ox + RING.cx * sc, rcy = oy + RING.cy * sc;
    const feetFrac = Math.min(0.3, Math.max(0.05, 1 - rcy / h));    // kaki = tinggi lingkaran dari bawah layar
    camera.left = -aspect * VIEW_H / 2; camera.right = aspect * VIEW_H / 2;
    camera.top = VIEW_H * (1 - feetFrac); camera.bottom = -VIEW_H * feetFrac; camera.updateProjectionMatrix();
    mainWX = (rcx / w - 0.5) * aspect * VIEW_H;
    if (me) me.group.position.x = mainWX;
    party.forEach(r => { r.group.position.x = mainWX + r.off; });
    if (glow) glow.position.x = mainWX;
    // CSS (efek cahaya platform) memakai ukuran yang sama
    const st = lobbyEl.style;
    st.setProperty('--rx', rcx.toFixed(1) + 'px'); st.setProperty('--ry', rcy.toFixed(1) + 'px');
    st.setProperty('--rw', (RING.rw * sc).toFixed(1) + 'px'); st.setProperty('--rh', (RING.rh * sc).toFixed(1) + 'px');
  }

  function setParty(list) {
    partyDefs = Array.isArray(list) ? list.slice(0, 3) : [];
    if (ok) syncParty();
  }
  function syncParty() {
    const ids = new Set(partyDefs.map(p => String(p.id)));
    for (const [id, r] of party) { if (!ids.has(id)) { disposeAvatar(r); party.delete(id); } }
    partyDefs.forEach((p, i) => {
      const id = String(p.id);
      let r = party.get(id);
      if (!r) {
        const si = Math.min(i, SLOT_OFFS.length - 1), off = SLOT_OFFS[si];
        r = makeAvatar('lobby_' + id, p.nick || 'Player', off, true, off < 0 ? 0.3 : -0.3);
        if (!r) return;
        r.group.scale.setScalar(SLOT_SCALE[si]);
        party.set(id, r);
      }
      r.nickname = p.nick;
    });
  }

  /* ---------- API tambahan ---------- */
  function setWeapon(key) {
    if (!me) return false;
    if (!key) { me.target.unarmed = true; me.target.firing = false; return true; }
    if (typeof window.fbBuildRemoteWeapon !== 'function') return false;
    me.lobbyCtx.buildWeapon = weaponBuilder;
    me.target.weapon = String(key); me.target.unarmed = false;
    return true;
  }
  let punchTO = 0;
  function punch() {
    if (!me || !me.target.unarmed) return false;
    me.target.firing = true; clearTimeout(punchTO);
    punchTO = setTimeout(() => { if (me) me.target.firing = false; }, 600);
    return true;
  }
  function status() {
    return { ready: ok, bakedSkin: !!skin, bakeFailed: skinFailed, party: party.size, covered: covered, contextLost: ctxLost };
  }

  /* panel layar-penuh yang menutupi lobi -> tidak perlu merender */
  function checkCovered() {
    covered = !!document.querySelector('#vaultScreen.show,#eventScreen.show,#profileScreen.show');
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || ctxLost || covered || !lobbyEl || !lobbyEl.classList.contains('active')) { last = now; return; }
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    acc += dt; if (acc < FPS_STEP) return;
    const step = acc; acc = 0;
    if (me) { try { me.update(step, me.target); } catch (_) {} }
    party.forEach(r => { try { r.update(step, r.target); } catch (_) {} });
    renderer.render(scene, camera);
  }

  async function start() {
    if (started) return; started = true;
    lobbyEl = document.getElementById('lobby');
    if (!lobbyEl) { started = false; return; }
    if (!(await ensureThree())) { console.warn('[LOBBY3D] Three.js tidak termuat; memakai gambar lama.'); return; }
    if (!window.FB_BALD) { console.warn('[LOBBY3D] FB_BALD tidak ditemukan.'); return; }
    const THREE = window.THREE;
    try {
      canvas = document.createElement('canvas'); canvas.id = 'fbLobby3D';
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;display:block';
      const old = document.getElementById('lobbyChar');
      if (old && old.parentNode) old.parentNode.insertBefore(canvas, old.nextSibling); else lobbyEl.appendChild(canvas);
      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
      renderer.setClearColor(0x000000, 0);
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ctxLost = true; }, false);
      canvas.addEventListener('webglcontextrestored', () => { ctxLost = false; layoutAll(); }, false);
      scene = new THREE.Scene();
      camera = new THREE.OrthographicCamera(-1, 1, VIEW_H, 0, -20, 20);
      camera.position.set(0, 0, 8); camera.lookAt(0, 0, 0);
      // pencahayaan hanggar: key hangat dari depan-kiri, fill biru dari kanan, rim merah dari belakang, cahaya platform merah
      scene.add(new THREE.HemisphereLight(0xb9c6e6, 0x3a1418, 0.78));
      const key = new THREE.DirectionalLight(0xffe9d2, 1.15); key.position.set(-2.6, 4.2, 5.5); scene.add(key);
      const fill = new THREE.DirectionalLight(0x7fa6ff, 0.42); fill.position.set(4, 1.4, 4); scene.add(fill);
      const rimR = new THREE.DirectionalLight(0xff2a2a, 0.95); rimR.position.set(-4, 2.6, -3.5); scene.add(rimR);
      const rimW = new THREE.DirectionalLight(0xdfe8ff, 0.5); rimW.position.set(4.5, 3, -3); scene.add(rimW);
      glow = new THREE.PointLight(0xff2a20, 0.9, 2.4, 2); glow.position.set(0, 0.06, 0.7); scene.add(glow);
      layoutAll();
      me = makeAvatar('lobby_me', 'Kamu', 0, false, -0.12);
      if (!me) throw new Error('model bald_man gagal dibuat');
      ok = true;
      if (old) old.style.display = 'none';        // sembunyikan gambar skeleton lama
      syncParty();
      skinTimer = setInterval(prepareSkin, 150);   // tekstur dimuat async oleh FB_BALD
      setTimeout(() => { clearInterval(skinTimer); }, 15000);
      coverTimer = setInterval(checkCovered, 300);
      window.addEventListener('resize', layoutAll);
      window.addEventListener('orientationchange', () => setTimeout(layoutAll, 250));
      try { new ResizeObserver(layoutAll).observe(lobbyEl); } catch (_) {}
      document.addEventListener('visibilitychange', () => { last = performance.now(); });
      last = performance.now(); raf = requestAnimationFrame(frame);
    } catch (e) {
      console.warn('[LOBBY3D] gagal, memakai gambar lama:', e);
      try { if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas); } catch (_) {}
      try { clearInterval(skinTimer); clearInterval(coverTimer); } catch (_) {}
      const old = document.getElementById('lobbyChar'); if (old) old.style.display = '';
      ok = false;
    }
  }

  window.fbLobby3D = { setParty: setParty, isReady: () => ok, setWeapon: setWeapon, punch: punch, status: status };

  // mulai saat lobi pertama kali tampil (menghindari beban saat intro/loading)
  const watch = setInterval(() => {
    const l = document.getElementById('lobby');
    if (l && l.classList.contains('active')) { clearInterval(watch); start(); }
  }, 500);
})();
