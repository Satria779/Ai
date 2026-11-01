/* For Blood — CHAT GLOBAL (lobi, kiri bawah).
 *
 * Memakai klien Supabase + sesi anonim yang SAMA dengan MABAR (window.fbMabarEnsureClient, diekspor oleh
 * forblood-mabar.js) -> tidak ada klien/akun/kredensial baru. Backend: tabel `global_messages` dan RPC
 * `send_global_message` dari file supabase-global-chat.sql (jalankan sekali di Supabase SQL Editor).
 *
 *  - Riwayat 50 pesan terakhir, pesan baru lewat Realtime (postgres_changes); jika Realtime gagal -> polling 6 dtk.
 *  - Pesan ditampilkan sebagai TEKS (textContent), tidak pernah sebagai HTML.
 *  - Kirim: tombol KIRIM / Enter. Pesan kosong ditolak, maks 200 karakter, jeda 1,2 dtk (server juga membatasi).
 *  - Koneksi hanya aktif saat lobi tampil (otomatis putus saat match berjalan).
 *  - Semua listener dipasang SEKALI (guard), error ditampilkan jelas di panel dan tidak membuat panel macet.
 */
(function () {
  'use strict';
  if (window.fbGlobalChat) return;   // (bukan fbGChat: itu id elemen panel dan otomatis menjadi properti window)

  const MAX_LEN = 200, KEEP = 80, HISTORY = 50, POLL_MS = 6000, COOLDOWN_MS = 1200;
  const $ = (id) => document.getElementById(id);

  let strip, panel, log, input, sendBtn, statusEl, connEl, dotEl, stripText;
  let client = null, myUid = null, channel = null, pollTimer = 0, retryTimer = 0;
  let lastId = 0, seen = new Set(), started = false, connecting = false, isOpen = false, unread = 0;
  let lastSend = 0, sending = false, bound = false, subState = '', lastError = '', generation = 0;

  /* ---------- util ---------- */
  function nick() {
    let v = '';
    try { v = (window.PStore && PStore.getItem('fb_nickname')) || localStorage.getItem('fb_nickname') || ''; } catch (_) {}
    v = String(v).replace(/[^A-Za-z0-9_. -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    return v.length >= 2 ? v : 'Player';
  }
  function hhmm(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d)) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function errText(e) {
    const raw = String((e && (e.message || e.error_description || e.details)) || e || '');
    const up = raw.toUpperCase();
    if (up.includes('RATE_LIMITED')) return 'Terlalu cepat, tunggu sebentar.';
    if (up.includes('INVALID_MESSAGE')) return 'Pesan tidak valid (1–200 karakter).';
    if (up.includes('AUTH_REQUIRED')) return 'Belum masuk ke server chat. Coba lagi sebentar.';
    if (up.includes('ANONYMOUS PROVIDER IS DISABLED') || up.includes('ANONYMOUS SIGN-INS ARE DISABLED') || up.includes('SIGNUPS NOT ALLOWED')) {
      return 'Anonymous Sign-Ins belum aktif. Aktifkan di Supabase Auth settings.';
    }
    if (/PGRST|SCHEMA CACHE|DOES NOT EXIST|COULD NOT FIND|FUNCTION|RELATION/.test(up)) {
      return 'Chat global belum aktif di server. Jalankan supabase-global-chat.sql di Supabase SQL Editor.';
    }
    if (/failed to fetch|network|load failed|timeout/i.test(raw)) return 'Koneksi internet/Supabase gagal. Mencoba lagi…';
    return raw.slice(0, 160) || 'Terjadi kesalahan.';
  }
  function setStatus(msg, bad) {
    lastError = bad ? msg : '';
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = bad ? 'bad' : '';
  }
  function setConn(state) {   // online | poll | off
    if (connEl) { connEl.className = state; connEl.title = state === 'online' ? 'Realtime tersambung' : state === 'poll' ? 'Mode cadangan (polling)' : 'Tidak tersambung'; }
  }
  function setStrip(m) {
    if (!stripText) return;
    stripText.textContent = '';
    const tag = document.createElement('b'); tag.textContent = '[Global]';
    stripText.append(tag, document.createTextNode(' ' + (m ? m.nickname + ': ' + m.body : (lastError ? 'Chat belum aktif' : 'Belum ada pesan'))));
  }
  function nearBottom() { return !log || log.scrollHeight - log.clientHeight - log.scrollTop < 56; }
  function scrollEnd() { if (log) log.scrollTop = log.scrollHeight; }

  /* ---------- tampilan pesan ---------- */
  let lastMsg = null;
  function addMsg(m, quiet) {
    if (!m || m.id == null) return;
    const id = Number(m.id);
    if (seen.has(id)) return;
    seen.add(id); if (id > lastId) lastId = id;
    const stick = nearBottom() || m.user_id === myUid;
    const row = document.createElement('div');
    row.className = 'fbGRow' + (m.user_id && m.user_id === myUid ? ' me' : '');
    const t = document.createElement('span'); t.className = 't'; t.textContent = hhmm(m.created_at);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(m.nickname || 'Player').slice(0, 20);
    const b = document.createElement('span'); b.className = 'b'; b.textContent = String(m.body || '').slice(0, MAX_LEN);
    row.append(t, n, b);
    if (log) { log.append(row); while (log.children.length > KEEP) log.firstChild.remove(); if (stick) scrollEnd(); }
    lastMsg = { nickname: String(m.nickname || 'Player'), body: String(m.body || '') };
    setStrip(lastMsg);
    if (!quiet && !isOpen && m.user_id !== myUid) { unread++; if (dotEl) dotEl.classList.add('on'); }
  }
  function renderEmpty() {
    if (log && !log.children.length) {
      const e = document.createElement('div'); e.className = 'fbGEmpty'; e.id = 'fbGEmpty'; e.textContent = 'Belum ada pesan. Jadilah yang pertama!';
      log.append(e);
    }
  }
  function clearEmpty() { const e = $('fbGEmpty'); if (e) e.remove(); }

  /* ---------- koneksi ---------- */
  async function getClient() {
    for (let i = 0; i < 75 && typeof window.fbMabarEnsureClient !== 'function'; i++) await new Promise(r => setTimeout(r, 200));
    if (typeof window.fbMabarEnsureClient !== 'function') throw new Error('Modul koneksi (MABAR) belum termuat. Periksa internet lalu buka ulang.');
    const c = await window.fbMabarEnsureClient();
    try { const { data } = await c.auth.getSession(); myUid = data && data.session && data.session.user ? data.session.user.id : null; } catch (_) {}
    return c;
  }
  async function loadHistory() {
    const { data, error } = await client.from('global_messages').select('id,user_id,nickname,body,created_at').order('id', { ascending: false }).limit(HISTORY);
    if (error) throw error;
    clearEmpty();
    (data || []).slice().reverse().forEach(m => addMsg(m, true));
    if (!(data || []).length) renderEmpty();
    scrollEnd();
  }
  async function fetchNew() {
    if (!client) return;
    const { data, error } = await client.from('global_messages').select('id,user_id,nickname,body,created_at').gt('id', lastId).order('id', { ascending: true }).limit(50);
    if (error) throw error;
    if ((data || []).length) clearEmpty();
    (data || []).forEach(m => addMsg(m));
  }
  function subscribe(gen) {
    if (channel) { try { client.removeChannel(channel); } catch (_) {} channel = null; }
    channel = client.channel('fb-global-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'global_messages' }, (p) => { if (gen === generation && p && p.new) { clearEmpty(); addMsg(p.new); } })
      .subscribe((status) => {
        if (gen !== generation) return;
        subState = status;
        if (status === 'SUBSCRIBED') { setConn('online'); fetchNew().catch(() => {}); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setConn('poll');
      });
  }
  function startPoll(gen) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (gen !== generation || document.hidden) return;
      if (subState !== 'SUBSCRIBED') fetchNew().then(() => { if (!lastError) setStatus('', false); }, (e) => setStatus(errText(e), true));
    }, POLL_MS);
  }
  async function connect() {
    if (started || connecting) return;
    connecting = true; const gen = ++generation;
    setStatus('Menghubungkan…', false); setConn('off');
    try {
      client = await getClient();
      if (gen !== generation) return;
      await loadHistory();
      if (gen !== generation) return;
      subscribe(gen); startPoll(gen);
      started = true; retryTimer = 0; setStatus('', false);
    } catch (e) {
      if (gen !== generation) return;
      client = null; started = false;
      const msg = errText(e);
      setStatus(msg, true); setConn('off'); setStrip(lastMsg);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { retryTimer = 0; if (isLobbyActive()) connect(); }, /belum aktif/.test(msg) ? 30000 : 10000);
    } finally { connecting = false; }
  }
  function teardown() {
    generation++; started = false; connecting = false;
    clearInterval(pollTimer); clearTimeout(retryTimer); retryTimer = 0;
    if (channel && client) { try { client.removeChannel(channel); } catch (_) {} }
    channel = null; subState = ''; setConn('off');
  }
  function isLobbyActive() { const l = $('lobby'); return !!(l && l.classList.contains('active')); }

  /* ---------- kirim ---------- */
  async function send() {
    if (sending) return;
    const body = input.value.replace(/\s+/g, ' ').trim();
    if (!body) { input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake'); return; }
    const now = Date.now();
    if (now - lastSend < COOLDOWN_MS) { setStatus('Terlalu cepat, tunggu sebentar.', true); return; }
    if (!client) { setStatus('Belum tersambung ke server chat. Menghubungkan ulang…', true); connect(); return; }
    sending = true; sendBtn.disabled = true; sendBtn.textContent = '…';
    try {
      const { error } = await client.rpc('send_global_message', { p_nickname: nick(), p_body: body.slice(0, MAX_LEN) });
      if (error) throw error;
      lastSend = Date.now(); input.value = ''; setStatus('', false);
      clearEmpty();
      await fetchNew().catch(() => {});      // tampil segera walau Realtime lambat; addMsg menghindari duplikat
      scrollEnd();
    } catch (e) {
      setStatus(errText(e), true);            // teks tetap di input agar bisa dicoba lagi
    } finally {
      sending = false; sendBtn.disabled = false; sendBtn.textContent = 'KIRIM';
      try { input.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  /* ---------- buka / tutup ---------- */
  function open() {
    if (!panel) return;
    isOpen = true; unread = 0; if (dotEl) dotEl.classList.remove('on');
    panel.classList.add('open'); strip && strip.classList.add('on');
    if (!started && !connecting) connect();
    setTimeout(scrollEnd, 30);
    if (!(window.matchMedia && matchMedia('(pointer:coarse)').matches)) { try { input.focus({ preventScroll: true }); } catch (_) {} }
  }
  function close() {
    if (!panel) return;
    isOpen = false; panel.classList.remove('open'); strip && strip.classList.remove('on');
    try { input.blur(); } catch (_) {}
  }

  function init() {
    if (bound) return;
    strip = $('fbChatStrip'); panel = $('fbGChat'); log = $('fbGLog'); input = $('fbGInput'); sendBtn = $('fbGSend');
    statusEl = $('fbGStatus'); connEl = $('fbGConn'); dotEl = $('fbChatDot'); stripText = $('fbChatStripText');
    if (!strip || !panel || !log || !input || !sendBtn) return;
    bound = true;
    strip.addEventListener('click', () => (isOpen ? close() : open()));
    $('fbGClose').addEventListener('click', close);
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    // keyboard HP: naikkan panel setinggi keyboard agar input tidak tertutup
    const vv = window.visualViewport;
    if (vv) {
      const fit = () => {
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        panel.style.setProperty('--fbkb', kb + 'px'); panel.style.setProperty('--fbvh', vv.height + 'px');
        panel.classList.toggle('kb', kb > 80);
        if (kb && isOpen) setTimeout(scrollEnd, 50);
      };
      vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit);
    }
    setStrip(null); setConn('off');
    // sambungkan hanya saat lobi tampil; putus saat match
    setInterval(() => {
      const act = isLobbyActive();
      if (act && !started && !connecting && !retryTimer) connect();
      if (!act && (started || connecting)) { teardown(); close(); }
    }, 1000);
    setTimeout(() => { if (isLobbyActive() && !started && !connecting) connect(); }, 1200);
  }

  window.fbGlobalChat = {
    open: open, close: close,
    status: () => ({ bound: bound, connected: started, subscription: subState, open: isOpen, unread: unread, lastId: lastId, error: lastError, messages: seen.size })
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
