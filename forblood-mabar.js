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
    intro.append(te('div', 'fbMbLabel', 'PARTY MATCH'), te('div', '', 'Buat room private lalu bagikan kode ke teman. Identitas room menggunakan Supabase Auth; nickname hanya nama tampilan.'));
    const create = te('button', 'fbMbButton', 'CREATE ROOM • 4 PLAYERS'); create.id = 'fbMabarCreate'; create.type = 'button';
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
    const joinLabel = te('div', 'fbMbLabel', 'JOIN ROOM');
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
    footer.append(readyButton, startButton, closeRoomButton, leaveButton, back);
    roomView.append(roomHead, membersBlock, chatBlock, footer);
    card.append(header, statusEl, homeView, roomView); panel.append(card); document.body.append(panel);
    panel.addEventListener('click', e => { if (e.target === panel) hidePanel(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('show')) hidePanel(); });
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
  function showHomeView() { homeView.classList.add('active'); roomView.classList.remove('active'); }
  function showRoomView() { homeView.classList.remove('active'); roomView.classList.add('active'); renderRoom(); }

  function addLobbyButton() {
    injectStyles(); buildPanel();
    const hud = document.getElementById('lobHud');
    if (!hud || document.getElementById('fbMabarOpen')) return;
    const btn = te('button', '', 'MABAR'); btn.id = 'fbMabarOpen'; btn.type = 'button'; btn.setAttribute('aria-label', 'Buka lobby mabar online');
    btn.addEventListener('click', async () => {
      showPanel();
      if (!currentRoom) showNotice('Mabar memakai Supabase terpisah dari login dan diamond game.');
      try { await ensureClient(); await attemptResumeRoom(); } catch (e) { showNotice(errorMessage(e), true); }
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
      if (roomView) roomView.classList.remove('active');
      if (homeView) homeView.classList.add('active');
    }
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
    // Restore an existing Supabase anonymous identity's membership after refresh.
    let remembered = false;
    try { remembered = !!localStorage.getItem('fb_mabar_last_room'); } catch (_) {}
    if (remembered) ensureClient().then(attemptResumeRoom).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialLobbyWiring, { once: true });
  else initialLobbyWiring();
})();
