/* For Blood — PANEL TEMAN di lobi (kanan), gaya Free Fire.
 *
 * Tidak membuat sistem baru: semua data & aksi memakai sistem sosial yang SUDAH ada di forblood-mabar.js
 * lewat window.fbMabarBridge (RPC: list_mabar_friends, search_mabar_profiles, send_friend_request,
 * respond_friend_request, remove_friend, invite_mabar_friend + room/party mabar, presence touch_mabar_profile).
 * Validasi identitas, batas party (4), undangan tidak valid, dsb. tetap dijaga server (supabase-friends.sql / supabase-mabar.sql).
 *
 *  - Tab TEMAN: daftar teman + status ONLINE / DALAM LOBBY (sedang di party-mu) / OFFLINE, filter nama/ID, hasil cari pemain server (+ tambah).
 *  - Tab PERMINTAAN: masuk (TERIMA/TOLAK) dan terkirim (BATAL).
 *  - Tab RIWAYAT: pemain yang pernah satu party denganmu (tersimpan di perangkat ini), bisa langsung ditambah.
 *  - Tombol +: undang teman itu. UNDANG: undang semua teman online yang dipilih. TIM n/4: buka lobi party (panel MABAR lama).
 *  - Notifikasi: teman bergabung / keluar dari party, hasil aksi (dari event fb-mabar-notice).
 */
(function () {
  'use strict';
  if (window.fbFriendsUI) return;
  const MAX_PARTY = 4, RECENT_KEY = 'fb_recent_players', RECENT_MAX = 30;
  const $ = (id) => document.getElementById(id);
  const B = () => window.fbMabarBridge || null;

  let panel, listEl, countEl, searchEl, teamBtn, inviteBtn, friendBtn, friendDot;
  let tab = 'friends', isOpen = false, bound = false, sel = new Set();
  let srv = { q: '', rows: [], busy: false, err: '' }, srvTimer = 0, srvSeq = 0;
  let prevPlayers = null, busyIds = new Set();
  let board = { rows: [], busy: false, err: '', t: 0 };

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function toast(msg, bad) { if (typeof window.fbLobbyToast === 'function') window.fbLobbyToast((bad ? '⚠ ' : '') + msg); }

  /* ---------- data ---------- */
  function friendsAll() { const b = B(); return b ? (b.friends() || []) : []; }
  function roomIds() {
    const b = B(); if (!b) return new Set();
    const r = b.room(); if (!r || r.status === 'closed') return new Set();
    return new Set((b.players() || []).map(p => p.user_id));
  }
  function partyCount() { const b = B(); if (!b) return 1; const r = b.room(); return r && r.status !== 'closed' ? Math.max(1, (b.players() || []).length) : 1; }
  function statusOf(f, inRoom) { return inRoom.has(f.user_id) ? 'lobby' : (f.online ? 'online' : 'off'); }
  const STATUS_TXT = { online: 'Online', lobby: 'Dalam Lobby', off: 'Offline' };
  function badgeUrl(tier) { try { return window.fbRank && window.fbRank.badge ? window.fbRank.badge(tier | 0) : ''; } catch (_) { return ''; } }

  function loadRecent() { try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function saveRecent(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (_) {} }
  function rememberPlayers(players, me) {
    const cur = loadRecent();
    players.forEach(p => {
      if (!p || !p.user_id || p.user_id === me) return;
      const i = cur.findIndex(x => x.user_id === p.user_id);
      const rec = { user_id: p.user_id, nickname: String(p.nickname || 'Player').slice(0, 20), ts: Date.now() };
      if (i >= 0) cur.splice(i, 1);
      cur.unshift(rec);
    });
    saveRecent(cur);
  }

  /* ---------- baris ---------- */
  function avatar(f) {
    const a = el('div', 'fbFAv');
    const url = badgeUrl(f.rank_tier);
    if (url) { const im = el('img'); im.alt = ''; im.src = url; a.append(im); }
    else a.textContent = String(f.nickname || '?').trim().charAt(0).toUpperCase() || '?';
    return a;
  }
  function mkBtn(cls, label, title, fn) {
    const b = el('button', cls, label); b.type = 'button'; if (title) { b.title = title; b.setAttribute('aria-label', title); }
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
    return b;
  }
  function baseRow(f, status, sub) {
    const r = el('div', 'fbFRow' + (status ? ' ' + status : ''));
    r.setAttribute('role', 'listitem');
    r.append(avatar(f));
    const mid = el('div', 'fbFMid');
    const nm = el('div', 'fbFName'); nm.append(el('span', 'fbFNm', f.nickname || 'Player'));
    const st = el('div', 'fbFSt' + (status ? ' ' + status : ''));
    if (status) { st.append(el('span', 'fbFS', STATUS_TXT[status] || '')); if (sub) st.append(el('span', 'fbFId', sub)); }
    else st.append(el('span', 'fbFS', sub || ''));
    mid.append(nm, st); r.append(mid);
    return r;
  }

  function friendRow(f, inRoom) {
    const status = statusOf(f, inRoom);
    const r = baseRow(f, status, f.pid ? 'ID ' + f.pid : '');
    if (sel.has(f.user_id)) r.classList.add('sel');
    const canInvite = status === 'online';
    if (canInvite) { r.classList.add('pick'); r.addEventListener('click', () => { sel.has(f.user_id) ? sel.delete(f.user_id) : sel.add(f.user_id); render(); }); }
    const plus = mkBtn('fbFPlus', '+', canInvite ? 'Undang ' + f.nickname : (status === 'lobby' ? 'Sudah di tim' : 'Teman sedang offline'), () => inviteOne(f));
    plus.disabled = !canInvite || busyIds.has(f.user_id);
    const rm = mkBtn('fbFDel', '✕', 'Hapus teman', () => removeFriend(f));
    r.append(plus, rm);
    return r;
  }

  function section(t) { return el('div', 'fbFSec', t); }
  function empty(t) { return el('div', 'fbFEmpty', t); }

  /* ---------- render ---------- */
  function render() {
    if (!panel) return;
    const b = B();
    const reqIn = friendsAll().filter(f => f.status === 'pending' && f.incoming).length;
    const unread = friendsAll().reduce((s, f) => s + (f.status === 'accepted' ? (f.unread | 0) : 0), 0);
    if (friendDot) { const n = reqIn + unread; friendDot.classList.toggle('on', n > 0); friendDot.textContent = n > 9 ? '9+' : (n ? String(n) : ''); }
    const rd = $('fbFReqDot'); if (rd) { rd.classList.toggle('on', reqIn > 0); rd.textContent = reqIn > 9 ? '9+' : (reqIn ? String(reqIn) : ''); }
    if (teamBtn) teamBtn.querySelector('b').textContent = 'TIM ' + partyCount() + '/' + MAX_PARTY;
    try { renderRail(); } catch (_) {}
    panel.querySelectorAll('.fbFTabs button').forEach(t => { const on = t.dataset.t === tab; t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    if (!isOpen) return;
    const keepScroll = listEl.scrollTop;
    listEl.replaceChildren();
    if (!b) { countEl.textContent = ''; listEl.append(empty('Menghubungkan ke server…')); return; }
    const err = b.error ? b.error() : '';
    if (err) { countEl.textContent = ''; listEl.append(empty(err)); return; }
    const q = (searchEl.value || '').trim().toLowerCase();
    const inRoom = roomIds();
    if (tab === 'friends') {
      const all = friendsAll().filter(f => f.status === 'accepted');
      const online = all.filter(f => f.online).length;
      countEl.textContent = online + ' ONLINE / ' + all.length + ' TEMAN';
      const rank = (f) => (inRoom.has(f.user_id) ? 0 : f.online ? 1 : 2);
      const rows = all.filter(f => !q || String(f.nickname).toLowerCase().includes(q) || String(f.pid || '').includes(q))
        .sort((a, c) => rank(a) - rank(c) || String(a.nickname).localeCompare(String(c.nickname)));
      if (!all.length && !q) listEl.append(empty('Belum ada teman. Ketik nama atau ID (8 digit) pemain di kolom cari lalu tekan Enter.'));
      rows.forEach(f => listEl.append(friendRow(f, inRoom)));
      if (q.length >= 2) {
        listEl.append(section('CARI PEMAIN'));
        if (srv.busy && srv.q === q) listEl.append(empty('Mencari…'));
        else if (srv.q === q && srv.err) listEl.append(empty(srv.err));
        else if (srv.q === q) {
          if (!srv.rows.length) listEl.append(empty('Tidak ada pemain dengan nama/ID itu.'));
          srv.rows.forEach(p => listEl.append(searchRow(p)));
        } else listEl.append(empty('Tekan Enter untuk mencari “' + searchEl.value.trim() + '” di server.'));
      }
    } else if (tab === 'board') {
      const rowsAll = board.rows || [];
      countEl.textContent = board.busy ? 'MEMUAT…' : rowsAll.length + ' PEMAIN DI PERINGKAT';
      if (board.busy && !rowsAll.length) listEl.append(empty('Memuat peringkat…'));
      else if (board.err && !rowsAll.length) listEl.append(empty(board.err));
      else {
        const shown = rowsAll.map((r, i) => ({ r: r, i: i })).filter(x => !q || String(x.r.nick || '').toLowerCase().includes(q)).slice(0, 80);
        if (!shown.length) listEl.append(empty(q ? 'Tidak ada pemain peringkat dengan nama itu.' : 'Belum ada pemain di peringkat.'));
        shown.forEach(x => {
          const r = baseRow({ nickname: x.r.nick || 'Player' }, '', '#' + (x.i + 1) + ' \u2022 LV ' + (x.r.level || 1) + ' \u2022 ' + (x.r.season || 0) + ' poin');
          r.append(mkBtn('fbFPlus', '+', 'Tambah teman', (btn) => addFromBoard(x.r, btn)));
          listEl.append(r);
        });
      }
    } else if (tab === 'requests') {
      const inc = friendsAll().filter(f => f.status === 'pending' && f.incoming);
      const out = friendsAll().filter(f => f.status === 'pending' && !f.incoming);
      countEl.textContent = inc.length + ' MASUK / ' + out.length + ' TERKIRIM';
      if (!inc.length && !out.length) listEl.append(empty('Tidak ada permintaan pertemanan.'));
      if (inc.length) listEl.append(section('PERMINTAAN MASUK'));
      inc.forEach(f => { const r = baseRow(f, '', f.pid ? 'ID ' + f.pid : ''); r.append(mkBtn('fbFOk', '✓', 'Terima', () => answer(f, true)), mkBtn('fbFNo', '✕', 'Tolak', () => answer(f, false))); listEl.append(r); });
      if (out.length) listEl.append(section('TERKIRIM'));
      out.forEach(f => { const r = baseRow(f, '', 'Menunggu…'); r.append(mkBtn('fbFDel', 'BATAL', 'Batalkan permintaan', () => cancelReq(f))); listEl.append(r); });
    } else {
      const rec = loadRecent();
      countEl.textContent = rec.length + ' PEMAIN TERAKHIR';
      if (!rec.length) listEl.append(empty('Belum ada riwayat. Pemain yang pernah satu tim denganmu muncul di sini.'));
      rec.forEach(p => {
        const fr = friendsAll().find(f => f.user_id === p.user_id);
        const r = baseRow({ nickname: p.nickname }, '', fr ? (fr.status === 'accepted' ? 'Teman' : 'Permintaan tertunda') : 'Satu tim');
        if (!fr) r.append(mkBtn('fbFPlus', '+', 'Tambah teman', (btn) => addById(p.user_id, p.nickname, btn)));
        listEl.append(r);
      });
    }
    listEl.scrollTop = keepScroll;
  }

  function searchRow(p) {
    const r = baseRow(p, '', p.pid ? 'ID ' + p.pid : '');
    const btn = mkBtn('fbFPlus', '+', 'Kirim permintaan teman', (b) => addById(p.user_id, p.nickname, b));
    if (p.relation === 'friend') { btn.textContent = '✓'; btn.disabled = true; btn.title = 'Sudah berteman'; }
    else if (p.relation === 'sent') { btn.textContent = '…'; btn.disabled = true; btn.title = 'Menunggu persetujuan'; }
    else if (p.relation === 'received') { btn.textContent = '✓'; btn.title = 'Terima permintaan'; btn.onclick = null; btn.addEventListener('click', (e) => { e.stopPropagation(); addById(p.user_id, p.nickname, btn); }); }
    r.append(btn);
    return r;
  }

  /* ---------- aksi (memakai fungsi lama) ---------- */
  async function searchServer(q) {
    const b = B(); if (!b || q.length < 2) return;
    const my = ++srvSeq; srv = { q: q, rows: [], busy: true, err: '' }; render();
    try {
      await b.ensureSocial();
      const { data, error } = await b.rpc('search_mabar_profiles', { p_query: q });
      if (error) throw error;
      if (my !== srvSeq) return;
      srv = { q: q, rows: data || [], busy: false, err: '' };
    } catch (e) {
      if (my !== srvSeq) return;
      srv = { q: q, rows: [], busy: false, err: errMsg(e) };
    }
    render();
  }
  function errMsg(e) {
    const m = String((e && (e.message || e.details)) || e || '');
    if (/search_mabar_profiles|PGRST|schema cache|does not exist/i.test(m)) return 'Sistem teman belum aktif di server. Jalankan supabase-friends.sql di Supabase SQL Editor.';
    if (/failed to fetch|network/i.test(m)) return 'Koneksi gagal. Coba lagi.';
    return m.slice(0, 140) || 'Terjadi kesalahan.';
  }
  async function addById(uid, nick, btn) {
    const b = B(); if (!b) return;
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await b.rpc('send_friend_request', { p_target: uid });
      if (error) throw error;
      if (data === 'accepted' || data === 'already_friends') toast((nick || 'Pemain') + ' sekarang temanmu.');
      else toast('Permintaan dikirim ke ' + (nick || 'pemain') + '.');
      if (btn) { btn.textContent = data === 'accepted' || data === 'already_friends' ? '✓' : '…'; }
      await b.refresh(true).catch(() => {});
      if (srv.q) { const row = srv.rows.find(x => x.user_id === uid); if (row) row.relation = (data === 'accepted' || data === 'already_friends') ? 'friend' : 'sent'; }
    } catch (e) { if (btn) btn.disabled = false; toast(errMsg(e), true); }
    render();
  }
  function loadBoard() {
    if (typeof window.fbBoardRows !== 'function') { board = { rows: [], busy: false, err: 'Peringkat belum siap.', t: 0 }; render(); return; }
    if (board.busy || (board.rows.length && Date.now() - board.t < 60000)) return;
    board.busy = true; board.err = ''; render();
    window.fbBoardRows().then(rows => { board = { rows: rows || [], busy: false, err: '', t: Date.now() }; render(); },
      e => { board = { rows: board.rows, busy: false, err: 'Gagal memuat peringkat: ' + String((e && e.message) || e).slice(0, 80), t: 0 }; render(); });
  }
  async function addFromBoard(row, btn) {
    const b = B(); if (!b) return;
    if (btn) btn.disabled = true;
    try {
      await b.ensureSocial();
      const { data, error } = await b.rpc('search_mabar_profiles', { p_query: String(row.nick || '') });
      if (error) throw error;
      const nk = String(row.nick || '').toLowerCase();
      const m = (data || []).filter(p => String(p.nickname || '').toLowerCase() === nk);
      if (!m.length) { toast('\u201c' + row.nick + '\u201d belum terdaftar di sistem teman.', true); if (btn) btn.disabled = false; return; }
      if (m.length > 1) { searchEl.value = String(row.nick); tab = 'friends'; searchServer(nk); toast('Ada beberapa pemain bernama sama. Pilih dari hasil cari.'); return; }
      const p = m[0];
      if (p.relation === 'friend') { toast(p.nickname + ' sudah temanmu.'); if (btn) { btn.textContent = 'OK'; } return; }
      if (p.relation === 'sent') { toast('Permintaan ke ' + p.nickname + ' masih menunggu.'); if (btn) btn.textContent = '\u2026'; return; }
      await addById(p.user_id, p.nickname, btn);
    } catch (e) { if (btn) btn.disabled = false; toast(errMsg(e), true); }
  }
  async function answer(f, ok) { const b = B(); if (b) { await b.answer(f, ok).catch(() => {}); render(); } }
  async function cancelReq(f) {
    const b = B(); if (!b) return;
    try { const { error } = await b.rpc('remove_friend', { p_other: f.user_id }); if (error) throw error; toast('Permintaan dibatalkan.'); await b.refresh(true).catch(() => {}); } catch (e) { toast(errMsg(e), true); }
    render();
  }
  async function removeFriend(f) { const b = B(); if (b) { await b.remove(f, false).catch(() => {}); sel.delete(f.user_id); render(); } }
  async function inviteOne(f) {
    const b = B(); if (!b) return;
    if (partyCount() >= MAX_PARTY) { toast('Tim penuh (maks ' + MAX_PARTY + ').', true); return; }
    if (b.inMatch && b.inMatch()) { toast('Sedang dalam pertandingan.', true); return; }
    busyIds.add(f.user_id); render();
    try { await b.invite(f); } finally { busyIds.delete(f.user_id); render(); }
  }
  async function inviteSelected() {
    const b = B(); if (!b) return;
    const inRoom = roomIds();
    const targets = friendsAll().filter(f => f.status === 'accepted' && sel.has(f.user_id) && f.online && !inRoom.has(f.user_id));
    if (!targets.length) { toast('Pilih teman yang ONLINE dulu (ketuk barisnya).', true); return; }
    const free = MAX_PARTY - partyCount();
    if (free <= 0) { toast('Tim penuh (maks ' + MAX_PARTY + ').', true); return; }
    const list = targets.slice(0, free);
    if (targets.length > free) toast('Slot tim hanya ' + free + ' lagi; sisanya tidak diundang.', true);
    inviteBtn.disabled = true;
    try { for (const f of list) { await b.invite(f); sel.delete(f.user_id); } } finally { inviteBtn.disabled = false; render(); }
  }

  /* ---------- notifikasi party (bergabung / keluar) ---------- */
  function watchParty() {
    const b = B(); if (!b) return;
    const r = b.room(), me = b.me();
    const cur = (r && r.status !== 'closed') ? (b.players() || []) : [];
    const map = new Map(cur.map(p => [p.user_id, p.nickname]));
    if (prevPlayers) {
      map.forEach((n, id) => { if (!prevPlayers.has(id) && id !== me) toast(n + ' bergabung ke tim.'); });
      prevPlayers.forEach((n, id) => { if (!map.has(id) && id !== me) toast(n + ' keluar dari tim.'); });
    }
    if (cur.length > 1) rememberPlayers(cur, me);
    prevPlayers = map;
  }

  /* ---------- daftar teman online di kanan + bar TIM (ala Free Fire) ---------- */
  const RAIL_MAX = 4;
  let railEl = null, railBox = null, railTab = null, teamBar = null, railOpen = true;
  const AVC = ['#c0392b', '#2e86de', '#27ae60', '#8e44ad', '#d68910', '#16a085'];
  const SV_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path style="fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round" d="M12 4.5v15M4.5 12h15"/></svg>';
  const SV_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path style="fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const SV_CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path style="fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round" d="M15 5l-7 7 7 7"/></svg>';
  const SV_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path style="fill:currentColor;stroke:none" d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg>';
  function hueOf(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return AVC[Math.abs(h) % AVC.length]; }
  function setRailOpen(v) {
    railOpen = !!v;
    if (railEl) railEl.classList.toggle('c', !railOpen);
    if (railTab) railTab.classList.toggle('on', !railOpen);
  }
  function ensureRail() {
    if (railEl) return;
    const st = el('style');
    st.textContent =
      '#fbRail{position:fixed;right:calc(env(safe-area-inset-right) + .6vh);top:13vh;width:19vh;z-index:40;display:flex;flex-direction:column;align-items:stretch;gap:1vh;transition:transform .25s ease;font-family:Arial,sans-serif}' +
      '#fbRail.c{transform:translateX(125%)}' +
      '#fbRail .rr{display:flex;align-items:flex-start;justify-content:flex-end;gap:1vh}' +
      '#fbRail .rc{display:flex;flex-direction:column;align-items:center;width:10.4vh;min-width:0}' +
      '#fbRail .rv{width:8.4vh;height:8.4vh;border:.35vh solid #f3efe4;box-shadow:0 .4vh 1vh #000a;display:flex;align-items:center;justify-content:center;color:#fff;font:700 4vh Arial,sans-serif;overflow:hidden;position:relative}' +
      '#fbRail .rv img{width:100%;height:100%;object-fit:contain}' +
      '#fbRail .rr.tm .rv{border-color:#ffdf75}' +
      '#fbRail .rn{width:100%;margin-top:.4vh;text-align:center;color:#fff;font:600 2.1vh Arial,sans-serif;text-shadow:0 1px 3px #000,0 0 6px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#fbRail .rp,#fbRail .rk{flex:none;width:6vh;height:6vh;margin-top:1.2vh;display:flex;align-items:center;justify-content:center;color:#fff;background:none;border:0;padding:0;filter:drop-shadow(0 1px 3px #000)}' +
      '#fbRail .rp svg,#fbRail .rk svg{width:5.4vh;height:5.4vh}' +
      '#fbRail .rk{color:#7dff9c}' +
      '#fbRail .rp:disabled{opacity:.35}' +
      '#fbRail .ra{align-self:flex-end;width:11vh;height:5.6vh;margin-top:.4vh;display:flex;align-items:center;justify-content:center;color:#fff;background:rgba(10,11,16,.78);border:1px solid rgba(255,255,255,.28);padding:0}' +
      '#fbRail .ra svg{width:4vh;height:4vh}' +
      '#fbRailTab{position:fixed;right:0;top:13vh;z-index:40;width:4.6vh;height:9vh;display:none;align-items:center;justify-content:center;color:#fff;background:rgba(10,11,16,.82);border:1px solid rgba(255,255,255,.28);border-right:0;padding:0}' +
      '#fbRailTab.on{display:flex}#fbRailTab svg{width:3.4vh;height:3.4vh}' +
      '#fbTeamBar{position:fixed;left:calc(env(safe-area-inset-left) + 1.5vh);top:13vh;z-index:40;height:5.8vh;min-width:24vh;display:flex;align-items:center;gap:1.2vh;padding:0 1.4vh;color:#fff;border:0;border-left:.5vh solid #e11d2e;background:linear-gradient(90deg,rgba(14,16,28,.92),rgba(14,16,28,.7));font:700 2.6vh Arial,sans-serif;letter-spacing:.06em;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}' +
      '#fbTeamBar span{margin-left:auto;font-size:2.3vh;opacity:.85}#fbTeamBar em{font-style:normal;font-size:2vh;color:#ffdf75;letter-spacing:.1em}' +
      '#fbTeamBar svg{width:3.4vh;height:3.4vh;color:#9aa3b8;flex:none}';
    document.head.append(st);
    railEl = el('div'); railEl.id = 'fbRail'; railEl.setAttribute('aria-label', 'Teman online');
    railBox = el('div'); railBox.style.cssText = 'display:flex;flex-direction:column;gap:1vh';
    const arrow = el('button', 'ra'); arrow.type = 'button'; arrow.setAttribute('aria-label', 'Sembunyikan daftar teman'); arrow.innerHTML = SV_CHEV; arrow.style.transform = 'scaleX(-1)';
    arrow.addEventListener('click', () => setRailOpen(false));
    railEl.append(railBox, arrow);
    railTab = el('button'); railTab.id = 'fbRailTab'; railTab.type = 'button'; railTab.setAttribute('aria-label', 'Tampilkan daftar teman'); railTab.innerHTML = SV_CHEV;
    railTab.addEventListener('click', () => setRailOpen(true));
    teamBar = el('button'); teamBar.id = 'fbTeamBar'; teamBar.type = 'button'; teamBar.setAttribute('aria-label', 'Tim');
    teamBar.addEventListener('click', () => { const b = B(); if (b) b.openPanel(); else toast('Sistem tim belum siap.', true); });
    document.body.append(railEl, railTab, teamBar);
  }
  function renderRail() {
    ensureRail();
    const l = $('lobby'), show = !!(l && l.classList.contains('active'));
    railEl.style.display = show ? '' : 'none'; teamBar.style.display = show ? '' : 'none';
    if (!show) { railTab.style.display = 'none'; return; }
    railTab.style.display = '';
    const b = B();
    let code = '';
    try { const r = b && b.room(); if (r && r.status !== 'closed') code = r.code || ''; } catch (_) {}
    teamBar.innerHTML = '<b>TIM</b>' + (code ? '<em>' + code + '</em>' : '') + '<span>' + partyCount() + '/' + MAX_PARTY + '</span>' + SV_STAR;
    const inRoom = roomIds();
    const me = b && b.me ? b.me() : '';
    const members = ((b && b.players && b.room() && b.room().status !== 'closed') ? (b.players() || []) : []).filter(p => p && p.user_id !== me).map(p => ({ user_id: p.user_id, nickname: p.nickname || 'Player', rank_tier: p.rank_tier, team: true }));
    const online = friendsAll().filter(f => f.status === 'accepted' && f.online && !inRoom.has(f.user_id)).sort((a, c) => String(a.nickname).localeCompare(String(c.nickname)));
    const rows = members.concat(online).slice(0, RAIL_MAX);
    railBox.replaceChildren();
    rows.forEach(f => {
      const r = el('div', 'rr' + (f.team ? ' tm' : ''));
      const col = el('div', 'rc'), av = el('div', 'rv');
      const url = badgeUrl(f.rank_tier);
      if (url) { const im = el('img'); im.alt = ''; im.src = url; av.append(im); av.style.background = '#1b1f2b'; }
      else { av.style.background = hueOf(f.nickname); av.textContent = String(f.nickname || '?').trim().charAt(0).toUpperCase() || '?'; }
      col.append(av, el('div', 'rn', f.nickname || 'Player'));
      let act;
      if (f.team) { act = el('span', 'rk'); act.innerHTML = SV_OK; }
      else {
        act = el('button', 'rp'); act.type = 'button'; act.setAttribute('aria-label', 'Undang ' + f.nickname); act.innerHTML = SV_PLUS;
        act.disabled = busyIds.has(f.user_id);
        act.addEventListener('click', (e) => { e.stopPropagation(); inviteOne(f); });
      }
      r.append(col, act); railBox.append(r);
    });
    railEl.classList.toggle('c', !railOpen);
  }

  /* ---------- buka / tutup ---------- */
  function open() {
    if (!panel) return;
    isOpen = true; panel.classList.add('open'); friendBtn && friendBtn.classList.add('on');
    const b = B();
    if (b) { b.ensureSocial().then(() => b.refresh(true)).catch(() => {}).then(render); }
    render();
  }
  function close() { if (!panel) return; isOpen = false; panel.classList.remove('open'); friendBtn && friendBtn.classList.remove('on'); try { searchEl.blur(); } catch (_) {} }

  function init() {
    if (bound) return;
    panel = $('fbFriends'); listEl = $('fbFList'); countEl = $('fbFCount'); searchEl = $('fbFSearch');
    teamBtn = $('fbFTeam'); inviteBtn = $('fbFInvite'); friendBtn = $('lbFriend');
    if (!panel || !listEl || !searchEl || !friendBtn) return;
    bound = true;
    // satu-satunya pendengar klik ikon teman: ganti perilaku lama (membuka panel MABAR) dengan panel di kanan
    friendBtn.addEventListener('click', (e) => { e.stopImmediatePropagation(); isOpen ? close() : open(); }, true);
    if (!friendBtn.querySelector('.fbFDot')) { friendDot = el('i', 'fbFDot'); friendBtn.append(friendDot); } else friendDot = friendBtn.querySelector('.fbFDot');
    panel.querySelectorAll('.fbFTabs button').forEach(t => t.addEventListener('click', () => { tab = t.dataset.t; if (tab === 'board') loadBoard(); render(); listEl.scrollTop = 0; }));
    $('fbFClose').addEventListener('click', close);
    inviteBtn.addEventListener('click', inviteSelected);
    teamBtn.addEventListener('click', () => { const b = B(); if (b) b.openPanel(); else toast('Sistem tim belum siap.', true); });
    searchEl.addEventListener('input', () => { clearTimeout(srvTimer); if (tab !== 'friends' && tab !== 'board') { tab = 'friends'; } render(); const q = searchEl.value.trim().toLowerCase(); if (q.length >= 2) srvTimer = setTimeout(() => searchServer(q), 700); });
    searchEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); clearTimeout(srvTimer); const q = searchEl.value.trim().toLowerCase(); if (q.length >= 2) searchServer(q); else toast('Ketik minimal 2 huruf nama atau 8 digit ID.', true); } else if (e.key === 'Escape') close(); });
    searchEl.addEventListener('keyup', (e) => e.stopPropagation());
    window.addEventListener('fb-social', () => { watchParty(); render(); });
    window.addEventListener('fb-mabar-notice', (e) => { const d = e && e.detail; if (d && d.message && (isOpen || d.isError)) toast(d.message, d.isError); });
    setInterval(() => { try { renderRail(); } catch (_) {} }, 1500);
    // tutup saat match dimulai (lobi tidak tampil)
    setInterval(() => { const l = $('lobby'); if (isOpen && !(l && l.classList.contains('active'))) close(); }, 1000);
    render();
  }

  window.fbFriendsUI = { open: open, close: close, status: () => ({ bound: bound, open: isOpen, tab: tab, selected: sel.size, party: partyCount() }) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
