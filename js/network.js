import { loadFirebaseConfig, isFirebaseConfigured } from './firebase-config.js';

const FIREBASE_APP_CDN = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
const FIREBASE_DB_CDN = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

/**
 * Layer Multiplayer / Co-op Realtime cross-browser (iPhone / Android / Desktop):
 * 1) Firebase Realtime Database (se configurato in firebase-config.js o dal modale)
 * 2) PeerJS WebRTC P2P automatico via Internet con solo link/codice stanza (zero server/account richiesti)
 * 3) BroadcastChannel + snapshot localStorage simultanei per schede locali sullo stesso dispositivo
 */
export class RealtimeNetwork {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.playerId = `p-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`;
    this.roomId = 'solo';
    this.mode = 'local'; // 'local' | 'p2p' | 'firebase'
    this.coopRole = 'host'; // 'host' | 'guest' | 'solo'
    this.maxPeers = 0; // 0 = illimitati (Co-op), 1 = 1v1 stretto
    this.modeLabel = 'CO-OP';
    this.statusLabel = 'Singleplayer';
    this.remotePlayers = new Map();

    this.channel = null;
    this.peer = null;
    this.peerConns = new Set();
    this._retryTimer = null;
    this._sessionToken = 0;
    this._lastSnapshot = null;

    this.fbDb = null;
    this.fbApi = null;
    this.unsubFns = [];
    this.syncAccum = 0;
    this._stateSeq = 0;
    this._prevPubPos = null;
    this._prevPubMs = 0;
    this.processedHits = new Set();
    this.processedEvents = new Set();
  }

  _storageKey(room) {
    return `maze_royale_2_room_snapshot_${room}`;
  }

  _hostPeerId(room) {
    return `mazeroyale2-v15-${String(room || '').toLowerCase()}`;
  }

  _getDistinctPeerIds() {
    const ids = new Set();
    for (const c of this.peerConns) {
      if (!c || c.open === false) continue;
      const pid = c.peer || c._remotePid;
      if (pid) ids.add(pid);
    }
    return ids;
  }

  saveLocalSnapshot(snapshot) {
    if (this.coopRole === 'solo' || !this.roomId || this.roomId === 'solo') return;
    try {
      localStorage.setItem(this._storageKey(this.roomId), JSON.stringify({ ...snapshot, updatedAt: Date.now() }));
    } catch (_) {}
  }

  loadLocalSnapshot(room) {
    try {
      const raw = localStorage.getItem(this._storageKey(room));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Date.now() - (parsed.updatedAt || 0) < 3600 * 1000) {
        return parsed;
      }
    } catch (_) {}
    return null;
  }

  async connect(roomId = 'labyrinth-1', role = 'solo', opts = {}) {
    this.disconnect();
    const myToken = this._sessionToken;
    this.coopRole = role;
    this.maxPeers = Number(opts.maxPeers) || 0;
    this.modeLabel = opts.modeLabel || 'CO-OP';
    const cleanRoom = String(roomId || 'labyrinth-1').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24) || '1000';
    this.roomId = cleanRoom;

    if (role === 'solo') {
      this.mode = 'local';
      this.statusLabel = 'Singleplayer';
      this.handlers.onStatusChange?.(this.statusLabel, 'solo');
      return;
    }

    const fbCfg = loadFirebaseConfig();
    if (isFirebaseConfigured(fbCfg)) {
      try {
        await this._connectFirebase(fbCfg, myToken);
        return;
      } catch (err) {
        console.warn('Firebase connection failed, falling back to PeerJS/local:', err);
      }
    }

    this._connectLocalAndP2P(myToken);
  }

  _connectLocalAndP2P(myToken) {
    this.mode = 'local';
    this.statusLabel = `${this.modeLabel} (${this.roomId})`;
    this.handlers.onStatusChange?.(this.statusLabel, this.mode);

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`maze_royale_2_${this.roomId}`);
      this.channel.onmessage = (ev) => this._handlePeerMessage(ev.data, null);
      this.channel.postMessage({ type: 'HELLO', from: this.playerId, role: this.coopRole, at: Date.now() });
    }

    if (this.coopRole === 'guest') {
      const snap = this.loadLocalSnapshot(this.roomId);
      if (snap) {
        this.handlers.onFullRoomSync?.(snap);
      }
    }

    if (typeof window !== 'undefined' && typeof window.Peer === 'function') {
      this._initPeerJS(myToken);
    }
  }

  _onIncomingConnection(conn, myToken) {
    if (myToken !== this._sessionToken) {
      try { conn.close(); } catch (_) {}
      return;
    }
    if (this.maxPeers > 0) {
      const peers = this._getDistinctPeerIds();
      const incomingPeer = conn?.peer;
      if (peers.size >= this.maxPeers && (!incomingPeer || !peers.has(incomingPeer))) {
        const rejectConn = () => {
          try { conn.send({ type: 'ROOM_FULL', from: this.playerId }); } catch (_) {}
          setTimeout(() => { try { conn.close(); } catch (_) {} }, 50);
        };
        if (conn.open) rejectConn();
        else conn.on?.('open', rejectConn);
        return;
      }
    }
    this._attachDataConn(conn, myToken);
  }

  _initPeerJS(myToken, hostRetries = 0) {
    if (myToken !== this._sessionToken) return;
    const peerOpts = { debug: 0, config: { iceServers: ICE_SERVERS } };
    const hostPeerId = this._hostPeerId(this.roomId);

    if (this.coopRole === 'host') {
      let peer;
      try {
        peer = new window.Peer(hostPeerId, peerOpts);
      } catch (_) {
        return;
      }
      this.peer = peer;
      this.mode = 'p2p';

      peer.on('open', () => {
        if (myToken !== this._sessionToken) return;
        this.statusLabel = `${this.modeLabel} Link (${this.roomId})`;
        this.handlers.onStatusChange?.(this.statusLabel, 'p2p');
      });

      peer.on('connection', (conn) => {
        this._onIncomingConnection(conn, myToken);
      });

      peer.on('error', (err) => {
        if (myToken !== this._sessionToken) return;
        if (err?.type === 'unavailable-id' && hostRetries < 3) {
          try { peer.destroy(); } catch (_) {}
          this.peer = null;
          clearTimeout(this._retryTimer);
          this._retryTimer = setTimeout(() => this._initPeerJS(myToken, hostRetries + 1), 1400);
          return;
        }
        this.statusLabel = `${this.modeLabel} Locale (${this.roomId})`;
        this.handlers.onStatusChange?.(this.statusLabel, 'local');
      });
    } else if (this.coopRole === 'guest') {
      let peer;
      try {
        peer = new window.Peer(undefined, peerOpts);
      } catch (_) {
        return;
      }
      this.peer = peer;
      this.mode = 'p2p';
      this.statusLabel = `Connessione ${this.roomId}...`;
      this.handlers.onStatusChange?.(this.statusLabel, 'p2p');

      let guestAttempts = 0;
      const dialHost = () => {
        if (myToken !== this._sessionToken || !this.peer || this.peer.destroyed) return;
        guestAttempts += 1;
        let conn;
        try {
          conn = this.peer.connect(hostPeerId, { label: 'ctrl', reliable: true });
        } catch (_) {
          return;
        }
        this._attachDataConn(conn, myToken, () => {
          if (myToken !== this._sessionToken) return;
          const hasCtrl = [...this.peerConns].some((c) => c.label !== 'pos');
          if (!hasCtrl && guestAttempts < 25) {
            this.statusLabel = `Cerco stanza ${this.roomId}...`;
            this.handlers.onStatusChange?.(this.statusLabel, 'p2p');
            clearTimeout(this._retryTimer);
            this._retryTimer = setTimeout(dialHost, 2000);
          }
        }, () => {
          // Apre subito il secondo canale veloce non-ordinato 'pos' (UDP-like) per posizioni fluide a 30Hz senza blocchi
          if (myToken !== this._sessionToken || !this.peer || this.peer.destroyed) return;
          try {
            const posConn = this.peer.connect(hostPeerId, { label: 'pos', reliable: false });
            this._attachDataConn(posConn, myToken);
          } catch (_) {}
        });
      };

      peer.on('open', () => {
        if (myToken !== this._sessionToken) return;
        dialHost();
      });

      peer.on('error', (err) => {
        if (myToken !== this._sessionToken) return;
        if (err?.type === 'peer-unavailable' && guestAttempts < 25) {
          this.statusLabel = `In attesa Host (${this.roomId})...`;
          this.handlers.onStatusChange?.(this.statusLabel, 'p2p');
          clearTimeout(this._retryTimer);
          this._retryTimer = setTimeout(dialHost, 2000);
        }
      });
    }
  }

  _attachDataConn(conn, myToken, onClosedNoPeers = null, onCtrlOpened = null) {
    if (!conn) return;
    let opened = false;
    const isPosChannel = conn.label === 'pos';

    const handleOpen = () => {
      if (opened || myToken !== this._sessionToken) return;
      opened = true;
      this.peerConns.add(conn);
      if (isPosChannel) return;

      clearTimeout(this._retryTimer);
      this.statusLabel = `${this.modeLabel} Online (${this.roomId})`;
      this.handlers.onStatusChange?.(this.statusLabel, 'p2p');

      try {
        conn.send({ type: 'HELLO', from: this.playerId, role: this.coopRole, at: Date.now() });
        if (this.coopRole === 'host' && this._lastSnapshot) {
          conn.send({ type: 'FULL_SYNC', from: this.playerId, snapshot: this._lastSnapshot });
        }
      } catch (_) {}

      if (typeof onCtrlOpened === 'function') {
        onCtrlOpened();
      }
    };

    if (conn.open) {
      handleOpen();
    } else {
      conn.on('open', handleOpen);
    }

    conn.on('data', (msg) => {
      if (myToken !== this._sessionToken) return;
      if (msg && msg.from && !isPosChannel) conn._remotePid = msg.from;
      this._handlePeerMessage(msg, conn);
    });

    const cleanup = () => {
      this.peerConns.delete(conn);
      if (!isPosChannel && conn._remotePid && this.remotePlayers.has(conn._remotePid)) {
        this.remotePlayers.delete(conn._remotePid);
        this.handlers.onPlayersUpdate?.(this.remotePlayers);
      }
      if (!isPosChannel && myToken === this._sessionToken && typeof onClosedNoPeers === 'function') {
        onClosedNoPeers();
      }
    };

    conn.on('close', cleanup);
    conn.on('error', cleanup);
  }

  _broadcastLocalAndP2P(msg, excludeConn = null) {
    if (this.channel) {
      try {
        this.channel.postMessage(msg);
      } catch (_) {}
    }

    if (msg.type === 'STATE') {
      // Usa il canale veloce 'pos' se aperto; fallback su 'ctrl'
      const posTargets = [];
      const fallbackTargets = [];
      for (const conn of this.peerConns) {
        if (conn === excludeConn || !conn.open) continue;
        if (conn.label === 'pos') posTargets.push(conn);
        else fallbackTargets.push(conn);
      }
      const list = posTargets.length > 0 ? posTargets : fallbackTargets;
      for (const conn of list) {
        try { conn.send(msg); } catch (_) {}
      }
      return;
    }

    for (const conn of this.peerConns) {
      if (conn === excludeConn || !conn.open || conn.label === 'pos') continue;
      try {
        conn.send(msg);
      } catch (_) {}
    }
  }

  _handlePeerMessage(msg, sourceConn = null) {
    if (!msg || msg.from === this.playerId) return;

    if (msg.type === 'ROOM_FULL') {
      if (!msg.targetId || msg.targetId === this.playerId) {
        this.handlers.onRoomFull?.(msg);
      }
      return;
    }

    // BroadcastChannel: limita anche via tab locali in modalita' 1v1
    if (!sourceConn && this.coopRole === 'host' && this.maxPeers > 0 && msg.type === 'HELLO') {
      if (this.remotePlayers.size >= this.maxPeers && !this.remotePlayers.has(msg.from)) {
        try {
          this.channel?.postMessage({ type: 'ROOM_FULL', from: this.playerId, targetId: msg.from });
        } catch (_) {}
        return;
      }
    }

    // Se l'host ha piu' peer connessi, inoltra i messaggi P2P agli altri peer sul canale giusto
    if (sourceConn && this.coopRole === 'host') {
      if (msg.type === 'STATE') {
        for (const conn of this.peerConns) {
          if (conn !== sourceConn && conn.open && conn.label === sourceConn.label) {
            try { conn.send(msg); } catch (_) {}
          }
        }
      } else if (['PAGE_EVENT', 'CHEST_OPENED', 'LEVEL_ADVANCE', 'DUEL_WIN', 'DUEL_RESET', 'HIT', 'HIT_RESULT', 'BYE'].includes(msg.type)) {
        for (const conn of this.peerConns) {
          if (conn !== sourceConn && conn.open && conn.label !== 'pos') {
            try { conn.send(msg); } catch (_) {}
          }
        }
      }
    }

    if (msg.type === 'HELLO') {
      this.handlers.onPeerHello?.(msg.from);
    } else if (msg.type === 'ROOM_META') {
      this.handlers.onRoomMeta?.(msg.meta);
    } else if (msg.type === 'FULL_SYNC') {
      this.handlers.onFullRoomSync?.(msg.snapshot);
    } else if (msg.type === 'STATE') {
      const prev = this.remotePlayers.get(msg.state.id);
      // Ignora pacchetti di posizione arrivati fuori ordine rispetto a seq piu' recenti
      if (prev && typeof prev.seq === 'number' && typeof msg.state.seq === 'number' && msg.state.seq <= prev.seq) {
        return;
      }
      this.remotePlayers.set(msg.state.id, { ...msg.state, lastSeen: Date.now() });
      this.handlers.onPlayersUpdate?.(this.remotePlayers);
    } else if (msg.type === 'BYE') {
      this.remotePlayers.delete(msg.from);
      this.handlers.onPlayersUpdate?.(this.remotePlayers);
    } else if (msg.type === 'HIT' && msg.targetId === this.playerId) {
      if (!this.processedHits.has(msg.hitId)) {
        this.processedHits.add(msg.hitId);
        this.handlers.onIncomingHit?.(msg);
      }
    } else if (msg.type === 'HIT_RESULT' && msg.targetId === this.playerId) {
      const rk = `hr_${msg.eid || msg.hitId || Date.now()}`;
      if (!this.processedEvents.has(rk)) {
        this.processedEvents.add(rk);
        this.handlers.onHitResult?.(msg);
      }
    } else if (msg.type === 'DUEL_WIN') {
      this.handlers.onDuelWin?.(msg);
    } else if (msg.type === 'DUEL_RESET') {
      this.handlers.onDuelReset?.(msg);
    } else if (msg.type === 'PAGE_EVENT') {
      this.handlers.onPageEvent?.(msg.event);
    } else if (msg.type === 'CHEST_OPENED') {
      this.handlers.onChestOpened?.(msg.chestId);
    } else if (msg.type === 'LEVEL_ADVANCE') {
      this.handlers.onLevelAdvance?.(msg.level, msg.seed, msg.winnerName, msg.victory);
    }
  }

  async _connectFirebase(fbCfg, myToken) {
    const appMod = await import(FIREBASE_APP_CDN);
    const dbMod = await import(FIREBASE_DB_CDN);
    if (myToken !== this._sessionToken) return;

    const appName = `maze_${this.roomId}_${Date.now()}`;
    const app = appMod.initializeApp(fbCfg, appName);
    const db = dbMod.getDatabase(app);

    this.fbApi = dbMod;
    this.fbDb = db;
    this.mode = 'firebase';
    this.statusLabel = `${this.modeLabel} Online (${this.roomId})`;
    this.handlers.onStatusChange?.(this.statusLabel, this.mode);

    const base = `rooms/${this.roomId}`;
    const playerRef = dbMod.ref(db, `${base}/players/${this.playerId}`);
    dbMod.onDisconnect(playerRef).remove();

    if (this.coopRole === 'guest') {
      try {
        const metaSnap = await dbMod.get(dbMod.ref(db, `${base}/meta`));
        if (myToken !== this._sessionToken) return;
        if (metaSnap.exists()) {
          this.handlers.onFullRoomSync?.(metaSnap.val());
        }
      } catch (_) {}
    }

    const playersRef = dbMod.ref(db, `${base}/players`);
    this.unsubFns.push(
      dbMod.onValue(playersRef, (snap) => {
        const val = snap.val() || {};
        this.remotePlayers.clear();
        const now = Date.now();
        for (const [pid, p] of Object.entries(val)) {
          if (pid === this.playerId || !p) continue;
          if (now - (p.updatedAt || now) > 25000) continue;
          this.remotePlayers.set(pid, { ...p, id: pid, lastSeen: now });
        }
        this.handlers.onPlayersUpdate?.(this.remotePlayers);
      })
    );

    const myHitsRef = dbMod.ref(db, `${base}/hits/${this.playerId}`);
    this.unsubFns.push(
      dbMod.onValue(myHitsRef, (snap) => {
        const hits = snap.val();
        if (!hits) return;
        for (const [hitId, payload] of Object.entries(hits)) {
          if (this.processedHits.has(hitId)) continue;
          this.processedHits.add(hitId);
          this.handlers.onIncomingHit?.(payload);
          dbMod.remove(dbMod.ref(db, `${base}/hits/${this.playerId}/${hitId}`)).catch(() => null);
        }
      })
    );

    const myHitResRef = dbMod.ref(db, `${base}/hitResults/${this.playerId}`);
    this.unsubFns.push(
      dbMod.onValue(myHitResRef, (snap) => {
        const resMap = snap.val();
        if (!resMap) return;
        for (const [eid, payload] of Object.entries(resMap)) {
          const rk = `hr_${eid}`;
          if (this.processedEvents.has(rk)) continue;
          this.processedEvents.add(rk);
          this.handlers.onHitResult?.(payload);
          dbMod.remove(dbMod.ref(db, `${base}/hitResults/${this.playerId}/${eid}`)).catch(() => null);
        }
      })
    );

    const metaRef = dbMod.ref(db, `${base}/meta`);
    this.unsubFns.push(
      dbMod.onValue(metaRef, (snap) => {
        const meta = snap.val();
        if (!meta) return;
        if (meta.duelWinner && meta.duelWinner.winnerId !== this.playerId && !this.processedEvents.has(`dw_${meta.duelWinner.eventId}`)) {
          this.processedEvents.add(`dw_${meta.duelWinner.eventId}`);
          this.handlers.onDuelWin?.(meta.duelWinner);
          return;
        }
        if (meta.resetId && meta.resetFrom !== this.playerId && !this.processedEvents.has(`dr_${meta.resetId}`)) {
          this.processedEvents.add(`dr_${meta.resetId}`);
          this.handlers.onDuelReset?.({ level: meta.level, seed: meta.seed });
          return;
        }
        if (meta.victory && !this.processedEvents.has(`vic_${meta.eventId}`)) {
          this.processedEvents.add(`vic_${meta.eventId}`);
          this.handlers.onLevelAdvance?.(meta.level, meta.seed, meta.winnerName, true);
          return;
        }
        if (meta.seed) {
          this.handlers.onFullRoomSync?.(meta);
        }
      })
    );

    const eventsRef = dbMod.ref(db, `${base}/worldEvents`);
    this.unsubFns.push(
      dbMod.onValue(eventsRef, (snap) => {
        const ev = snap.val();
        if (!ev) return;
        if (ev.pageEvent && ev.pageEvent.from !== this.playerId && !this.processedEvents.has(ev.pageEvent.eid)) {
          this.processedEvents.add(ev.pageEvent.eid);
          this.handlers.onPageEvent?.(ev.pageEvent);
        }
        if (ev.lastChest && ev.lastChest.from !== this.playerId && !this.processedEvents.has(ev.lastChest.eid)) {
          this.processedEvents.add(ev.lastChest.eid);
          this.handlers.onChestOpened?.(ev.lastChest.chestId);
        }
      })
    );
  }

  publishFullRoomSync(snapshot) {
    if (this.coopRole === 'solo') return;
    this._lastSnapshot = snapshot;
    this.saveLocalSnapshot(snapshot);
    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      set(ref(this.fbDb, `rooms/${this.roomId}/meta`), { ...snapshot, updatedAt: Date.now() }).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'FULL_SYNC', from: this.playerId, snapshot });
    }
  }

  publishRoomMeta(meta) {
    if (this.coopRole === 'solo') return;
    this.publishFullRoomSync(meta);
  }

  publishPlayerState(dt, player, spawnSlot = 'A') {
    if (this.coopRole === 'solo') return;
    this.syncAccum += dt;
    const interval = this.mode === 'firebase' ? 0.065 : 0.033;
    if (this.syncAccum < interval) return;
    this.syncAccum = 0;

    const nowMs = Date.now();
    let vx = 0;
    let vz = 0;
    if (this._prevPubPos && this._prevPubMs) {
      const dtPub = Math.max(0.016, (nowMs - this._prevPubMs) / 1000);
      if (dtPub < 0.35) {
        vx = Math.max(-35, Math.min(35, (player.x - this._prevPubPos.x) / dtPub));
        vz = Math.max(-35, Math.min(35, (player.z - this._prevPubPos.z) / dtPub));
      }
    }
    this._prevPubPos = { x: player.x, z: player.z };
    this._prevPubMs = nowMs;
    this._stateSeq += 1;

    const payload = {
      id: this.playerId,
      seq: this._stateSeq,
      name: player.name,
      spawnSlot,
      x: Number(player.x.toFixed(3)),
      z: Number(player.z.toFixed(3)),
      vx: Number(vx.toFixed(2)),
      vz: Number(vz.toFixed(2)),
      rotY: Number(player.rotY.toFixed(3)),
      hp: Math.round(player.hp),
      maxHp: Math.round(player.maxHp),
      shieldActive: player.shieldActive,
      attacking: player.attackTimer > 0,
      alive: player.alive,
      pagesCount: player.collectedPages.length,
      updatedAt: nowMs
    };

    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      set(ref(this.fbDb, `rooms/${this.roomId}/players/${this.playerId}`), payload).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'STATE', from: this.playerId, state: payload });
    }
  }

  sendHit(targetId, damage, fromX, fromZ) {
    if (this.coopRole === 'solo') return;
    const hitId = `${this.playerId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const payload = { hitId, targetId, fromId: this.playerId, damage, fromX, fromZ, at: Date.now() };
    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      set(ref(this.fbDb, `rooms/${this.roomId}/hits/${targetId}/${hitId}`), payload).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'HIT', from: this.playerId, ...payload });
    }
  }

  sendHitResult(targetId, result = {}) {
    if (this.coopRole === 'solo') return;
    const eid = `${this.playerId}_hr_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    const payload = { ...result, eid, targetId, fromId: this.playerId, at: Date.now() };
    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      set(ref(this.fbDb, `rooms/${this.roomId}/hitResults/${targetId}/${eid}`), payload).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'HIT_RESULT', from: this.playerId, ...payload });
    }
  }

  publishDuelWin(level, winnerName, winnerPages = 5, winnerKills = 0) {
    if (this.coopRole === 'solo') return;
    const eventId = `${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    const duelWinner = {
      winnerId: this.playerId,
      winnerName,
      winnerPages,
      winnerKills,
      level,
      eventId
    };
    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      const baseSnap = this._lastSnapshot || { level, seed: 0, gameMode: 'duel_online', collectedPages: [], openedChests: [] };
      set(ref(this.fbDb, `rooms/${this.roomId}/meta`), { ...baseSnap, duelWinner, updatedAt: Date.now() }).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'DUEL_WIN', from: this.playerId, ...duelWinner });
    }
  }

  publishDuelReset(level, seed) {
    if (this.coopRole === 'solo') return;
    const resetId = `${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    const snapshot = {
      level,
      seed,
      gameMode: 'duel_online',
      collectedPages: [],
      openedChests: [],
      victory: false,
      duelWinner: null,
      resetId,
      resetFrom: this.playerId
    };
    this._lastSnapshot = snapshot;
    this.saveLocalSnapshot(snapshot);
    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      set(ref(this.fbDb, `rooms/${this.roomId}/meta`), { ...snapshot, updatedAt: Date.now() }).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'DUEL_RESET', from: this.playerId, level, seed });
    }
  }

  publishPageEvent(event) {
    if (this.coopRole === 'solo') return;
    const payload = { ...event, eid: `${this.playerId}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, from: this.playerId, at: Date.now() };
    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      set(ref(this.fbDb, `rooms/${this.roomId}/worldEvents/pageEvent`), payload).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'PAGE_EVENT', from: this.playerId, event: payload });
    }
  }

  publishChestOpened(chestId) {
    if (this.coopRole === 'solo') return;
    const payload = { chestId, eid: `${this.playerId}_${Date.now()}`, from: this.playerId, at: Date.now() };
    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      set(ref(this.fbDb, `rooms/${this.roomId}/worldEvents/lastChest`), payload).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'CHEST_OPENED', from: this.playerId, chestId });
    }
  }

  publishLevelAdvance(level, seed, winnerName, victory = false) {
    if (this.coopRole === 'solo') return;
    const snapshot = {
      level,
      seed,
      winnerName,
      victory,
      collectedPages: [],
      openedChests: [],
      eventId: `${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
    };
    this._lastSnapshot = snapshot;
    this.saveLocalSnapshot(snapshot);
    if (this.mode === 'firebase' && this.fbDb) {
      const { ref, set } = this.fbApi;
      set(ref(this.fbDb, `rooms/${this.roomId}/meta`), { ...snapshot, updatedAt: Date.now() }).catch(() => null);
    } else {
      this._broadcastLocalAndP2P({ type: 'LEVEL_ADVANCE', from: this.playerId, level, seed, winnerName, victory });
    }
  }

  pruneStaleLocalPeers() {
    if (this.mode === 'firebase') return;
    const now = Date.now();
    for (const [id, p] of this.remotePlayers.entries()) {
      if (now - (p.lastSeen || 0) > 7000) {
        this.remotePlayers.delete(id);
      }
    }
  }

  disconnect() {
    this._sessionToken += 1;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._lastSnapshot = null;

    for (const u of this.unsubFns) {
      try { u(); } catch (_) {}
    }
    this.unsubFns = [];

    if (this.mode === 'firebase' && this.fbDb && this.fbApi) {
      const { ref, remove } = this.fbApi;
      remove(ref(this.fbDb, `rooms/${this.roomId}/players/${this.playerId}`)).catch(() => null);
    }

    this._broadcastLocalAndP2P({ type: 'BYE', from: this.playerId });

    for (const conn of this.peerConns) {
      try { conn.close(); } catch (_) {}
    }
    this.peerConns.clear();

    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }

    if (this.channel) {
      try { this.channel.close(); } catch (_) {}
      this.channel = null;
    }
    this.remotePlayers.clear();
  }
}

/**
 * Smoothing client-side + dead-reckoning breve per rendere fluido a 60/120 FPS
 * il movimento di compagni ricevuti a ~30Hz su WebRTC/BroadcastChannel.
 */
export function stepInterpolatedPose(render, packet, dt) {
  if (!packet) return render;
  const px = Number(packet.x) || 0;
  const pz = Number(packet.z) || 0;
  const vx = Number(packet.vx) || 0;
  const vz = Number(packet.vz) || 0;
  const rot = Number(packet.rotY) || 0;
  const seq = typeof packet.seq === 'number' ? packet.seq : null;

  const jumpDist = render.initialized ? Math.hypot(px - render.x, pz - render.z) : 999;
  if (!render.initialized || jumpDist > 6.5) {
    render.initialized = true;
    render.x = px;
    render.z = pz;
    render.rotY = rot;
    render.targetX = px;
    render.targetZ = pz;
    render.vx = vx;
    render.vz = vz;
    render.rotTarget = rot;
    render.lastSeq = seq;
    render.sincePacket = 0;
    return render;
  }

  const isNewPacket = seq !== null
    ? seq !== render.lastSeq
    : (px !== render.targetX || pz !== render.targetZ || rot !== render.rotTarget);

  if (isNewPacket) {
    render.targetX = px;
    render.targetZ = pz;
    render.vx = vx;
    render.vz = vz;
    render.rotTarget = rot;
    render.lastSeq = seq;
    render.sincePacket = 0;
  } else {
    render.sincePacket = Math.min(0.25, (render.sincePacket || 0) + dt);
  }

  if (dt > 0) {
    const lookahead = Math.min(0.11, render.sincePacket);
    const goalX = render.targetX + render.vx * lookahead;
    const goalZ = render.targetZ + render.vz * lookahead;
    const posAlpha = Math.min(1, 1 - Math.exp(-20 * dt));
    render.x += (goalX - render.x) * posAlpha;
    render.z += (goalZ - render.z) * posAlpha;

    let dRot = (render.rotTarget - render.rotY) % (Math.PI * 2);
    if (dRot > Math.PI) dRot -= Math.PI * 2;
    if (dRot < -Math.PI) dRot += Math.PI * 2;
    const rotAlpha = Math.min(1, 1 - Math.exp(-22 * dt));
    render.rotY += dRot * rotAlpha;
  }

  return render;
}
