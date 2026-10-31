/* For Blood LOBBY 3D — karakter di lobi memakai model bald_man (FB_BALD, rig 65 tulang)
 * yang SAMA dengan avatar yang dilihat pemain lain di dalam game.
 * Anggota party (mabar) ikut tampil di samping karakter kamu, seperti lobi Free Fire.
 * Dimuat setelah script FB_BALD di index.html. Jika Three.js / model gagal dimuat,
 * gambar lama (#lobbyChar) tetap dipakai sebagai cadangan.
 */
(function () {
  'use strict';
  const THREE_URLS = [
    'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.min.js',
    'https://unpkg.com/three@0.152.2/build/three.min.js',
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/build/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.152.2/three.min.js'
  ];
  // Posisi karakter di layar (persen lebar) — pemain di tempat gambar lama, party di kiri/kanan
  const MAIN_X = 39.3;
  const SLOTS = [53.8, 24.8, 68.3];
  const VIEW_H = 1.8 / 0.7465;          // tinggi dunia yang terlihat: karakter 1.8m = 74.65% tinggi layar (sama dgn gambar lama)
  const FPS_STEP = 1 / 30;

  let renderer = null, scene = null, camera = null, canvas = null, lobbyEl = null;
  let me = null, partyDefs = [], party = new Map();
  let raf = 0, last = 0, acc = 0, started = false, ok = false, aspect = 16 / 9;

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
    gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    sp.scale.set(1.15, 0.34, 1); sp.position.set(0, 0.03, -0.3); sp.renderOrder = -1;
    return sp;
  }
  function worldX(pct) { return (pct / 100 - 0.5) * aspect * VIEW_H; }

  function makeAvatar(id, nick, slotPct, showName, turn) {
    const THREE = window.THREE;
    const ctx = { scene: scene, hitMeshes: [], buildWeapon: null, makeLabel: (n) => { const s = nameSprite(n); s.visible = showName; return s; }, depthAt: null };
    const r = window.FB_BALD && window.FB_BALD.create(THREE, id, nick, ctx);
    if (!r) return null;
    r.target.unarmed = true; r.target.alive = true; r.target.weapon = 'ak';
    r.slotPct = slotPct; r.turn = turn;
    r.group.position.set(worldX(slotPct), 0, 0);
    r.group.rotation.y = Math.PI + turn;       // hadap kamera (3/4)
    const sh = shadowSprite(); r.group.add(sh); r.shadow = sh;
    r.label.position.y = 2.28;
    return r;
  }
  function disposeAvatar(r) { try { if (r.shadow) { r.shadow.material.map.dispose(); r.shadow.material.dispose(); } r.dispose(); } catch (_) {} }

  function layoutAll() {
    if (!renderer || !lobbyEl) return;
    const w = Math.max(1, lobbyEl.clientWidth), h = Math.max(1, lobbyEl.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
    aspect = w / h;
    camera.left = -aspect * VIEW_H / 2; camera.right = aspect * VIEW_H / 2;
    camera.top = VIEW_H; camera.bottom = 0; camera.updateProjectionMatrix();
    if (me) me.group.position.x = worldX(MAIN_X);
    party.forEach(r => { r.group.position.x = worldX(r.slotPct); });
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
        const slot = SLOTS[i] !== undefined ? SLOTS[i] : SLOTS[SLOTS.length - 1];
        const left = slot < MAIN_X;
        r = makeAvatar('lobby_' + id, p.nick || 'Player', slot, true, left ? 0.32 : -0.32);
        if (!r) return;
        r.group.scale.setScalar(0.96);
        party.set(id, r);
      }
      r.nickname = p.nick;
    });
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !lobbyEl || !lobbyEl.classList.contains('active')) { last = now; return; }
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
      scene = new THREE.Scene();
      camera = new THREE.OrthographicCamera(-1, 1, VIEW_H, 0, -20, 20);
      camera.position.set(0, 0, 8); camera.lookAt(0, 0, 0);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5566, 1.05));
      const sun = new THREE.DirectionalLight(0xfff1e0, 1.25); sun.position.set(-3, 4, 6); scene.add(sun);
      const rim = new THREE.DirectionalLight(0x9fc4ff, .55); rim.position.set(4, 2, -3); scene.add(rim);
      layoutAll();
      me = makeAvatar('lobby_me', 'Kamu', MAIN_X, false, -0.28);
      if (!me) throw new Error('model bald_man gagal dibuat');
      ok = true;
      if (old) old.style.display = 'none';        // sembunyikan gambar skeleton lama
      syncParty();
      window.addEventListener('resize', layoutAll);
      window.addEventListener('orientationchange', () => setTimeout(layoutAll, 250));
      try { new ResizeObserver(layoutAll).observe(lobbyEl); } catch (_) {}
      document.addEventListener('visibilitychange', () => { last = performance.now(); });
      last = performance.now(); raf = requestAnimationFrame(frame);
    } catch (e) {
      console.warn('[LOBBY3D] gagal, memakai gambar lama:', e);
      try { if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas); } catch (_) {}
      const old = document.getElementById('lobbyChar'); if (old) old.style.display = '';
      ok = false;
    }
  }

  window.fbLobby3D = { setParty: setParty, isReady: () => ok };

  // mulai saat lobi pertama kali tampil (menghindari beban saat intro/loading)
  const watch = setInterval(() => {
    const l = document.getElementById('lobby');
    if (l && l.classList.contains('active')) { clearInterval(watch); start(); }
  }, 500);
})();
