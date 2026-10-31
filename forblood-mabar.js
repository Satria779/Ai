/* For Blood MABAR module: independent Supabase client + lobby/match synchronization.
 * Uses only the public anon key. All database writes go through guarded SQL RPCs.
 */
(() => {
  'use strict';

  const FB_MABAR_SUPABASE_URL = 'https://ykehmcypbzgagyhzxuub.supabase.co';
  const FB_MABAR_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrZWhtY3lwYnpnYWd5aHp4dXViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1ODg3MDcsImV4cCI6MjEwODE2NDcwN30.4mHPDokUh5zJaLUCnGadVrjozflJSKHM-ZdsTIuVRcU';
  const SDK_URL = 'https://esm.sh/@supabase/supabase-js@2';
  const ROOM_PREFIX = 'mabar:';
  const STATE_STALE_MS = 4500;
  const ONLINE_STALE_MS = 45000;
  const te = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  let mabarClient = null;
  let authUser = null;
  let currentRoom = null;
  let roomPlayers = [];
  let dbChannel = null;
  let playerChannels = new Map();
  let stateByUser = new Map();
  let heartbeatTimer = null;
  let gameTimer = null;
  let staleTimer = null;
  let matchStarted = false;
  let matchStarting = false;
  let panel = null;
  let statusEl = null;
  let roomView = null;
  let homeView = null;
  let playerList = null;
  let chatLog = null;
  let chatInput = null;
  let readyButton = null;
  let startButton = null;
  let closeRoomButton = null;
  let leaveButton = null;
  let copyButton = null;
  let roomCodeLabel = null;
  let ownChannel = null;
  let startWrapOriginal = null;
  let lastErrorToast = '';

  // Explicitly expose the requested separate configuration/client names for inspection.
  window.FB_MABAR_SUPABASE_URL = FB_MABAR_SUPABASE_URL;
  window.FB_MABAR_SUPABASE_KEY = FB_MABAR_SUPABASE_KEY; // Public anon key, never a service_role key.
  Object.defineProperty(window, 'mabarClient', { configurable: true, get: () => mabarClient });

  function nickname() {
    let value = '';
    try { value = (window.PStore && PStore.getItem('fb_nickname')) || localStorage.getItem('fb_nickname') || ''; } catch (_) {}
    // Keep the existing nickname as the displayed identity; sanitize only to fit the DB contract.
    value = String(value).replace(/[^A-Za-z0-9_. -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    return value.length >= 2 ? value : 'Player';
  }

  function showNotice(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('error', !!isError);
    if (isError) lastErrorToast = String(message);
  }

  function errorMessage(error) {
    const raw = String((error && (error.message || error.details || error.hint)) || error || 'Gagal terhubung');
    const code = raw.toUpperCase();
    if (code.includes('ROOM_NOT_FOUND')) return 'Kode room tidak ditemukan.';
    if (code.includes('ROOM_NOT_OPEN')) return 'Room sudah dimulai atau ditutup.';
    if (code.includes('ROOM_FULL')) return 'Room penuh.';
    if (code.includes('ALREADY_IN_ROOM')) return 'Kamu masih terdaftar di room lain. Keluar dulu atau tunggu sesi lama dibersihkan.';
    if (code.includes('INVALID_NICKNAME')) return 'Nickname harus 2–20 karakter (huruf, angka, titik, _ atau -).';
    if (code.includes('INVALID_MESSAGE')) return 'Pesan kosong atau melebihi 300 karakter.';
    if (code.includes('HOST_ONLY')) return 'Hanya host yang boleh melakukan tindakan ini.';
    if (code.includes('NEED_TWO_PLAYERS')) return 'Minimal 2 pemain untuk memulai.';
    if (code.includes('NOT_ALL_READY')) return 'Semua pemain harus Ready terlebih dahulu.';
    if (code.includes('PLAYER_OFFLINE')) return 'Ada anggota yang terputus. Tunggu anggota kembali atau bersihkan koneksi lama.';
    if (code.includes('NOT_A_MEMBER')) return 'Kamu bukan anggota room ini lagi.';
    if (code.includes('NOT_FRIENDS')) return 'Hanya bisa dilakukan antar teman.';
    if (code.includes('USER_NOT_FOUND')) return 'Pemain tidak ditemukan.';
    if (code.includes('QUERY_TOO_SHORT')) return 'Ketik minimal 2 huruf nama atau 8 digit ID.';
    if (code.includes('RATE_LIMITED')) return 'Terlalu cepat, tunggu sebentar.';
    if (code.includes('TOO_MANY_REQUESTS')) return 'Terlalu banyak permintaan pertemanan yang menunggu.';
    if (code.includes('REQUEST_NOT_FOUND')) return 'Permintaan sudah tidak ada.';
    if (code.includes('INVALID_PID')) return 'ID pemain belum siap. Tutup lalu buka lagi panel.';
    if (code.includes('PID_TAKEN')) return 'ID pemain ini sedang dipakai sesi lain (perangkat lama). Coba lagi nanti atau pakai perangkat yang sama.';
    if (SOCIAL_SQL_RE.test(raw) && /(PGRST|FUNCTION|SCHEMA CACHE|DOES NOT EXIST|COULD NOT FIND)/i.test(raw)) return 'Fitur teman belum aktif. Jalankan supabase-friends.sql di Supabase SQL Editor.';
    if (code.includes('ANONYMOUS PROVIDER IS DISABLED') || code.includes('SIGNUPS NOT ALLOWED') || code.includes('ANONYMOUS SIGN-INS ARE DISABLED')) {
      return 'Anonymous Sign-Ins belum aktif. Aktifkan di Supabase Auth settings.';
    }
    if (code.includes('PGRST') || code.includes('FUNCTION') || code.includes('SCHEMA CACHE')) {
      return 'RPC/tabel mabar belum tersedia. Jalankan supabase-mabar.sql di project mabar.';
    }
    if (/failed to fetch|network|load failed/i.test(raw)) return 'Koneksi internet/Supabase gagal. Coba lagi.';
    return raw.slice(0, 180);
  }

  async function ensureClient() {
    if (!mabarClient) {
      const sdk = await import(SDK_URL);
      mabarClient = sdk.createClient(FB_MABAR_SUPABASE_URL, FB_MABAR_SUPABASE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storageKey: 'fb-mabar-supabase-auth-v1'
        },
        realtime: { params: { eventsPerSecond: 30 } }
      });
    }
    const { data: sessionData, error: sessionError } = await mabarClient.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) {
      const { data, error } = await mabarClient.auth.signInAnonymously();
      if (error) throw error;
      authUser = data.user || data.session?.user || null;
    } else {
      authUser = sessionData.session.user;
    }
    if (!authUser) {
      const { data, error } = await mabarClient.auth.getUser();
      if (error) throw error;
      authUser = data.user;
    }
    if (!authUser || !authUser.id) throw new Error('Identitas Supabase tidak tersedia.');
    return mabarClient;
  }

  function injectStyles() {
    if (document.getElementById('fbMabarStyles')) return;
    const style = te('style');
    style.id = 'fbMabarStyles';
    style.textContent = `
      #lobby #fbMabarOpen{position:absolute;right:1.5%;left:auto;top:auto;bottom:13%;width:16%;height:7%;padding:0 1vw;border:1px solid rgba(255,224,126,.95);border-radius:7px;background:linear-gradient(180deg,rgba(62,48,17,.96),rgba(19,16,8,.97));box-shadow:0 0 0 1px rgba(0,0,0,.75),0 0 18px rgba(244,207,69,.2);color:#ffe27a;text-shadow:0 1px 3px #000;font:900 clamp(10px,2.6vh,19px) Orbitron,Audiowide,Arial,sans-serif;letter-spacing:.1em;z-index:12;pointer-events:auto;cursor:pointer}
      #lobby #fbMabarOpen:active{transform:scale(.97);filter:brightness(1.2)}
      #fbMabarOverlay{position:fixed;inset:0;z-index:999990;display:none;align-items:center;justify-content:center;padding:2.2vh 2vw;background:radial-gradient(ellipse at center,rgba(32,27,14,.92),rgba(0,0,0,.96));font-family:Audiowide,Orbitron,Arial,sans-serif;color:#f8f1dc;}
      #fbMabarOverlay.show{display:flex;animation:fbMabarIn .16s ease both}
      @keyframes fbMabarIn{from{opacity:0;transform:scale(.99)}to{opacity:1;transform:scale(1)}}
      #fbMabarOverlay *{box-sizing:border-box}
      #fbMabarCard{width:min(960px,96vw);height:min(690px,94vh);max-height:94dvh;display:flex;flex-direction:column;gap:12px;min-height:0;padding:clamp(12px,2vw,24px);border:1px solid #9c7922;border-radius:12px;background:linear-gradient(140deg,rgba(30,28,21,.99),rgba(7,9,12,.99) 65%);box-shadow:0 18px 65px #000, inset 0 0 30px rgba(238,187,48,.05);}
      .fbMbHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid rgba(244,207,69,.35);padding-bottom:10px;flex:0 0 auto}
      .fbMbTitle{font-size:clamp(17px,3.2vh,28px);font-weight:900;letter-spacing:.13em;color:#ffdc69;text-shadow:0 0 15px rgba(244,207,69,.18)}
      .fbMbSub{font:12px Arial,sans-serif;opacity:.72;letter-spacing:.08em;margin-top:4px}
      .fbMbClose{background:#171713;border:1px solid #6c571f;border-radius:7px;color:#ffdf74;font-size:22px;width:38px;height:36px;flex:0 0 auto;cursor:pointer}
      #fbMabarStatus{font:13px Arial,sans-serif;min-height:18px;color:#c6e7b8;overflow-wrap:anywhere;flex:0 0 auto}
      #fbMabarStatus.error{color:#ff8880}
      #fbMabarHome,#fbMabarRoom{display:none;flex:1;min-height:0;overflow:auto;gap:12px}
      #fbMabarHome.active,#fbMabarRoom.active{display:flex;flex-direction:column}
      /* Scroll room content on short screens; keep composer and actions reachable. */
      #fbMabarRoom.active{overflow-y:auto;overflow-x:hidden;gap:10px;padding-bottom:12px;-webkit-overflow-scrolling:touch;touch-action:pan-y}
      #fbMabarRoom>.fbMbBlock:not(.fbMbChat){flex:0 0 auto}
      #fbMabarRoom>.fbMbChat{flex:0 0 auto;min-height:0;min-width:0;overflow:visible}
      #fbMabarRoom .fbMbChat>.fbMbLabel{flex:0 0 auto}
      #fbMabarRoom #fbMabarChatLog{box-sizing:border-box;flex:0 0 auto;height:clamp(90px,22vh,180px);min-height:90px;max-height:180px;width:100%;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y}
      #fbMabarRoom .fbMbChat>.fbMbRow{flex:0 0 auto;width:100%;margin-top:8px;flex-wrap:nowrap;position:relative;z-index:5;pointer-events:auto}
      #fbMabarRoom #fbMabarChatInput{width:0;min-width:0;flex:1 1 auto;box-sizing:border-box;pointer-events:auto;touch-action:manipulation}
      #fbMabarRoom .fbMbChat .fbMbButton{flex:0 0 auto;min-width:76px;position:relative;z-index:6;pointer-events:auto;touch-action:manipulation}
      #fbMabarRoom>.fbMbFooter{position:relative;z-index:5;display:flex;flex:0 0 auto;flex-wrap:wrap;background:#090a0b;padding:8px 0 12px;pointer-events:auto}
      #fbMabarRoom>.fbMbFooter button{position:relative;z-index:6;pointer-events:auto;touch-action:manipulation}
      #fbMabarCard{overflow:hidden}
      #fbMabarRoom{overscroll-behavior:contain;touch-action:pan-y}
      .fbMbButton{border:1px solid #a07d24;border-radius:7px;min-height:40px;padding:10px 13px;background:linear-gradient(#f2d45c,#b68b1d);color:#19160d;font:900 12px Orbitron,Audiowide,Arial,sans-serif;letter-spacing:.045em;cursor:pointer}
      .fbMbButton.alt{background:#151713;border-color:#645321;color:#ffe18a}
      .fbMbButton.danger{background:#411714;border-color:#91413a;color:#ffe1dd}
      .fbMbButton:disabled{opacity:.35;cursor:not-allowed;filter:grayscale(.65)}
      .fbMbRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .fbMbInput{min-width:0;flex:1;width:100%;border:1px solid #5b5236;border-radius:7px;background:#080a0c;color:#fff;padding:11px 12px;font:600 15px Arial,sans-serif;outline:none}
      .fbMbInput:focus{border-color:#f4cf45;box-shadow:0 0 0 2px rgba(244,207,69,.12)}
      .fbMbBlock{padding:12px;border:1px solid #353126;border-radius:8px;background:rgba(255,255,255,.025)}
      .fbMbLabel{font:900 11px Arial,sans-serif;color:#e9ce6c;letter-spacing:.12em;margin-bottom:9px}
      #fbMabarPlayers{display:flex;flex-direction:column;gap:7px}
      .fbMbPlayer{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:10px;background:#10110e;border:1px solid #343126;border-radius:6px;font:13px Arial,sans-serif}
      .fbMbPlayerName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
      .fbMbPill{font:900 10px Arial,sans-serif;letter-spacing:.04em;white-space:nowrap;color:#24200f;background:#e9ca56;border-radius:4px;padding:5px 7px}
      .fbMbPill.no{background:#32332d;color:#c2c1b9}.fbMbPill.offline{background:#542522;color:#ffd4cd}
      .fbMbKick{background:transparent;border:1px solid #63332d;color:#ffb8b0;border-radius:4px;padding:5px 7px;font-size:11px;cursor:pointer}
      .fbMbChat{display:flex;flex-direction:column;min-height:130px;flex:1}
      #fbMabarChatLog{height:100%;min-height:110px;max-height:230px;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:9px;background:#08090a;border:1px solid #302d22;border-radius:6px;font:13px Arial,sans-serif}
      .fbMbMessage{overflow-wrap:anywhere;line-height:1.35}.fbMbMessage b{color:#f3d76d}.fbMbTime{font-size:10px;opacity:.55;margin-right:5px}
      #fbMabarRoomCode{font:900 clamp(19px,3.5vh,30px) Orbitron,Audiowide,Arial,sans-serif;letter-spacing:.22em;color:#ffdf75;user-select:all}
      .fbMbFooter{display:flex;gap:8px;flex-wrap:wrap;flex:0 0 auto}
      @media(max-width:700px){#lobby #fbMabarOpen{right:1.5%;left:auto;top:auto;bottom:13%;width:19%;height:7%;font-size:clamp(9px,2.1vh,15px)}#fbMabarCard{height:94dvh;max-height:94dvh;width:98vw;padding:10px;gap:8px}.fbMbPlayer{grid-template-columns:minmax(0,1fr) auto}.fbMbPlayer .fbMbKick{grid-column:2}#fbMabarRoom #fbMabarChatLog{height:clamp(90px,18vh,145px);max-height:145px}#fbMabarRoom>.fbMbFooter{gap:6px}#fbMabarRoom>.fbMbFooter .fbMbButton{min-height:38px;padding:8px 9px;font-size:10px}}
      @media(orientation:portrait){#fbMabarOverlay{padding:8px}#fbMabarCard{height:96vh;max-height:96dvh}}
    `;
    document.head.appendChild(style);
  }

  function buildPanel() {
    if (panel) return;
    panel = te('div'); panel.id = 'fbMabarOverlay'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', 'Mabar lobby online');
    const card = te('div'); card.id = 'fbMabarCard';
    const header = te('div', 'fbMbHeader');
    const titleBox = te('div');
    titleBox.append(te('div', 'fbMbTitle', 'FOR BLOOD // MABAR'), te('div', 'fbMbSub', 'ONLINE PARTY • MAX 4 PLAYERS'));
    const close = te('button', 'fbMbClose', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Tutup panel'); close.addEventListener('click', hidePanel);
    header.append(titleBox, close);
    statusEl = te('div'); statusEl.id = 'fbMabarStatus'; statusEl.setAttribute('aria-live', 'polite');

    homeView = te('div'); homeView.id = 'fbMabarHome'; homeView.className = 'active';
    const intro = te('div', 'fbMbBlock');
    intro.append(te('div', 'fbMbLabel', 'PARTY MATCH'), te('div', '', 'Cari teman lewat nama atau ID di tab CARI, tambahkan, lalu undang ke lobimu dari tab TEMAN (seperti Free Fire). Bisa juga buat lobi dan bagikan kodenya.'));
    const create = te('button', 'fbMbButton', 'BUAT LOBI • 4 PEMAIN'); create.id = 'fbMabarCreate'; create.type = 'button';
    create.addEventListener('click', async () => {
      setBusy(true); showNotice('Membuat room…');
      try {
        const client = await ensureClient();
        const { data, error } = await client.rpc('create_mabar_room', { p_nickname: nickname(), p_max_players: 4 });
        if (error) throw error;
        await activateRoom(data);
        showNotice('Room dibuat. Bagikan kode ke temanmu.');
      } catch (e) { showNotice(errorMessage(e), true); }
      finally { setBusy(false); }
    });
    const joinLabel = te('div', 'fbMbLabel', 'MASUK DENGAN KODE');
    const joinRow = te('div', 'fbMbRow');
    const codeInput = te('input', 'fbMbInput'); codeInput.id = 'fbMabarCodeInput'; codeInput.placeholder = 'MASUKKAN KODE 6 KARAKTER'; codeInput.maxLength = 6; codeInput.autocomplete = 'off'; codeInput.autocapitalize = 'characters'; codeInput.spellcheck = false; codeInput.setAttribute('aria-label', 'Kode room');
    codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6); });
    const join = te('button', 'fbMbButton alt', 'JOIN'); join.type = 'button';
    const doJoin = async () => {
      const code = codeInput.value.trim().toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) { showNotice('Kode room harus 6 karakter.', true); return; }
      setBusy(true); showNotice('Mencari room…');
      try {
        const client = await ensureClient();
        const { data, error } = await client.rpc('join_mabar_room', { p_code: code, p_nickname: nickname() });
        if (error) throw error;
        await activateRoom(data);
        showNotice(data && data.resumed ? 'Kembali ke room.' : 'Berhasil bergabung ke room.');
      } catch (e) { showNotice(errorMessage(e), true); }
      finally { setBusy(false); }
    };
    join.addEventListener('click', doJoin); codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
    joinRow.append(codeInput, join);
    homeView.append(intro, create, te('div', 'fbMbBlock'));
    homeView.lastChild.append(joinLabel, joinRow);

    roomView = te('div'); roomView.id = 'fbMabarRoom';
    const roomHead = te('div', 'fbMbBlock');
    const codeLine = te('div', 'fbMbRow');
    const codeDetails = te('div'); codeDetails.style.flex = '1'; codeDetails.append(te('div', 'fbMbLabel', 'ROOM CODE'), (roomCodeLabel = te('div'))); roomCodeLabel.id = 'fbMabarRoomCode';
    copyButton = te('button', 'fbMbButton alt', 'SALIN KODE'); copyButton.type = 'button'; copyButton.addEventListener('click', copyRoomCode);
    codeLine.append(codeDetails, copyButton);
    const roomStatus = te('div'); roomStatus.id = 'fbMabarRoomMeta'; roomStatus.style.cssText = 'font:12px Arial,sans-serif;opacity:.75;margin-top:8px';
    roomHead.append(codeLine, roomStatus);

    const membersBlock = te('div', 'fbMbBlock'); membersBlock.append(te('div', 'fbMbLabel', 'OPERATORS / PLAYERS')); playerList = te('div'); playerList.id = 'fbMabarPlayers'; membersBlock.append(playerList);
    const chatBlock = te('div', 'fbMbBlock fbMbChat'); chatBlock.append(te('div', 'fbMbLabel', 'PARTY CHAT')); chatLog = te('div'); chatLog.id = 'fbMabarChatLog'; chatBlock.append(chatLog);
    const chatRow = te('div', 'fbMbRow'); chatInput = te('input', 'fbMbInput'); chatInput.id = 'fbMabarChatInput'; chatInput.maxLength = 300; chatInput.placeholder = 'Tulis pesan (maks. 300 karakter)…'; chatInput.setAttribute('aria-label', 'Pesan chat room');
    const sendChat = te('button', 'fbMbButton alt', 'KIRIM'); sendChat.type = 'button'; sendChat.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }); chatRow.append(chatInput, sendChat); chatBlock.append(chatRow);

    const footer = te('div', 'fbMbFooter');
    readyButton = te('button', 'fbMbButton', 'READY'); readyButton.type = 'button'; readyButton.addEventListener('click', toggleReady);
    startButton = te('button', 'fbMbButton', 'START GAME'); startButton.type = 'button'; startButton.disabled = true; startButton.addEventListener('click', startRoomGame);
    closeRoomButton = te('button', 'fbMbButton danger', 'CLOSE ROOM'); closeRoomButton.type = 'button'; closeRoomButton.addEventListener('click', closeRoom);
    leaveButton = te('button', 'fbMbButton alt', 'LEAVE ROOM'); leaveButton.type = 'button'; leaveButton.addEventListener('click', leaveRoom);
    const back = te('button', 'fbMbButton alt', 'KEMBALI KE LOBBY'); back.type = 'button'; back.addEventListener('click', hidePanel);
    const inviteBtn = te('button', 'fbMbButton alt', 'UNDANG TEMAN'); inviteBtn.type = 'button'; inviteBtn.addEventListener('click', () => setTab('friends'));
    footer.append(readyButton, startButton, inviteBtn, closeRoomButton, leaveButton, back);
    roomView.append(roomHead, membersBlock, chatBlock, footer);
    card.append(header, buildTabs(), statusEl, homeView, roomView, ...buildSocialViews(), whisperView); panel.append(card); document.body.append(panel);
    panel.addEventListener('click', e => { if (e.target === panel) hidePanel(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('show')) { if (whisperView && whisperView.classList.contains('show')) closeWhisper(); else hidePanel(); } });
    applyViews();
  }

  function setBusy(busy) {
    const ids = ['fbMabarCreate', 'fbMabarCodeInput'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !!busy; });
    if (copyButton) copyButton.disabled = !!busy;
    if (readyButton) readyButton.disabled = !!busy;
    if (startButton && busy) startButton.disabled = true;
  }

  function showPanel() {
    buildPanel(); panel.classList.add('show');
    if (currentRoom) showRoomView();
    else showHomeView();
    if (typeof window.playClick === 'function') { try { window.playClick(); } catch (_) {} }
  }
  function hidePanel() { if (panel) panel.classList.remove('show'); }
  function showHomeView() { lobbyMode = 'home'; applyViews(); }
  function showRoomView() { lobbyMode = 'room'; renderRoom(); applyViews(); }

  function addLobbyButton() {
    injectStyles(); buildPanel();
    const hud = document.getElementById('lobHud');
    if (!hud || document.getElementById('fbMabarOpen')) return;
    const btn = te('button', '', 'MABAR'); btn.id = 'fbMabarOpen'; btn.type = 'button'; btn.setAttribute('aria-label', 'Buka lobby mabar online');
    btn.addEventListener('click', async () => {
      showPanel();
      if (!currentRoom) showNotice('Mabar memakai Supabase terpisah dari login dan diamond game.');
      try { await ensureClient(); startSocial(); await attemptResumeRoom(); } catch (e) { showNotice(errorMessage(e), true); }
      if (currentRoom) showRoomView();
    });
    hud.append(btn);
  }

  async function attemptResumeRoom() {
    if (currentRoom) return;
    const client = await ensureClient();
    const { data: mem, error } = await client.from('mabar_players').select('room_id').eq('user_id', authUser.id).maybeSingle();
    if (error) throw error;
    if (!mem || !mem.room_id) { try { localStorage.removeItem('fb_mabar_last_room'); } catch (_) {} return; }
    const { data: row, error: roomError } = await client.from('mabar_rooms').select('*').eq('id', mem.room_id).maybeSingle();
    if (roomError) throw roomError;
    if (!row) return;
    currentRoom = row;
    await attachRoomSubscriptions();
    await refreshRoomData();
    showRoomView();
    if (currentRoom.status === 'starting') launchGameOnce();
    if (currentRoom.status === 'closed') await handleRoomClosed();
  }

  async function activateRoom(roomData) {
    if (!roomData || !(roomData.room_id || roomData.id)) throw new Error('Server tidak mengembalikan ID room yang valid.');
    if (!authUser) await ensureClient();
    currentRoom = {
      id: roomData.room_id || roomData.id,
      room_id: roomData.room_id || roomData.id,
      code: roomData.code,
      host_id: roomData.host_id,
      status: roomData.status || 'waiting',
      max_players: roomData.max_players || 4,
      created_at: roomData.created_at
    };
    matchStarted = false; matchStarting = false; stateByUser.clear();
    await attachRoomSubscriptions();
    await refreshRoomData();
    showRoomView();
    try { localStorage.setItem('fb_mabar_last_room', currentRoom.id); } catch (_) {}
  }

  async function attachRoomSubscriptions() {
    await detachSubscriptions();
    if (!currentRoom) return;
    const roomId = currentRoom.id;
    dbChannel = mabarClient.channel('mabar-db:' + roomId, { config: { private: true } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mabar_rooms', filter: 'id=eq.' + roomId }, async payload => {
        if (payload && payload.new) {
          currentRoom = Object.assign({}, currentRoom, payload.new);
          renderRoom();
          if (currentRoom.status === 'starting') launchGameOnce();
          if (currentRoom.status === 'closed') handleRoomClosed();
        } else {
          refreshRoomData().catch(() => {});
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mabar_players', filter: 'room_id=eq.' + roomId }, () => {
        refreshRoomData().catch(e => showNotice(errorMessage(e), true));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mabar_messages', filter: 'room_id=eq.' + roomId }, () => {
        refreshMessages().catch(() => {});
      })
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') showNotice('Koneksi realtime lobby terputus; mencoba menyambungkan kembali…', true);
      });
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!currentRoom || !mabarClient) return;
      mabarClient.rpc('touch_mabar_room', { p_room_id: currentRoom.id }).catch(() => {});
      mabarClient.rpc('sweep_mabar_room', { p_room_id: currentRoom.id }).then(({ error }) => { if (error && !String(error.message || '').includes('ACTIVE_MEMBER_REQUIRED')) console.warn('[MABAR] sweep:', error.message); }).catch(() => {});
    }, 20000);
    await refreshRoomData();
    await refreshMessages();
    await refreshPlayerChannels();
  }

  async function detachSubscriptions() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
    if (dbChannel && mabarClient) { try { await mabarClient.removeChannel(dbChannel); } catch (_) {} dbChannel = null; }
    for (const channel of playerChannels.values()) { try { await mabarClient.removeChannel(channel); } catch (_) {} }
    playerChannels.clear(); ownChannel = null;
  }

  async function refreshRoomData() {
    if (!currentRoom || !mabarClient) return;
    const roomId = currentRoom.id;
    const [roomRes, playersRes] = await Promise.all([
      mabarClient.from('mabar_rooms').select('*').eq('id', roomId).maybeSingle(),
      mabarClient.from('mabar_players').select('room_id,user_id,nickname,ready,joined_at,last_seen_at').eq('room_id', roomId).order('joined_at', { ascending: true })
    ]);
    if (roomRes.error) throw roomRes.error;
    if (playersRes.error) throw playersRes.error;
    if (!roomRes.data) {
      await clearLocalRoom(false);
      showNotice('Room sudah tidak tersedia.', true);
      return;
    }
    currentRoom = Object.assign({}, currentRoom, roomRes.data);
    roomPlayers = playersRes.data || [];
    renderRoom();
    await refreshPlayerChannels();
    syncRemoteModels();
  }

  async function refreshMessages() {
    if (!currentRoom || !mabarClient || !chatLog) return;
    const { data, error } = await mabarClient.from('mabar_messages').select('id,user_id,nickname,body,created_at').eq('room_id', currentRoom.id).order('created_at', { ascending: true }).limit(60);
    if (error) throw error;
    const oldScroll = chatLog.scrollTop;
    const nearBottom = chatLog.scrollHeight - chatLog.clientHeight - oldScroll < 48;
    chatLog.replaceChildren();
    (data || []).forEach(msg => appendMessage(msg, false));
    if (nearBottom) chatLog.scrollTop = chatLog.scrollHeight;
  }

  function appendMessage(msg, scroll = true) {
    if (!chatLog) return;
    const row = te('div', 'fbMbMessage');
    const date = new Date(msg.created_at || Date.now());
    const time = te('span', 'fbMbTime', Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const name = te('b', '', String(msg.nickname || 'Player').slice(0, 20) + ': ');
    const text = te('span', '', String(msg.body || '').slice(0, 300));
    row.append(time, name, text); chatLog.append(row);
    while (chatLog.children.length > 80) chatLog.firstChild.remove();
    if (scroll) chatLog.scrollTop = chatLog.scrollHeight;
  }

  function renderRoom() {
    if (!currentRoom || !roomView) return;
    roomCodeLabel.textContent = currentRoom.code || '------';
    const meta = document.getElementById('fbMabarRoomMeta');
    if (meta) meta.textContent = (currentRoom.status === 'waiting' ? 'MENUNGGU PEMAIN' : currentRoom.status === 'starting' ? 'PERTANDINGAN DIMULAI' : 'ROOM DITUTUP') + ' • ' + roomPlayers.length + '/' + (currentRoom.max_players || 4) + ' PEMAIN';
    playerList.replaceChildren();
    roomPlayers.forEach(player => {
      const line = te('div', 'fbMbPlayer');
      const name = te('div', 'fbMbPlayerName', player.nickname + (player.user_id === authUser?.id ? ' (Kamu)' : ''));
      const host = player.user_id === currentRoom.host_id;
      if (host) name.textContent += ' ★ HOST';
      const ready = te('span', 'fbMbPill' + (player.ready ? '' : ' no'), player.ready ? 'READY' : 'NOT READY');
      const active = Date.now() - new Date(player.last_seen_at || 0).getTime() < ONLINE_STALE_MS;
      const connection = te('span', 'fbMbPill' + (active ? '' : ' offline'), active ? 'ONLINE' : 'OFFLINE');
      line.append(name, ready, connection);
      if (currentRoom.status === 'waiting' && currentRoom.host_id === authUser?.id && player.user_id !== authUser?.id) {
        const kick = te('button', 'fbMbKick', 'KICK'); kick.type = 'button'; kick.addEventListener('click', () => kickPlayer(player.user_id)); line.append(kick);
      }
      if (player.user_id !== authUser?.id && socialStarted) {
        const fr = friendOf(player.user_id);
        const ex = te('div'); ex.style.cssText = 'grid-column:1 / -1;display:flex;gap:6px';
        if (fr && fr.status === 'accepted') {
          const w = te('button', 'fbMbKick', 'WHISPER'); w.type = 'button'; w.style.cssText = 'border-color:#645321;color:#ffe18a';
          w.addEventListener('click', () => openWhisper(fr)); ex.append(w);
        } else if (!fr) {
          const a = te('button', 'fbMbKick', '+ TEMAN'); a.type = 'button'; a.style.cssText = 'border-color:#645321;color:#ffe18a';
          a.addEventListener('click', async () => {
            a.disabled = true;
            try { const { error } = await rpc('send_friend_request', { p_target: player.user_id }); if (error) throw error; showNotice('Permintaan dikirim ke ' + player.nickname + '.'); refreshFriends(true).catch(() => {}); }
            catch (e) { showNotice(errorMessage(e), true); a.disabled = false; }
          });
          ex.append(a);
        }
        if (ex.children.length) line.append(ex);
      }
      playerList.append(line);
    });
    const me = roomPlayers.find(p => p.user_id === authUser?.id);
    const waiting = currentRoom.status === 'waiting';
    readyButton.textContent = me && me.ready ? 'NOT READY' : 'READY';
    readyButton.disabled = !waiting || !me;
    closeRoomButton.style.display = currentRoom.host_id === authUser?.id && currentRoom.status !== 'closed' ? '' : 'none';
    startButton.style.display = currentRoom.host_id === authUser?.id && waiting ? '' : 'none';
    const everybodyReady = roomPlayers.length >= 2 && roomPlayers.length <= (currentRoom.max_players || 4) && roomPlayers.every(p => p.ready && Date.now() - new Date(p.last_seen_at || 0).getTime() < 90000);
    startButton.disabled = !(waiting && currentRoom.host_id === authUser?.id && everybodyReady);
    if (!waiting) readyButton.disabled = true;
    leaveButton.disabled = false;
    syncLobbyParty();
  }

  async function toggleReady() {
    if (!currentRoom) return;
    const me = roomPlayers.find(p => p.user_id === authUser?.id);
    if (!me) return;
    readyButton.disabled = true;
    try {
      const { error } = await mabarClient.rpc('set_mabar_ready', { p_room_id: currentRoom.id, p_ready: !me.ready });
      if (error) throw error;
      await refreshRoomData();
      showNotice(!me.ready ? 'Status Ready aktif.' : 'Status Ready dimatikan.');
    } catch (e) { showNotice(errorMessage(e), true); }
    finally { renderRoom(); }
  }

  async function startRoomGame() {
    if (!currentRoom || currentRoom.host_id !== authUser?.id || currentRoom.status !== 'waiting') return;
    startButton.disabled = true;
    showNotice('Memvalidasi status anggota di server…');
    try {
      const { data, error } = await mabarClient.rpc('start_mabar_room', { p_room_id: currentRoom.id });
      if (error) throw error;
      currentRoom.status = 'starting';
      // The room update is the source of truth; this private host-topic event improves startup latency.
      const hostChannel = playerChannels.get(authUser.id);
      if (hostChannel) await hostChannel.send({ type: 'broadcast', event: 'game_start', payload: { uid: authUser.id, room_id: currentRoom.id, at: Date.now() } }).catch(() => {});
      renderRoom(); launchGameOnce();
    } catch (e) {
      showNotice(errorMessage(e), true);
      startButton.disabled = false;
    }
  }

  async function closeRoom() {
    if (!currentRoom || currentRoom.host_id !== authUser?.id) return;
    if (!confirm('Tutup room untuk semua anggota?')) return;
    closeRoomButton.disabled = true;
    try {
      const { error } = await mabarClient.rpc('close_mabar_room', { p_room_id: currentRoom.id });
      if (error) throw error;
      showNotice('Room ditutup.');
      await handleRoomClosed();
    } catch (e) { showNotice(errorMessage(e), true); }
    finally { if (closeRoomButton) closeRoomButton.disabled = false; }
  }

  async function kickPlayer(userId) {
    if (!currentRoom || currentRoom.host_id !== authUser?.id || !userId) return;
    if (!confirm('Keluarkan pemain ini dari room?')) return;
    try {
      const roomId = currentRoom.id;
      const { error } = await mabarClient.rpc('kick_mabar_player', { p_room_id: roomId, p_target_user_id: userId });
      if (error) throw error;
      const hostChannel = playerChannels.get(authUser.id);
      if (hostChannel) await hostChannel.send({ type: 'broadcast', event: 'kick', payload: { uid: authUser.id, room_id: roomId, target_uid: userId, at: Date.now() } }).catch(() => {});
      showNotice('Pemain dikeluarkan dari room.');
      await refreshRoomData();
    } catch (e) { showNotice(errorMessage(e), true); }
  }

  async function leaveRoom() {
    if (!currentRoom) { hidePanel(); return; }
    leaveButton.disabled = true;
    try {
      const roomId = currentRoom.id;
      if (mabarClient && authUser) {
        const { error } = await mabarClient.rpc('leave_mabar_room', { p_room_id: roomId });
        if (error && !String(error.message || '').includes('ROOM_NOT_FOUND')) throw error;
      }
      await clearLocalRoom(false);
      showNotice('Kamu sudah keluar dari room.');
      showHomeView();
    } catch (e) { showNotice(errorMessage(e), true); }
    finally { if (leaveButton) leaveButton.disabled = false; }
  }

  async function handleRoomClosed() {
    if (!currentRoom) return;
    const roomId = currentRoom.id;
    showNotice('Host menutup room. Kembali ke lobby utama.');
    try { if (mabarClient && authUser) await mabarClient.rpc('leave_mabar_room', { p_room_id: roomId }); } catch (_) {}
    await clearLocalRoom(false);
    showHomeView();
  }

  async function clearLocalRoom(keepPanel) {
    matchStarted = false; matchStarting = false;
    stateByUser.clear();
    if (window.ForBlood3D && typeof window.ForBlood3D.setRemotePlayers === 'function') window.ForBlood3D.setRemotePlayers([]);
    if (window.ForBlood3D && typeof window.ForBlood3D.setNetworkEnabled === 'function') window.ForBlood3D.setNetworkEnabled(false);
    await detachSubscriptions();
    currentRoom = null; roomPlayers = [];
    if (!keepPanel) {
      try { localStorage.removeItem('fb_mabar_last_room'); } catch (_) {}
    }
    if (panel) {
      playerList?.replaceChildren(); chatLog?.replaceChildren();
      lobbyMode = 'home'; applyViews();
    }
    syncLobbyParty();
  }

  async function copyRoomCode() {
    if (!currentRoom?.code) return;
    try {
      await navigator.clipboard.writeText(currentRoom.code);
      showNotice('Kode ' + currentRoom.code + ' disalin.');
    } catch (_) {
      const temporary = te('textarea'); temporary.value = currentRoom.code; temporary.style.position = 'fixed'; temporary.style.opacity = '0'; document.body.append(temporary); temporary.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
      temporary.remove(); showNotice(ok ? 'Kode room disalin.' : 'Kode room: ' + currentRoom.code, !ok);
    }
  }

  async function sendMessage() {
    if (!currentRoom || !chatInput) return;
    const body = chatInput.value.trim();
    if (!body) return;
    if (body.length > 300) { showNotice('Pesan maksimal 300 karakter.', true); return; }
    const value = body;
    if (!mabarClient) { showNotice('Chat belum tersambung ke server. Coba buka ulang room.', true); return; }
    try {
      const { error } = await mabarClient.rpc('send_mabar_message', { p_room_id: currentRoom.id, p_body: value });
      if (error) throw error;
      chatInput.value = '';
      await refreshMessages();
      showNotice('Pesan terkirim.');
    } catch (e) { showNotice(errorMessage(e), true); }
  }

  async function refreshPlayerChannels() {
    if (!currentRoom || !mabarClient || !authUser) return;
    const ids = new Set(roomPlayers.map(p => p.user_id));
    for (const [uid, channel] of playerChannels.entries()) {
      if (!ids.has(uid)) {
        try { await mabarClient.removeChannel(channel); } catch (_) {}
        playerChannels.delete(uid); stateByUser.delete(uid);
      }
    }
    for (const player of roomPlayers) {
      if (playerChannels.has(player.user_id)) continue;
      const uid = player.user_id;
      const topic = ROOM_PREFIX + currentRoom.id + ':player:' + uid;
      const channel = mabarClient.channel(topic, { config: { private: true, broadcast: { self: false, ack: false } } });
      channel.on('broadcast', { event: 'state' }, ({ payload }) => {
        if (!currentRoom || !payload || payload.uid !== uid || payload.room_id !== currentRoom.id || uid === authUser?.id) return;
        const val = payload.state || {};
        const safe = {
          id: uid,
          nickname: String(val.nickname || player.nickname || 'Player').slice(0, 20),
          x: finiteRange(val.x, -360, 360), z: finiteRange(val.z, -360, 360), y: finiteRange(val.y, -5, 30),
          yaw: finiteRange(val.yaw, -1000, 1000), pitch: finiteRange(val.pitch, -2, 2),
          hp: finiteRange(val.hp, 0, 100), alive: val.alive !== false,
          moving: !!val.moving, sprinting: !!val.sprinting, crouch: !!val.crouch, jumping: !!val.jumping, firing: !!val.firing, weapon: String(val.weapon || 'ak').slice(0,24), reloading: !!val.reloading, unarmed: !!val.unarmed, receivedAt: Date.now()
        };
        stateByUser.set(uid, safe); syncRemoteModels();
      });
      channel.on('broadcast', { event: 'shot' }, ({ payload }) => {
        if (payload && payload.uid === uid && uid !== authUser?.id && window.ForBlood3D?.flashRemoteShot) window.ForBlood3D.flashRemoteShot(uid);
      });
      channel.on('broadcast', { event: 'hit' }, ({ payload }) => {
        if (!currentRoom || !payload || payload.uid !== uid || uid === authUser?.id) return;
        if (payload.target_uid !== authUser?.id) return;
        const damage = Number(payload.damage);
        if (!Number.isFinite(damage) || damage < 1 || damage > 150) return;
        // Client-prototype PvP only; an authoritative match server is required against cheating.
        if (window.ForBlood3D?.applyRemoteDamage) window.ForBlood3D.applyRemoteDamage(damage, player.nickname);
      });
      channel.on('broadcast', { event: 'game_start' }, ({ payload }) => {
        if (payload && payload.uid === uid && uid === currentRoom?.host_id && payload.room_id === currentRoom?.id) launchGameOnce();
      });
      channel.on('broadcast', { event: 'kick' }, ({ payload }) => {
        if (payload && payload.uid === uid && uid === currentRoom?.host_id && payload.target_uid === authUser?.id && payload.room_id === currentRoom?.id) {
          showNotice('Host mengeluarkan kamu dari room.', true);
          clearLocalRoom(false).then(showHomeView).catch(() => {});
        }
      });
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          if (uid === authUser?.id) ownChannel = channel;
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && uid === authUser?.id) {
          console.warn('[MABAR] gameplay channel unavailable:', err || status);
        }
      });
      playerChannels.set(uid, channel);
    }
    ownChannel = playerChannels.get(authUser.id) || null;
  }

  function finiteRange(value, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
  }

  function syncRemoteModels() {
    if (!currentRoom || !window.ForBlood3D || typeof window.ForBlood3D.setRemotePlayers !== 'function') return;
    const fresh = [];
    const count = Math.max(1, roomPlayers.length);
    roomPlayers.forEach((player, index) => {
      if (player.user_id === authUser?.id) return;
      const state = stateByUser.get(player.user_id);
      const angle = index * Math.PI * 2 / count;
      const fallback = { id: player.user_id, nickname: player.nickname, x: Math.sin(angle) * 3, z: Math.cos(angle) * 3, y: 0, yaw: angle + Math.PI, pitch: 0, hp: 100, alive: true, moving: false, firing: false, receivedAt: 0 };
      if (!matchStarted) return;
      if (state && Date.now() - state.receivedAt <= STATE_STALE_MS) fresh.push(state);
      else if (state && Date.now() - state.receivedAt > STATE_STALE_MS) stateByUser.delete(player.user_id);
      else fresh.push(fallback);
    });
    window.ForBlood3D.setRemotePlayers(fresh);
  }

  async function launchGameOnce() {
    if (!currentRoom || currentRoom.status !== 'starting' || matchStarting || matchStarted) return;
    matchStarting = true;
    try {
      hidePanel();
      showNotice('Semua anggota masuk pertandingan…');
      if (typeof window.fbLobbyPlay === 'function') window.fbLobbyPlay();
      else if (typeof window.startMatchLoading === 'function') window.startMatchLoading();
      else throw new Error('Fungsi loading game lama tidak ditemukan.');
    } catch (e) {
      matchStarting = false;
      showNotice('Tidak dapat memulai game: ' + errorMessage(e), true);
    }
  }

  function getSortedSpawn() {
    const list = roomPlayers.slice().sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
    let index = list.findIndex(p => p.user_id === authUser?.id);
    if (index < 0) index = 0;
    const angle = (index / Math.max(1, list.length)) * Math.PI * 2;
    return { x: Math.sin(angle) * 3.2, z: Math.cos(angle) * 3.2, yaw: angle + Math.PI };
  }

  function startGameplaySync() {
    if (!currentRoom || !authUser) return;
    matchStarted = true; matchStarting = false;
    const spawn = getSortedSpawn();
    if (window.ForBlood3D?.setSpawn) window.ForBlood3D.setSpawn(spawn.x, spawn.z, spawn.yaw);
    if (window.ForBlood3D?.setNetworkEnabled) window.ForBlood3D.setNetworkEnabled(true);
    syncRemoteModels();
    if (gameTimer) clearInterval(gameTimer);
    gameTimer = setInterval(() => {
      if (!currentRoom || !matchStarted || !window.ForBlood3D?.getNetState) return;
      const channel = ownChannel || playerChannels.get(authUser.id);
      if (!channel) return;
      let state;
      try { state = window.ForBlood3D.getNetState(); } catch (_) { return; }
      channel.send({ type: 'broadcast', event: 'state', payload: { uid: authUser.id, room_id: currentRoom.id, state: Object.assign({ nickname: nickname() }, state), sent_at: Date.now() } }).catch(() => {});
    }, 100);
    if (staleTimer) clearInterval(staleTimer);
    staleTimer = setInterval(syncRemoteModels, 250);
  }

  // The existing engine calls these hooks; they are deliberately separate from Firebase/diamond RPCs.
  window.fbMabarOnMatchStart = () => {
    if (!currentRoom || currentRoom.status !== 'starting') return;
    startGameplaySync();
  };
  window.fbMabarOnMatchLoadFailed = () => {
    matchStarting = false;
    if (currentRoom) showNotice('Engine FPS gagal dimuat. Periksa koneksi/aset, lalu coba Play lagi atau keluar room.', true);
  };
  window.fbMabarOnMatchEnd = () => {
    matchStarted = false; matchStarting = false;
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
    if (window.ForBlood3D?.setNetworkEnabled) window.ForBlood3D.setNetworkEnabled(false);
    if (window.ForBlood3D?.setRemotePlayers) window.ForBlood3D.setRemotePlayers([]);
  };
  window.fbMabarLocalShot = () => {
    if (!currentRoom || !matchStarted || !authUser) return;
    const channel = ownChannel || playerChannels.get(authUser.id);
    if (channel) channel.send({ type: 'broadcast', event: 'shot', payload: { uid: authUser.id, room_id: currentRoom.id, at: Date.now() } }).catch(() => {});
  };
  window.fbMabarSendHit = (targetUid, damage, headshot) => {
    if (!currentRoom || !matchStarted || !authUser || !targetUid || targetUid === authUser.id) return;
    const channel = ownChannel || playerChannels.get(authUser.id);
    const amount = Math.max(1, Math.min(150, Number(damage) || 1));
    if (channel) channel.send({ type: 'broadcast', event: 'hit', payload: { uid: authUser.id, room_id: currentRoom.id, target_uid: targetUid, damage: amount, headshot: !!headshot, at: Date.now() } }).catch(() => {});
  };

  function interceptSoloPlay() {
    startWrapOriginal = window.startMatchLoading;
    if (typeof startWrapOriginal !== 'function') return;
    window.startMatchLoading = function () {
      if (currentRoom && currentRoom.status !== 'closed') {
        if (currentRoom.status === 'starting') { launchGameOnce(); return; }
        showPanel(); showNotice('Untuk mabar, host harus menekan START GAME setelah semua pemain Ready.'); return;
      }
      return startWrapOriginal.apply(this, arguments);
    };
  }

  function initialLobbyWiring() {
    addLobbyButton();
    interceptSoloPlay();
    watchLobbyForSocial();
    // Restore an existing Supabase anonymous identity's membership after refresh.
    let remembered = false;
    try { remembered = !!localStorage.getItem('fb_mabar_last_room'); } catch (_) {}
    if (remembered) ensureClient().then(attemptResumeRoom).catch(() => {});
  }


  // =====================================================================
  //  SOCIAL: CARI ID/NAMA • TEMAN • UNDANG KE LOBI • WHISPER  (ala Free Fire)
  //  Butuh supabase-friends.sql (tabel mabar_profiles/friendships/invites/whispers + RPC).
  // =====================================================================
  const SOC_POLL_MS = 9000;
  let activeTab = 'lobby', lobbyMode = 'home';
  let tabBar = null, tabFriendsBtn = null, tabSearchBtn = null, tabLobbyBtn = null;
  let friendsView = null, friendsBody = null, searchView = null, searchInput = null, searchResults = null, myIdLine = null;
  let whisperView = null, whisperLog = null, whisperInput = null, whisperTitle = null, whisperWith = null;
  let friendsData = [], unreadTotal = 0, pendingIn = 0;
  let socialStarted = false, socialRetryAt = 0, socialChannel = null, beatTimer = null, pollTimer = null, beatN = 0;
  let toastBox = null, socialError = '';
  const seenToast = new Set();

  const SOCIAL_SQL_RE = /(upsert_mabar_profile|search_mabar_profiles|list_mabar_friends|send_friend_request|respond_friend_request|invite_mabar_friend|send_mabar_whisper|mark_mabar_whispers_read|dismiss_mabar_invite|mabar_profiles|mabar_whispers|mabar_invites|mabar_friendships)/i;

  function myPid() { let v = ''; try { v = localStorage.getItem('fb_pid') || ''; } catch (_) {} return /^\d{8}$/.test(v) ? v : ''; }
  function myRankTier() { try { return (window.fbRank && window.fbRank.tier()) | 0; } catch (_) { return 0; } }
  function rankBadge(tier) { try { return window.fbRank ? window.fbRank.badge(tier | 0) : ''; } catch (_) { return ''; } }
  function rankName(tier) { try { return window.fbRank ? window.fbRank.tiers[Math.max(0, Math.min(window.fbRank.tiers.length - 1, tier | 0))].name : ''; } catch (_) { return ''; } }
  async function rpc(name, args) { const c = await ensureClient(); return c.rpc(name, args || {}); }
  function friendOf(uid) { return friendsData.find(f => f.user_id === uid) || null; }

  function injectSocialStyles() {
    if (document.getElementById('fbSocialStyles')) return;
    const s = te('style'); s.id = 'fbSocialStyles';
    s.textContent = `
#fbMabarCard{position:relative}
.fbMbTabs{display:flex;gap:6px;flex:0 0 auto}
.fbMbTab{flex:1;position:relative;min-height:38px;border-radius:7px;border:1px solid #645321;background:#151713;color:#ffe18a;font:900 12px Orbitron,Audiowide,Arial,sans-serif;letter-spacing:.06em;cursor:pointer}
.fbMbTab.on{background:linear-gradient(#f2d45c,#b68b1d);color:#19160d;border-color:#a07d24}
.fbMbDot{position:absolute;top:-6px;right:-4px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e1141f;color:#fff;font:900 11px/18px Arial,sans-serif;text-align:center;display:none}
.fbMbDot.show{display:block}
#fbMabarFriends,#fbMabarSearch{display:none;flex:1;min-height:0;overflow:auto;gap:10px;-webkit-overflow-scrolling:touch;touch-action:pan-y}
#fbMabarFriends.active,#fbMabarSearch.active{display:flex;flex-direction:column}
.fbMbSec{font:900 11px Arial,sans-serif;color:#e9ce6c;letter-spacing:.12em;margin:4px 0 2px}
.fbMbFriend{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 10px;background:#10110e;border:1px solid #343126;border-radius:6px;font:13px Arial,sans-serif}
.fbMbFriend img.rk{height:34px;width:auto;max-width:42px;object-fit:contain}
.fbMbFriend .rkNone{width:34px}
.fbMbFName{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fbMbFMeta{font-size:11px;opacity:.65;margin-top:2px}
.fbMbFAct{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.fbMbMini{position:relative;min-height:32px;padding:6px 9px;border-radius:5px;border:1px solid #a07d24;background:linear-gradient(#f2d45c,#b68b1d);color:#19160d;font:900 10px Orbitron,Audiowide,Arial,sans-serif;letter-spacing:.04em;cursor:pointer}
.fbMbMini.alt{background:#151713;border-color:#645321;color:#ffe18a}
.fbMbMini.bad{background:#411714;border-color:#91413a;color:#ffe1dd}
.fbMbMini:disabled{opacity:.4;cursor:not-allowed}
.fbMbOn{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4cd964;margin-right:6px}
.fbMbOff{background:#6b6b66}
.fbMbEmpty{font:13px Arial,sans-serif;opacity:.65;padding:10px 2px}
.fbMbMyId{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font:13px Arial,sans-serif;padding:9px 10px;border:1px solid #353126;border-radius:8px;background:rgba(255,255,255,.03)}
.fbMbMyId b{color:#ffdf75;letter-spacing:.12em;font-family:Orbitron,Audiowide,Arial,sans-serif}
#fbMbWhisper{position:absolute;inset:0;z-index:30;display:none;flex-direction:column;gap:8px;padding:clamp(12px,2vw,22px);background:rgba(9,10,11,.985);border-radius:12px}
#fbMbWhisper.show{display:flex}
#fbMbWhisperLog{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:9px;background:#08090a;border:1px solid #302d22;border-radius:6px;font:13px Arial,sans-serif;-webkit-overflow-scrolling:touch}
.fbMbWMsg{max-width:82%;padding:7px 10px;border-radius:10px;line-height:1.35;overflow-wrap:anywhere}
.fbMbWMsg.me{align-self:flex-end;background:#5a4812;color:#fff;border-bottom-right-radius:3px}
.fbMbWMsg.them{align-self:flex-start;background:#23242a;color:#fff;border-bottom-left-radius:3px}
.fbMbWMsg small{display:block;font-size:10px;opacity:.55;margin-top:2px}
#fbMbToasts{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:999995;display:flex;flex-direction:column;gap:8px;width:min(440px,94vw);pointer-events:none}
.fbMbToast{pointer-events:auto;display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid #a07d24;border-radius:10px;background:linear-gradient(180deg,rgba(40,32,12,.98),rgba(12,10,6,.98));color:#fff;font:13px Arial,sans-serif;box-shadow:0 8px 28px #000;animation:fbMabarIn .16s ease both}
.fbMbToast .t{flex:1;min-width:0;overflow-wrap:anywhere}.fbMbToast .t b{color:#ffdf75}
#lobby #fbMabarOpen{overflow:visible}
#lobby #fbMabarOpen .fbMbDot{top:-8px;right:-6px}
@media(max-width:700px){.fbMbFriend{grid-template-columns:auto minmax(0,1fr)}.fbMbFAct{grid-column:1 / -1;justify-content:flex-start}.fbMbTab{font-size:10px;letter-spacing:.02em}}
`;
    document.head.appendChild(s);
  }

  // ---------- tab ----------
  function buildTabs() {
    injectSocialStyles();
    tabBar = te('div', 'fbMbTabs');
    const mk = (id, txt) => { const b = te('button', 'fbMbTab', txt); b.type = 'button'; b.dataset.tab = id; b.addEventListener('click', () => setTab(id)); const d = te('span', 'fbMbDot'); b.append(d); b._dot = d; return b; };
    tabLobbyBtn = mk('lobby', 'LOBI'); tabFriendsBtn = mk('friends', 'TEMAN'); tabSearchBtn = mk('search', 'CARI');
    tabBar.append(tabLobbyBtn, tabFriendsBtn, tabSearchBtn);
    return tabBar;
  }
  function setTab(t) {
    activeTab = t; applyViews();
    if (t === 'friends') { refreshFriends(false).catch(e => showNotice(errorMessage(e), true)); }
    if (t === 'search' && searchInput) setTimeout(() => searchInput.focus(), 60);
  }
  function applyViews() {
    if (!homeView || !friendsView || !searchView) return;
    homeView.classList.toggle('active', activeTab === 'lobby' && lobbyMode === 'home');
    roomView.classList.toggle('active', activeTab === 'lobby' && lobbyMode === 'room');
    friendsView.classList.toggle('active', activeTab === 'friends');
    searchView.classList.toggle('active', activeTab === 'search');
    [tabLobbyBtn, tabFriendsBtn, tabSearchBtn].forEach(b => b && b.classList.toggle('on', b.dataset.tab === activeTab));
  }
  function updateBadge() {
    const n = pendingIn + unreadTotal;
    if (tabFriendsBtn) { tabFriendsBtn._dot.textContent = n > 9 ? '9+' : String(n); tabFriendsBtn._dot.classList.toggle('show', n > 0); }
    const open = document.getElementById('fbMabarOpen');
    if (open) {
      let d = open.querySelector('.fbMbDot');
      if (!d) { d = te('span', 'fbMbDot'); open.append(d); }
      d.textContent = n > 9 ? '9+' : String(n); d.classList.toggle('show', n > 0);
    }
  }

  // ---------- panel TEMAN & CARI & WHISPER ----------
  function buildSocialViews() {
    friendsView = te('div'); friendsView.id = 'fbMabarFriends';
    myIdLine = te('div', 'fbMbMyId'); friendsView.append(myIdLine);
    friendsBody = te('div'); friendsBody.style.cssText = 'display:flex;flex-direction:column;gap:7px'; friendsView.append(friendsBody);

    searchView = te('div'); searchView.id = 'fbMabarSearch';
    const box = te('div', 'fbMbBlock');
    box.append(te('div', 'fbMbLabel', 'CARI PEMAIN (NAMA ATAU ID 8 DIGIT)'));
    const row = te('div', 'fbMbRow');
    searchInput = te('input', 'fbMbInput'); searchInput.placeholder = 'Contoh: 12345678 atau nama'; searchInput.maxLength = 20; searchInput.autocomplete = 'off'; searchInput.spellcheck = false;
    searchInput.setAttribute('aria-label', 'Cari nama atau ID');
    const go = te('button', 'fbMbButton', 'CARI'); go.type = 'button';
    go.addEventListener('click', doSearch); searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    row.append(searchInput, go); box.append(row);
    searchResults = te('div'); searchResults.style.cssText = 'display:flex;flex-direction:column;gap:7px;margin-top:10px'; box.append(searchResults);
    searchView.append(box);

    whisperView = te('div'); whisperView.id = 'fbMbWhisper';
    const head = te('div', 'fbMbHeader'); whisperTitle = te('div', 'fbMbTitle', 'WHISPER'); whisperTitle.style.fontSize = 'clamp(14px,2.6vh,22px)';
    const x = te('button', 'fbMbClose', '×'); x.type = 'button'; x.addEventListener('click', closeWhisper);
    head.append(whisperTitle, x);
    whisperLog = te('div'); whisperLog.id = 'fbMbWhisperLog';
    const wrow = te('div', 'fbMbRow'); wrow.style.flexWrap = 'nowrap';
    whisperInput = te('input', 'fbMbInput'); whisperInput.maxLength = 300; whisperInput.placeholder = 'Bisik ke teman…'; whisperInput.autocomplete = 'off';
    whisperInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendWhisper(); } });
    const send = te('button', 'fbMbButton', 'KIRIM'); send.type = 'button'; send.addEventListener('click', sendWhisper);
    wrow.append(whisperInput, send);
    whisperView.append(head, whisperLog, wrow);
    return [friendsView, searchView];
  }

  function relRow(f, mode) {
    const row = te('div', 'fbMbFriend');
    const b = rankBadge(f.rank_tier);
    if (b) { const im = te('img', 'rk'); im.src = b; im.alt = rankName(f.rank_tier); row.append(im); } else row.append(te('div', 'rkNone'));
    const mid = te('div');
    const nm = te('div', 'fbMbFName'); const dot = te('span', 'fbMbOn' + (f.online ? '' : ' fbMbOff')); nm.append(dot, document.createTextNode(f.nickname));
    mid.append(nm, te('div', 'fbMbFMeta', 'ID ' + f.pid + ' • ' + (rankName(f.rank_tier) || '') + (f.online ? ' • online' : ' • offline')));
    row.append(mid);
    return row;
  }
  function renderFriends() {
    if (!friendsBody) return;
    const pid = myPid();
    myIdLine.replaceChildren();
    myIdLine.append(document.createTextNode('ID kamu: '), (() => { const b = te('b', '', pid || '—'); return b; })());
    const cp = te('button', 'fbMbMini alt', 'SALIN'); cp.type = 'button';
    cp.addEventListener('click', async () => { try { await navigator.clipboard.writeText(pid); showNotice('ID ' + pid + ' disalin.'); } catch (_) { showNotice('ID kamu: ' + pid); } });
    if (pid) myIdLine.append(cp);
    friendsBody.replaceChildren();
    if (socialError) { friendsBody.append(te('div', 'fbMbEmpty', socialError)); return; }
    const incoming = friendsData.filter(f => f.status === 'pending' && f.incoming);
    const outgoing = friendsData.filter(f => f.status === 'pending' && !f.incoming);
    const friends = friendsData.filter(f => f.status === 'accepted');
    if (incoming.length) {
      friendsBody.append(te('div', 'fbMbSec', 'PERMINTAAN MASUK (' + incoming.length + ')'));
      incoming.forEach(f => {
        const row = relRow(f); const act = te('div', 'fbMbFAct');
        const ok = te('button', 'fbMbMini', 'TERIMA'); ok.type = 'button'; ok.addEventListener('click', () => answerRequest(f, true));
        const no = te('button', 'fbMbMini bad', 'TOLAK'); no.type = 'button'; no.addEventListener('click', () => answerRequest(f, false));
        act.append(ok, no); row.append(act); friendsBody.append(row);
      });
    }
    const onlineN = friends.filter(f => f.online).length;
    friendsBody.append(te('div', 'fbMbSec', 'TEMAN (' + onlineN + ' ONLINE / ' + friends.length + ')'));
    if (!friends.length) friendsBody.append(te('div', 'fbMbEmpty', 'Belum ada teman. Buka tab CARI, masukkan nama atau ID temanmu lalu tekan TAMBAH.'));
    friends.forEach(f => {
      const row = relRow(f); const act = te('div', 'fbMbFAct');
      const inv = te('button', 'fbMbMini', 'UNDANG'); inv.type = 'button'; inv.disabled = !f.online;
      inv.title = f.online ? 'Undang ke lobi' : 'Teman sedang offline';
      inv.addEventListener('click', () => inviteFriend(f));
      const wh = te('button', 'fbMbMini alt', 'WHISPER'); wh.type = 'button'; wh.addEventListener('click', () => openWhisper(f));
      if (f.unread > 0) { const d = te('span', 'fbMbDot show', String(f.unread > 9 ? '9+' : f.unread)); wh.append(d); }
      const rm = te('button', 'fbMbMini bad', '✕'); rm.type = 'button'; rm.title = 'Hapus teman'; rm.addEventListener('click', () => removeFriend(f));
      act.append(inv, wh, rm); row.append(act); friendsBody.append(row);
    });
    if (outgoing.length) {
      friendsBody.append(te('div', 'fbMbSec', 'PERMINTAAN TERKIRIM'));
      outgoing.forEach(f => {
        const row = relRow(f); const act = te('div', 'fbMbFAct');
        const c = te('button', 'fbMbMini alt', 'BATAL'); c.type = 'button'; c.addEventListener('click', () => removeFriend(f, true));
        act.append(c); row.append(act); friendsBody.append(row);
      });
    }
  }

  async function refreshFriends(quiet) {
    const { data, error } = await rpc('list_mabar_friends');
    if (error) { if (quiet) return; throw error; }
    socialError = '';
    friendsData = data || [];
    unreadTotal = friendsData.reduce((s, f) => s + (f.status === 'accepted' ? (f.unread | 0) : 0), 0);
    pendingIn = friendsData.filter(f => f.status === 'pending' && f.incoming).length;
    renderFriends(); updateBadge();
    friendsData.filter(f => f.status === 'pending' && f.incoming).forEach(f => {
      const k = 'req:' + f.friendship_id; if (seenToast.has(k)) return; seenToast.add(k);
      popToast('<b>' + esc(f.nickname) + '</b> ingin berteman denganmu.', [['LIHAT', () => { showPanel(); setTab('friends'); }]]);
    });
    if (currentRoom) renderRoom();
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function answerRequest(f, accept) {
    try {
      const { error } = await rpc('respond_friend_request', { p_id: f.friendship_id, p_accept: accept });
      if (error) throw error;
      showNotice(accept ? f.nickname + ' sekarang temanmu.' : 'Permintaan ditolak.');
      await refreshFriends(false);
    } catch (e) { showNotice(errorMessage(e), true); }
  }
  async function removeFriend(f, cancel) {
    if (!cancel && !confirm('Hapus ' + f.nickname + ' dari daftar teman?')) return;
    try {
      const { error } = await rpc('remove_friend', { p_other: f.user_id });
      if (error) throw error;
      showNotice(cancel ? 'Permintaan dibatalkan.' : 'Teman dihapus.');
      await refreshFriends(false);
    } catch (e) { showNotice(errorMessage(e), true); }
  }

  // ---------- cari ----------
  async function doSearch() {
    const q = (searchInput.value || '').trim();
    if (q.length < 2) { showNotice('Ketik minimal 2 huruf nama atau 8 digit ID.', true); return; }
    searchResults.replaceChildren(te('div', 'fbMbEmpty', 'Mencari…'));
    try {
      await ensureSocial();
      const { data, error } = await rpc('search_mabar_profiles', { p_query: q });
      if (error) throw error;
      searchResults.replaceChildren();
      showNotice((data || []).length ? 'Ditemukan ' + data.length + ' pemain.' : 'Tidak ada pemain ditemukan.');
      if (!data || !data.length) { searchResults.append(te('div', 'fbMbEmpty', 'Tidak ada pemain dengan nama/ID itu. Pastikan temanmu sudah membuka game versi terbaru.')); return; }
      data.forEach(p => {
        const row = relRow(p); const act = te('div', 'fbMbFAct');
        const b = te('button', 'fbMbMini'); b.type = 'button';
        if (p.relation === 'friend') { b.textContent = 'TEMAN ✓'; b.disabled = true; b.classList.add('alt'); }
        else if (p.relation === 'sent') { b.textContent = 'MENUNGGU'; b.disabled = true; b.classList.add('alt'); }
        else { b.textContent = p.relation === 'received' ? 'TERIMA' : 'TAMBAH'; b.addEventListener('click', () => addFriend(p, b)); }
        act.append(b); row.append(act); searchResults.append(row);
      });
    } catch (e) { searchResults.replaceChildren(); showNotice(errorMessage(e), true); }
  }
  async function addFriend(p, btn) {
    btn.disabled = true;
    try {
      const { data, error } = await rpc('send_friend_request', { p_target: p.user_id });
      if (error) throw error;
      btn.classList.add('alt');
      if (data === 'accepted') { btn.textContent = 'TEMAN ✓'; showNotice(p.nickname + ' sekarang temanmu.'); }
      else if (data === 'already_friends') { btn.textContent = 'TEMAN ✓'; showNotice('Sudah berteman.'); }
      else { btn.textContent = 'MENUNGGU'; showNotice('Permintaan dikirim ke ' + p.nickname + '.'); }
      refreshFriends(true).catch(() => {});
    } catch (e) { btn.disabled = false; showNotice(errorMessage(e), true); }
  }

  // ---------- undang ke lobi ----------
  async function inviteFriend(f) {
    if (matchStarted) { showNotice('Sedang dalam pertandingan.', true); return; }
    try {
      await ensureClient();
      if (!currentRoom) await attemptResumeRoom();
      if (!currentRoom) {
        showNotice('Membuat lobi…');
        const { data, error } = await mabarClient.rpc('create_mabar_room', { p_nickname: nickname(), p_max_players: 4 });
        if (error) throw error;
        await activateRoom(data);
      }
      if (currentRoom.status !== 'waiting') { showNotice('Lobi sudah dimulai.', true); return; }
      const { error } = await mabarClient.rpc('invite_mabar_friend', { p_friend: f.user_id, p_room_id: currentRoom.id });
      if (error) throw error;
      showNotice('Undangan dikirim ke ' + f.nickname + '. Lihat di tab LOBI.');
    } catch (e) { showNotice(errorMessage(e), true); }
  }
  async function pullInvites() {
    if (!authUser || !mabarClient) return;
    const since = new Date(Date.now() - 170000).toISOString();
    const { data, error } = await mabarClient.from('mabar_invites').select('id,from_user,from_nick,room_id,code,created_at')
      .eq('to_user', authUser.id).gt('created_at', since).order('created_at', { ascending: false }).limit(4);
    if (error || !data) return;
    data.forEach(inv => {
      const k = 'inv:' + inv.id; if (seenToast.has(k)) return; seenToast.add(k);
      if (matchStarted || matchStarting) return;
      popToast('<b>' + esc(inv.from_nick) + '</b> mengundangmu ke lobi.', [
        ['TERIMA', () => acceptInvite(inv)], ['TOLAK', () => dismissInvite(inv)]
      ], 45000);
    });
  }
  async function dismissInvite(inv) { try { await rpc('dismiss_mabar_invite', { p_id: inv.id }); } catch (_) {} }
  async function acceptInvite(inv) {
    if (matchStarted || matchStarting) { showNotice('Selesaikan pertandingan dulu.', true); return; }
    showPanel(); activeTab = 'lobby';
    try {
      await ensureClient();
      if (currentRoom && currentRoom.id !== inv.room_id) {
        const old = currentRoom.id;
        try { await mabarClient.rpc('leave_mabar_room', { p_room_id: old }); } catch (_) {}
        await clearLocalRoom(false);
      }
      if (!currentRoom) {
        showNotice('Bergabung ke lobi ' + inv.from_nick + '…');
        const { data, error } = await mabarClient.rpc('join_mabar_room', { p_code: inv.code, p_nickname: nickname() });
        if (error) throw error;
        await activateRoom(data);
        showNotice('Kamu bergabung ke lobi ' + inv.from_nick + '. Tekan READY.');
      }
      showRoomView(); applyViews();
      dismissInvite(inv);
    } catch (e) { showNotice(errorMessage(e), true); applyViews(); }
  }

  // ---------- whisper ----------
  function appendWhisper(m) {
    const mine = authUser && m.from_user === authUser.id;
    const d = te('div', 'fbMbWMsg ' + (mine ? 'me' : 'them'));
    d.append(document.createTextNode(String(m.body || '').slice(0, 300)));
    const dt = new Date(m.created_at || Date.now());
    d.append(te('small', '', Number.isNaN(dt.getTime()) ? '' : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    whisperLog.append(d);
    while (whisperLog.children.length > 80) whisperLog.firstChild.remove();
  }
  async function loadWhispers() {
    if (!whisperWith || !authUser) return;
    const me = authUser.id, other = whisperWith.user_id;
    const { data, error } = await mabarClient.from('mabar_whispers').select('id,from_user,from_nick,body,created_at')
      .or('and(from_user.eq.' + me + ',to_user.eq.' + other + '),and(from_user.eq.' + other + ',to_user.eq.' + me + ')')
      .order('created_at', { ascending: false }).limit(60);
    if (error) throw error;
    whisperLog.replaceChildren(); (data || []).slice().reverse().forEach(appendWhisper);
    whisperLog.scrollTop = whisperLog.scrollHeight;
    Promise.resolve(mabarClient.rpc('mark_mabar_whispers_read', { p_from: other })).then(() => refreshFriends(true).catch(() => {}), () => {});
  }
  async function openWhisper(f) {
    showPanel();
    whisperWith = { user_id: f.user_id, nickname: f.nickname };
    whisperTitle.textContent = 'WHISPER • ' + f.nickname;
    whisperLog.replaceChildren(); whisperView.classList.add('show');
    try { await ensureClient(); await loadWhispers(); } catch (e) { showNotice(errorMessage(e), true); }
    setTimeout(() => whisperInput && whisperInput.focus(), 80);
  }
  function closeWhisper() { whisperWith = null; if (whisperView) whisperView.classList.remove('show'); }
  async function sendWhisper() {
    if (!whisperWith) return;
    const body = (whisperInput.value || '').trim(); if (!body) return;
    if (body.length > 300) { showNotice('Pesan maksimal 300 karakter.', true); return; }
    try {
      const { error } = await rpc('send_mabar_whisper', { p_to: whisperWith.user_id, p_body: body });
      if (error) throw error;
      whisperInput.value = ''; await loadWhispers();
    } catch (e) { showNotice(errorMessage(e), true); }
  }
  function onWhisperIn(m) {
    if (!m) return;
    const viewing = whisperWith && whisperWith.user_id === m.from_user && whisperView && whisperView.classList.contains('show') && panel && panel.classList.contains('show');
    if (viewing) { appendWhisper(m); whisperLog.scrollTop = whisperLog.scrollHeight; Promise.resolve(mabarClient.rpc('mark_mabar_whispers_read', { p_from: m.from_user })).then(() => {}, () => {}); return; }
    refreshFriends(true).catch(() => {});
    if (matchStarted) return;
    popToast('<b>' + esc(m.from_nick) + '</b> (whisper): ' + esc(String(m.body).slice(0, 80)), [
      ['BALAS', () => { const f = friendOf(m.from_user) || { user_id: m.from_user, nickname: m.from_nick }; openWhisper(f); setTab('friends'); }]
    ], 12000);
  }

  // ---------- notifikasi ----------
  function popToast(html, actions, ttl) {
    if (!toastBox) { toastBox = te('div'); toastBox.id = 'fbMbToasts'; document.body.append(toastBox); }
    while (toastBox.children.length >= 3) toastBox.firstChild.remove();
    const t = te('div', 'fbMbToast'); const msg = te('div', 't'); msg.innerHTML = html; t.append(msg);
    (actions || []).forEach(([label, fn], i) => {
      const b = te('button', 'fbMbMini' + (i ? ' alt' : ''), label); b.type = 'button';
      b.addEventListener('click', () => { t.remove(); try { fn(); } catch (_) {} }); t.append(b);
    });
    toastBox.append(t); setTimeout(() => t.remove(), ttl || 9000);
  }

  // ---------- start / realtime ----------
  async function registerProfile() {
    const pid = myPid(); if (!pid) return false;
    const { error } = await rpc('upsert_mabar_profile', { p_pid: pid, p_nickname: nickname(), p_rank: myRankTier() });
    if (error) throw error; return true;
  }
  async function ensureSocial() { if (!socialStarted) await startSocial(); }
  async function startSocial() {
    if (socialStarted) return;
    try {
      await ensureClient();
      if (!(await registerProfile())) return;
      socialStarted = true; socialError = '';
      await refreshFriends(true); await pullInvites();
      subscribeSocial();
      beatTimer = setInterval(() => {
        beatN++;
        Promise.resolve(beatN % 6 === 0 ? registerProfile() : mabarClient.rpc('touch_mabar_profile')).then(() => {}, () => {});
        if (beatN % 18 === 0) Promise.resolve(mabarClient.rpc('sweep_mabar_social')).then(() => {}, () => {});
      }, 20000);
      pollTimer = setInterval(() => { refreshFriends(true).catch(() => {}); pullInvites().catch(() => {}); }, SOC_POLL_MS);
    } catch (e) {
      socialStarted = false; socialRetryAt = Date.now() + 60000;
      socialError = errorMessage(e); renderFriends();
      if (!/Koneksi/i.test(socialError)) console.warn('[MABAR] social:', socialError);
    }
  }
  function subscribeSocial() {
    if (socialChannel) { try { mabarClient.removeChannel(socialChannel); } catch (_) {} socialChannel = null; }
    const uid = authUser.id;
    socialChannel = mabarClient.channel('mabar-social:' + uid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mabar_invites', filter: 'to_user=eq.' + uid }, () => { pullInvites().catch(() => {}); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mabar_whispers', filter: 'to_user=eq.' + uid }, p => onWhisperIn(p && p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mabar_friendships', filter: 'addressee=eq.' + uid }, () => { refreshFriends(true).catch(() => {}); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mabar_friendships', filter: 'requester=eq.' + uid }, () => { refreshFriends(true).catch(() => {}); })
      .subscribe();
  }
  function watchLobbyForSocial() {
    setInterval(() => {
      if (socialStarted || Date.now() < socialRetryAt) return;
      const lob = document.getElementById('lobby'); if (!lob || !lob.classList.contains('active')) return;
      if (!myPid()) return;
      let n = ''; try { n = (window.PStore && PStore.getItem('fb_nickname')) || localStorage.getItem('fb_nickname') || ''; } catch (_) {}
      if (!n) return;
      startSocial();
    }, 2500);
  }
  function syncLobbyParty() {
    try {
      if (!window.fbLobby3D) return;
      window.fbLobby3D.setParty(currentRoom && currentRoom.status !== 'closed'
        ? roomPlayers.filter(p => p.user_id !== authUser?.id).map(p => ({ id: p.user_id, nick: p.nickname })) : []);
    } catch (_) {}
  }
  window.fbSocial = { open: tab => { showPanel(); setTab(tab || 'friends'); } };
  window.fbMabarInRoom = () => !!(currentRoom && currentRoom.status !== 'closed');

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialLobbyWiring, { once: true });
  else initialLobbyWiring();
})();
