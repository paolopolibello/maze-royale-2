import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { generateSymmetricMaze } from './maze.js';
import { resolveMazeCollision, findSafeDropPosition } from './collision.js';
import { createSandstoneWallTexture, createFloorTexture, createChestTexture } from './textures.js';
import { PlayerCube, createXRayMaterial, getForwardAttackCenter } from './player.js';
import { WorldPage, LootChest, CenterDoor, EnemyBot } from './entities.js';
import { RivalBot } from './rival-bot.js';
import { GameControls } from './controls.js';
import { hasLineOfSight, isIlluminatedWithLoS } from './visibility.js';
import { RealtimeNetwork, stepInterpolatedPose } from './network.js';
import { loadFirebaseConfig, saveFirebaseConfig } from './firebase-config.js';
import { audio } from './audio.js';

/**
 * Rappresentazione visiva di un giocatore avversario/compagno multiplayer (Co-op ciano o 1v1 Rosso).
 * Rispetta rigorosamente lo stesso sistema X-Ray + invisibilita' totale nel buio e dietro i muri.
 */
class RemotePlayerVisual {
  constructor(id, scene, isCoop = true) {
    this.id = id;
    this.isCoop = isCoop;
    this.group = new THREE.Group();
    const s = CONFIG.PLAYER_SIZE;
    const half = s * 0.5;
    const bodyHex = isCoop ? 0x06b6d4 : 0xdc2626;
    const frontHex = isCoop ? 0x22d3ee : 0xfca5a5;
    const xrayHex = isCoop ? 0x06b6d4 : 0xef4444;
    this.defaultBodyHex = bodyHex;
    this.defaultFrontHex = frontHex;
    this._lastHp = null;
    this._hurtFlash = 0;

    this.bodyMat = new THREE.MeshStandardMaterial({ color: bodyHex, roughness: 0.45 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), this.bodyMat);
    body.position.y = half;
    body.renderOrder = 1;
    this.group.add(body);

    this.frontMat = new THREE.MeshStandardMaterial({ color: frontHex, roughness: 0.4 });
    const front = new THREE.Mesh(new THREE.BoxGeometry(s * 0.78, s * 0.66, 0.14), this.frontMat);
    front.position.set(0, half + 0.04, half + 0.03);
    front.renderOrder = 1;
    this.group.add(front);

    // Scudo frontale traslucido
    this.shieldPlate = new THREE.Mesh(
      new THREE.BoxGeometry(s * 1.16, s * 1.08, 0.12),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.46,
        depthWrite: false
      })
    );
    this.shieldPlate.position.set(0, half + 0.02, half + 0.24);
    this.shieldPlate.visible = false;
    this.shieldPlate.renderOrder = 12;
    this.group.add(this.shieldPlate);

    // Fendente spada completo (arco + barra)
    this.slashGroup = new THREE.Group();
    this.slashGroup.position.set(0, half + 0.05, CONFIG.ATTACK_OFFSET_Z);
    const bladeGeo = new THREE.RingGeometry(0.45, 1.52, 16, 1, -Math.PI * 0.72, Math.PI * 1.44);
    bladeGeo.rotateX(-Math.PI * 0.5);
    const slashMat = new THREE.MeshBasicMaterial({
      color: isCoop ? 0xffffff : 0xffe4e6,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.slashGroup.add(new THREE.Mesh(bladeGeo, slashMat));
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.18, 0.42), slashMat);
    bar.position.z = 0.22;
    this.slashGroup.add(bar);
    this.slashGroup.visible = false;
    this.slashGroup.renderOrder = 20;
    this.group.add(this.slashGroup);

    this.xrayMat = createXRayMaterial(xrayHex, 0.54);
    const xray = new THREE.Mesh(new THREE.BoxGeometry(s * 1.002, s * 1.002, s * 1.002), this.xrayMat);
    xray.position.y = half;
    xray.renderOrder = 50;
    this.group.add(xray);

    // Barra HP 3D sopra il cubo (visibile nel duello 1v1 quando illuminato)
    this.hpBarBg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.24, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x1e1b2e, side: THREE.DoubleSide })
    );
    this.hpBarBg.position.set(0, s + 0.52, 0);
    this.hpBarBg.rotation.x = -Math.PI * 0.22;
    this.hpBarBg.visible = !isCoop;
    this.group.add(this.hpBarBg);

    this.hpBarFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.18, 0.13),
      new THREE.MeshBasicMaterial({ color: isCoop ? 0x22c55e : 0xef4444, side: THREE.DoubleSide })
    );
    this.hpBarFill.position.set(0, s + 0.525, 0.01);
    this.hpBarFill.rotation.x = -Math.PI * 0.22;
    this.hpBarFill.visible = !isCoop;
    this.group.add(this.hpBarFill);

    this.group.visible = false;
    this.smoothPose = {
      initialized: false,
      x: 0,
      z: 0,
      rotY: 0,
      targetX: 0,
      targetZ: 0,
      vx: 0,
      vz: 0,
      rotTarget: 0,
      lastSeq: null,
      sincePacket: 0
    };
    scene.add(this.group);
  }

  getWorldPosition() {
    if (!this.smoothPose.initialized) return null;
    return { x: this.smoothPose.x, z: this.smoothPose.z };
  }

  sync(dt, data, maze, localPlayer) {
    if (!data || !data.alive) {
      this.group.visible = false;
      this.smoothPose.initialized = false;
      this._lastHp = data ? data.hp : null;
      return;
    }

    if (typeof data.hp === 'number') {
      if (this._lastHp !== null && data.hp < this._lastHp) {
        this._hurtFlash = 0.14;
      }
      this._lastHp = data.hp;
      const maxHp = Math.max(1, data.maxHp || CONFIG.PLAYER_MAX_HP);
      const hpPct = Math.max(0.02, Math.min(1, data.hp / maxHp));
      this.hpBarFill.scale.x = hpPct;
      this.hpBarFill.position.x = -(1 - hpPct) * 0.59;
    }

    if (this._hurtFlash > 0) {
      this._hurtFlash = Math.max(0, this._hurtFlash - dt);
      this.bodyMat.color.setHex(this._hurtFlash > 0 ? 0xffffff : this.defaultBodyHex);
    }

    stepInterpolatedPose(this.smoothPose, data, dt);
    const sx = this.smoothPose.x;
    const sz = this.smoothPose.z;
    const visible = localPlayer.alive && isIlluminatedWithLoS(maze, localPlayer.x, localPlayer.z, sx, sz, CONFIG.TORCH_RANGE);
    this.group.visible = visible;
    this.group.position.set(sx, 0, sz);
    this.group.rotation.y = this.smoothPose.rotY;
    this.shieldPlate.visible = Boolean(data.shieldActive);
    this.frontMat.color.setHex(data.shieldActive ? 0x38bdf8 : this.defaultFrontHex);
    this.slashGroup.visible = Boolean(data.attacking);
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}

class MazeRoyaleApp {
  constructor() {
    this.el = {
      canvas: document.getElementById('game-canvas'),
      loadingScreen: document.getElementById('loading-screen'),
      loadingBg: document.getElementById('loading-bg'),
      loadingFill: document.getElementById('loading-fill'),
      loadingPercent: document.getElementById('loading-percent'),
      loadingStep: document.getElementById('loading-step'),
      mainMenu: document.getElementById('main-menu'),
      btnMenuDuelBot: document.getElementById('btn-menu-duel-bot'),
      btnMenuCoopBots: document.getElementById('btn-menu-coop-bots'),
      btnMenuDuelOnline: document.getElementById('btn-menu-duel-online'),
      btnMenuSingle: document.getElementById('btn-menu-single'),
      btnMenuCoop: document.getElementById('btn-menu-coop'),
      btnMenuMulti: document.getElementById('btn-menu-multi'),
      btnMenuMusic: document.getElementById('btn-menu-music'),
      modalCoop: document.getElementById('modal-coop'),
      coopModalCard: document.getElementById('coop-modal-card'),
      coopModalTitle: document.getElementById('coop-modal-title'),
      coopModalSub: document.getElementById('coop-modal-sub'),
      coopHostLabel: document.getElementById('coop-host-label'),
      coopJoinLabel: document.getElementById('coop-join-label'),
      coopHostCode: document.getElementById('coop-host-code'),
      coopInviteLink: document.getElementById('coop-invite-link'),
      btnCoopCopy: document.getElementById('btn-coop-copy'),
      btnCoopShare: document.getElementById('btn-coop-share'),
      btnCoopHost: document.getElementById('btn-coop-host'),
      inpCoopCode: document.getElementById('inp-coop-code'),
      btnCoopJoin: document.getElementById('btn-coop-join'),
      btnCoopClose: document.getElementById('btn-coop-close'),
      pauseCoopShare: document.getElementById('pause-coop-share'),
      pauseCoopCode: document.getElementById('pause-coop-code'),
      btnPauseShare: document.getElementById('btn-pause-share'),
      victoryOverlay: document.getElementById('victory-overlay'),
      victoryBadge: document.getElementById('victory-badge'),
      victoryTitle: document.getElementById('victory-title'),
      victorySub: document.getElementById('victory-sub'),
      victoryStats: document.getElementById('victory-stats'),
      btnVictoryNext: document.getElementById('btn-victory-next'),
      btnVictoryRestart: document.getElementById('btn-victory-restart'),
      btnVictoryMenu: document.getElementById('btn-victory-menu'),
      respawnOverlay: document.getElementById('respawn-overlay'),
      respawnSub: document.getElementById('respawn-sub'),
      respawnCountdown: document.getElementById('respawn-countdown'),
      hudTop: document.getElementById('hud-top'),
      btnHudMusic: document.getElementById('btn-hud-music'),
      btnHudPause: document.getElementById('btn-hud-pause'),
      actionCluster: document.getElementById('action-cluster'),
      modalPause: document.getElementById('modal-pause'),
      btnPauseResume: document.getElementById('btn-pause-resume'),
      btnPauseMusic: document.getElementById('btn-pause-music'),
      btnPauseRestart: document.getElementById('btn-pause-restart'),
      btnPauseMenu: document.getElementById('btn-pause-menu'),
      btnDeathMenu: document.getElementById('btn-death-menu'),
      hpFill: document.getElementById('hp-fill'),
      hpText: document.getElementById('hp-text'),
      statsLine: document.getElementById('stats-line'),
      levelBadge: document.getElementById('level-badge'),
      pageSlots: document.getElementById('page-slots'),
      rivalHud: document.getElementById('rival-hud'),
      rivalHudLabel: document.getElementById('rival-hud-label'),
      rivalHudPages: document.getElementById('rival-hud-pages'),
      rivalHpFill: document.getElementById('rival-hp-fill'),
      rivalHudState: document.getElementById('rival-hud-state'),
      netStatus: document.getElementById('net-status'),
      toast: document.getElementById('toast-banner'),
      damageFlash: document.getElementById('damage-flash'),
      deathOverlay: document.getElementById('death-overlay'),
      deathStats: document.getElementById('death-stats'),
      deathHint: document.getElementById('death-hint'),
      btnRestartArcade: document.getElementById('btn-restart-arcade'),
      btnRespawnPvp: document.getElementById('btn-respawn-pvp'),
      joystickZone: document.getElementById('joystick-zone'),
      joystickBase: document.getElementById('joystick-base'),
      joystickKnob: document.getElementById('joystick-knob'),
      btnAttack: document.getElementById('btn-attack'),
      btnShield: document.getElementById('btn-shield'),
      btnDash: document.getElementById('btn-dash'),
      btnDashFill: document.querySelector('#btn-dash .cd-fill'),
      btnInteract: document.getElementById('btn-interact'),
      modalDoor: document.getElementById('modal-door'),
      doorSlots: document.getElementById('door-code-slots'),
      doorKeypad: document.getElementById('door-keypad'),
      doorHint: document.getElementById('door-hint'),
      modalNet: document.getElementById('modal-net'),
      inpRoom: document.getElementById('inp-room'),
      inpSpawnSide: document.getElementById('inp-spawn-side'),
      inpFbJson: document.getElementById('inp-fb-json'),
      btnOpenNet: document.getElementById('btn-open-net'),
      btnCloseNet: document.getElementById('btn-close-net'),
      btnSaveNet: document.getElementById('btn-save-net'),
      btnClearFb: document.getElementById('btn-clear-fb'),
      btnNewMaze: document.getElementById('btn-new-maze')
    };

    this.controls = new GameControls(this.el);

    this.screenState = 'LOADING'; // 'LOADING' | 'MENU' | 'PLAYING' | 'PAUSED' | 'GAMEOVER' | 'VICTORY'
    this.gameMode = 'single'; // 'single' | 'coop' | 'duel_bot' | 'duel_online' | 'coop_bots'
    this.pendingRoomModalMode = 'coop';
    this.netModalOpen = false;
    this.coopModalOpen = false;
    this.doorModalOpen = false;
    this.hostRoomCode = this._generateRoomCode('MR');
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    this.pendingInviteRoom = this._extractRoomCode(urlParams ? urlParams.get('room') : '');
    const rawModeParam = urlParams?.get('mode');
    this.pendingInviteMode = rawModeParam === 'coop_bots'
      ? 'coop_bots'
      : (rawModeParam === 'duel' ? 'duel_online' : 'coop');
    this._coopInitialSynced = false;
    this.sharedPages = [];
    this.rivalBots = [];
    this.rivalBot = null;
    this.rivalTeamPages = [];
    this.remoteRivalVisuals = new Map();
    this.remoteRivalState = null;
    this.rivalKills = 0;
    this.duelResult = null;
    this.level = 1;
    this.seed = Math.floor(Math.random() * 900000) + 1000;
    this.spawnSide = 'A';
    this.kills = 0;
    this.deadElapsed = 0;
    this.doorEntered = [];
    this.nearInteractable = null;
    this.elapsedSec = 0;
    this.lastTime = 0;

    this._initThree();
    this._bindModals();
    this._initNetwork();

    const unlockMobileAudio = () => {
      audio.startBgm();
      audio.unlock();
    };
    window.addEventListener('pointerdown', unlockMobileAudio, { passive: true, capture: true });
    window.addEventListener('touchstart', unlockMobileAudio, { passive: true, capture: true });
    window.addEventListener('keydown', unlockMobileAudio, { passive: true, capture: true });
    window.addEventListener('pagehide', () => this.network?.disconnect());

    audio.startBgm();
    this._syncMusicUi();

    const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && !isLocalHost) {
      navigator.serviceWorker.register('./sw.js').catch(() => null);
    }

    this.setScreenState('LOADING');
    this._runInitialLoading();
    requestAnimationFrame((t) => this._loop(t));
  }

  isCoopMode() {
    return this.gameMode === 'coop' || this.gameMode === 'coop_bots';
  }

  isDuelMode() {
    return this.gameMode === 'duel_bot' || this.gameMode === 'duel_online';
  }

  isCompetitiveMode() {
    return this.isDuelMode() || this.gameMode === 'coop_bots';
  }

  isNetworkedMode() {
    return this.gameMode === 'coop' || this.gameMode === 'duel_online' || this.gameMode === 'coop_bots';
  }

  getDesiredRivalBotCount() {
    if (this.gameMode === 'duel_bot') return 1;
    if (this.gameMode === 'coop_bots') {
      const humans = 1 + (this.network?.remotePlayers?.size || 0);
      return Math.max(1, Math.min(8, humans));
    }
    return 0;
  }

  _generateRoomCode(prefix = 'MR') {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = prefix;
    for (let i = 0; i < 6; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  _extractRoomCode(rawOrUrl) {
    const str = String(rawOrUrl || '').trim();
    if (!str) return '';
    let candidate = str;
    try {
      if (str.includes('room=')) {
        const parsed = str.startsWith('http') ? new URL(str) : new URL(str, 'https://example.com');
        candidate = parsed.searchParams.get('room') || str;
      }
    } catch (_) {
      const m = str.match(/[?&]room=([A-Za-z0-9_-]+)/i);
      if (m) candidate = m[1];
    }
    return candidate.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
  }

  _extractRoomMode(rawOrUrl, fallback = this.pendingRoomModalMode || 'coop') {
    const str = String(rawOrUrl || '').trim();
    const up = str.toUpperCase();
    if (str.includes('mode=coop_bots') || up.startsWith('CB')) return 'coop_bots';
    if (str.includes('mode=duel') || up.startsWith('D1')) return 'duel_online';
    return fallback;
  }

  _buildInviteUrl(roomCode, mode = this.pendingRoomModalMode || 'coop') {
    const code = this._extractRoomCode(roomCode) || this.hostRoomCode;
    const isDuel = mode === 'duel_online';
    const isCoopBots = mode === 'coop_bots';
    if (typeof window === 'undefined' || window.location.protocol === 'file:') {
      if (isDuel) return `?room=${encodeURIComponent(code)}&mode=duel`;
      if (isCoopBots) return `?room=${encodeURIComponent(code)}&mode=coop_bots`;
      return `?room=${encodeURIComponent(code)}`;
    }
    const u = new URL(window.location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', code);
    if (isDuel) u.searchParams.set('mode', 'duel');
    else if (isCoopBots) u.searchParams.set('mode', 'coop_bots');
    return u.toString();
  }

  async _shareOrCopyInvite(roomCode, mode = this.isNetworkedMode() ? this.gameMode : (this.pendingRoomModalMode || 'coop')) {
    const code = this._extractRoomCode(roomCode) || this.hostRoomCode;
    const url = this._buildInviteUrl(code, mode);
    const isDuel = mode === 'duel_online';
    const isCoopBots = mode === 'coop_bots';
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: isDuel
            ? 'Maze Royale 2 — Sfida 1 vs 1'
            : (isCoopBots ? 'Maze Royale 2 — Co-op vs Bot Rivali' : 'Maze Royale 2 — Dark Labyrinth (Co-op)'),
          text: isDuel
            ? `Accetta la sfida 1v1 nel labirinto! Cubo Blu vs Cubo Rosso (Codice: ${code}):`
            : (isCoopBots
              ? `Unisciti alla mia squadra Co-op vs Bot Rivali! Più siamo, più Bot Rossi affrontiamo (Codice: ${code}):`
              : `Entra nel mio labirinto Co-op (Codice: ${code}):`),
          url
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        this.showToast(`Link invito copiato! (${code})`);
        return;
      } catch (_) {}
    }
    this.showToast(`Link: ${url}`);
  }

  _syncControlsBlocked() {
    const blocked =
      this.screenState !== 'PLAYING' ||
      this.netModalOpen ||
      this.coopModalOpen ||
      this.doorModalOpen;
    this.controls.setUiBlocked(blocked);
  }

  setScreenState(nextState, opts = {}) {
    this.screenState = nextState;
    const showHud = nextState === 'PLAYING' || nextState === 'PAUSED' || nextState === 'GAMEOVER';
    const showWorldCanvas = showHud || nextState === 'VICTORY';

    if (this.el.canvas) {
      this.el.canvas.style.visibility = showWorldCanvas ? 'visible' : 'hidden';
    }

    this.el.mainMenu?.classList.toggle('hidden', nextState !== 'MENU');
    this.el.hudTop?.classList.toggle('hidden', !showHud);
    this.el.joystickZone?.classList.toggle('hidden', nextState !== 'PLAYING');
    this.el.actionCluster?.classList.toggle('hidden', nextState !== 'PLAYING');
    this.el.modalPause?.classList.toggle('hidden', nextState !== 'PAUSED');
    this.el.deathOverlay?.classList.toggle('hidden', nextState !== 'GAMEOVER');
    this.el.victoryOverlay?.classList.toggle('hidden', nextState !== 'VICTORY');
    if (nextState !== 'PLAYING') {
      this.el.respawnOverlay?.classList.add('hidden');
    }

    if (nextState === 'PAUSED' && this.el.pauseCoopShare) {
      const showShare = this.isNetworkedMode() && this.network?.roomId && this.network.roomId !== 'solo';
      this.el.pauseCoopShare.classList.toggle('hidden', !showShare);
      if (showShare && this.el.pauseCoopCode) {
        this.el.pauseCoopCode.textContent = this.network.roomId;
      }
    }

    if (nextState !== 'LOADING') {
      if (!opts.keepLoadingVisible) {
        this.el.loadingScreen?.classList.add('hidden');
      }
    } else {
      this.el.loadingScreen?.classList.remove('hidden', 'fade-out');
    }

    this._syncControlsBlocked();
  }

  startSingleplayer() {
    audio.unlock();
    this.gameMode = 'single';
    this.spawnSide = 'A';
    this._coopInitialSynced = false;
    this.duelResult = null;
    this.rivalKills = 0;
    this.network.connect('solo', 'solo');
    this.restartArcadeRun();
  }

  startDuelBot(level = 1) {
    audio.unlock();
    this.gameMode = 'duel_bot';
    this.spawnSide = 'A';
    this._coopInitialSynced = false;
    this.duelResult = null;
    this.level = Math.max(1, Math.min(CONFIG.MAX_LEVELS, level));
    this.seed = Math.floor(Math.random() * 900000) + 1000;
    if (this.level === 1) {
      this.kills = 0;
      this.rivalKills = 0;
    }
    this.deadElapsed = 0;
    this.network.connect('solo', 'solo');

    this.closeCoopModal();
    this.closeNetModal();
    this.buildLevel(this.level, this.seed, false);
    const sp = this.maze.spawnA;
    if (this.level === 1) {
      this.player.resetToFreshRun(sp.x, sp.z);
    } else {
      this.player.spawnAt(sp.x, sp.z, 0);
    }
    this.snapCameraToPlayer();
    this.setScreenState('PLAYING');
    this._syncHud();
    this.showToast(`⚔️ 1 VS 1 vs Bot Rivale — Livello ${this.level}/${CONFIG.MAX_LEVELS}! Trova i tuoi 5 segnalini prima del Cubo Rosso!`);
  }

  openRoomModal(mode = 'coop') {
    this.pendingRoomModalMode = mode === 'duel_online'
      ? 'duel_online'
      : (mode === 'coop_bots' ? 'coop_bots' : 'coop');
    const isDuel = this.pendingRoomModalMode === 'duel_online';
    const isCoopBots = this.pendingRoomModalMode === 'coop_bots';
    const desiredPrefix = isDuel ? 'D1' : (isCoopBots ? 'CB' : 'MR');
    if (!this.hostRoomCode || !this.hostRoomCode.startsWith(desiredPrefix)) {
      this.hostRoomCode = this._generateRoomCode(desiredPrefix);
    }
    this.coopModalOpen = true;

    this.el.coopModalCard?.classList.toggle('duel-mode', isDuel);
    this.el.coopModalCard?.classList.toggle('coop-bots-mode', isCoopBots);
    if (this.el.coopModalTitle) {
      this.el.coopModalTitle.textContent = isDuel
        ? '🔥 1 VS 1 ONLINE (MAX 2 GIOCATORI)'
        : (isCoopBots ? '🛡️ CO-OP VS BOT RIVALI (N vs N)' : '🤝 MODALITÀ CO-OP CON CODICE');
    }
    if (this.el.coopModalSub) {
      this.el.coopModalSub.textContent = isDuel
        ? 'Sfida un amico in 1v1: i 5 segnalini sono sdoppiati e privati per ciascuno (vedi solo i tuoi). Combatti il Cubo Rosso e sblocca per primo il Portale!'
        : (isCoopBots
          ? 'Squadra Blu contro Squadra Rossa di Bot AI: ogni amico che entra genera automaticamente un Cubo Rosso rivale in più (2v2, 3v3...). I 5 simboli sono condivisi col tuo team!'
          : 'Condividi il codice con il tuo amico: i fogli raccolti sono condivisi tra entrambi e se uno sblocca il portale centrale avanzate insieme (5 livelli progressivi)!');
    }
    if (this.el.coopHostLabel) {
      this.el.coopHostLabel.textContent = isDuel
        ? '1. CREA SFIDA 1 VS 1 (TU = CUBO BLU)'
        : (isCoopBots ? '1. OSPITA CO-OP VS BOT RIVALI (TEAM BLU)' : '1. OSPITA PARTITA CO-OP (SPAWN A)');
    }
    if (this.el.coopJoinLabel) {
      this.el.coopJoinLabel.textContent = isDuel
        ? '2. ACCETTA SFIDA 1 VS 1 (SPAWN B)'
        : (isCoopBots ? '2. ENTRA NELLA SQUADRA ALLEATA (TEAM BLU)' : '2. ENTRA NEL MONDO DI UN AMICO (SPAWN B)');
    }
    if (this.el.btnCoopHost) {
      this.el.btnCoopHost.textContent = isDuel
        ? '⚔️ CREA STANZA 1 VS 1'
        : (isCoopBots ? '🛡️ CREA SQUADRA VS BOT' : '🚀 CREA MONDO CO-OP');
    }
    if (this.el.inpCoopCode) {
      this.el.inpCoopCode.placeholder = isDuel
        ? 'Codice (es. D17K2P) o Link Sfida'
        : (isCoopBots ? 'Codice (es. CB7K2P) o Link Squadra' : 'Codice (es. MR7K2P) o Link Invito');
    }
    if (this.el.coopHostCode) this.el.coopHostCode.textContent = this.hostRoomCode;
    if (this.el.coopInviteLink) this.el.coopInviteLink.textContent = this._buildInviteUrl(this.hostRoomCode, this.pendingRoomModalMode);
    this.el.modalCoop?.classList.remove('hidden');
    this._syncControlsBlocked();
  }

  openCoopModal() {
    this.openRoomModal('coop');
  }

  closeCoopModal() {
    this.coopModalOpen = false;
    this.el.modalCoop?.classList.add('hidden');
    this._syncControlsBlocked();
  }

  openNetModal() {
    this.netModalOpen = true;
    this.el.modalNet?.classList.remove('hidden');
    const existingFb = loadFirebaseConfig();
    if (this.el.inpFbJson) {
      this.el.inpFbJson.value = existingFb.databaseURL ? JSON.stringify(existingFb, null, 2) : '';
    }
    if (this.el.inpSpawnSide) {
      this.el.inpSpawnSide.value = this.spawnSide;
    }
    this._syncControlsBlocked();
  }

  closeNetModal() {
    this.netModalOpen = false;
    this.el.modalNet?.classList.add('hidden');
    this._syncControlsBlocked();
  }

  _clearRemoteRivalVisuals() {
    for (const vis of this.remoteRivalVisuals.values()) {
      vis?.dispose(this.scene);
    }
    this.remoteRivalVisuals.clear();
    this.remoteRivalState = null;
  }

  _rebuildRemoteVisuals() {
    const isCoop = this.isCoopMode();
    const existingIds = [...this.remoteVisuals.keys()];
    for (const pid of existingIds) {
      const old = this.remoteVisuals.get(pid);
      old?.dispose(this.scene);
      this.remoteVisuals.delete(pid);
    }
    if (this.network?.remotePlayers) {
      for (const pid of this.network.remotePlayers.keys()) {
        this.remoteVisuals.set(pid, new RemotePlayerVisual(pid, this.scene, isCoop));
      }
    }
  }

  async _startRoomHost(mode, rawCode) {
    audio.unlock();
    const isDuel = mode === 'duel_online';
    const isCoopBots = mode === 'coop_bots';
    const prefix = isDuel ? 'D1' : (isCoopBots ? 'CB' : 'MR');
    const cleanCode = String(rawCode || this.hostRoomCode || this._generateRoomCode(prefix))
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '')
      .slice(0, 20) || this._generateRoomCode(prefix);

    this.hostRoomCode = cleanCode;
    this.gameMode = isDuel ? 'duel_online' : (isCoopBots ? 'coop_bots' : 'coop');
    this.spawnSide = 'A';
    this.level = 1;
    this.seed = Math.floor(Math.random() * 900000) + 1000;
    this.kills = 0;
    this.rivalKills = 0;
    this.duelResult = null;
    this.deadElapsed = 0;
    this._coopInitialSynced = true;

    this.closeCoopModal();
    await this.network.connect(cleanCode, 'host', {
      maxPeers: isDuel ? 1 : 0,
      modeLabel: isDuel ? '1v1' : (isCoopBots ? 'CO-OP vs BOT' : 'CO-OP')
    });
    this.buildLevel(1, this.seed, false);
    const sp = this.maze.spawnA;
    this.player.resetToFreshRun(sp.x, sp.z);
    this.snapCameraToPlayer();

    this._rebuildRemoteVisuals();
    this.network.publishFullRoomSync(this._buildRoomSnapshot());
    if (isCoopBots) {
      this.network.publishRivalBotsState(1.0, this._buildRivalBotsPayload());
    }
    if (this.el.inpRoom) this.el.inpRoom.value = this.network.roomId;

    this.setScreenState('PLAYING');
    this._syncHud();
    this.showToast(isDuel
      ? `🔥 Stanza 1v1 creata! Codice: ${this.network.roomId} (Max 2 giocatori)`
      : (isCoopBots
        ? `🛡️ Squadra Co-op vs Bot creata! Codice: ${this.network.roomId} (${this.rivalBots.length}v${this.rivalBots.length})`
        : `🤝 Mondo Co-op creato! Codice: ${this.network.roomId}`));
  }

  async _startRoomGuest(mode, rawCode, opts = {}) {
    const cleanCode = this._extractRoomCode(rawCode);
    if (!cleanCode) {
      this.showToast('Inserisci un codice stanza valido!');
      this.el.inpCoopCode?.focus();
      return;
    }

    const isDuel = mode === 'duel_online';
    const isCoopBots = mode === 'coop_bots';
    audio.unlock();
    this.gameMode = isDuel ? 'duel_online' : (isCoopBots ? 'coop_bots' : 'coop');
    // In Co-op vs Bot tutti gli umani nascono dal lato Spawn A (Team Blu)
    this.spawnSide = isCoopBots ? 'A' : 'B';
    this.level = 1;
    this.seed = Math.floor(Math.random() * 900000) + 1000;
    this.kills = 0;
    this.rivalKills = 0;
    this.duelResult = null;
    this.deadElapsed = 0;
    this._coopInitialSynced = false;

    this.closeCoopModal();
    await this.network.connect(cleanCode, 'guest', {
      maxPeers: isDuel ? 1 : 0,
      modeLabel: isDuel ? '1v1' : (isCoopBots ? 'CO-OP vs BOT' : 'CO-OP')
    });
    this.buildLevel(1, this.seed, false);
    const sp = this.spawnSide === 'B' ? this.maze.spawnB : this.maze.spawnA;
    const guestPos = isCoopBots
      ? findSafeDropPosition(this.maze, sp.x, sp.z, 1.35, 1.4)
      : sp;
    this.player.resetToFreshRun(guestPos.x, guestPos.z);
    this.snapCameraToPlayer();

    this.setScreenState('PLAYING', opts);
    this._rebuildRemoteVisuals();
    if (this.el.inpRoom) this.el.inpRoom.value = this.network.roomId;

    this._syncHud();
    this.showToast(isDuel
      ? `⚔️ Entrato in sfida 1v1 (${this.network.roomId}) — Trova i tuoi 5 segnalini!`
      : (isCoopBots
        ? `🛡️ Unito al Team Blu (${this.network.roomId}) — Spawn A!`
        : `🔑 Entrato in Co-op (${this.network.roomId}) — Spawn B!`));
  }

  startCoopHost(rawCode) { return this._startRoomHost('coop', rawCode); }
  startCoopGuest(rawCode, opts = {}) { return this._startRoomGuest('coop', rawCode, opts); }
  startCoopBotsHost(rawCode) { return this._startRoomHost('coop_bots', rawCode); }
  startCoopBotsGuest(rawCode, opts = {}) { return this._startRoomGuest('coop_bots', rawCode, opts); }
  startDuelOnlineHost(rawCode) { return this._startRoomHost('duel_online', rawCode); }
  startDuelOnlineGuest(rawCode, opts = {}) { return this._startRoomGuest('duel_online', rawCode, opts); }

  pauseGame() {
    if (this.screenState !== 'PLAYING') return;
    this.setScreenState('PAUSED');
  }

  resumeGame() {
    if (this.screenState !== 'PAUSED') return;
    this.setScreenState('PLAYING');
  }

  returnToMainMenu() {
    this.closeDoorModal();
    this.closeCoopModal();
    this.closeNetModal();
    this.network?.disconnect();
    this.rivalBots = [];
    this.rivalBot = null;
    this.rivalTeamPages = [];
    this._clearRemoteRivalVisuals();
    this.duelResult = null;
    this.gameMode = 'single';
    this.spawnSide = 'A';
    this.hostRoomCode = this._generateRoomCode('MR');
    if (typeof window !== 'undefined' && (window.location.search.includes('room=') || window.location.search.includes('mode='))) {
      try {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('room');
        cleanUrl.searchParams.delete('mode');
        window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      } catch (_) {}
    }
    this.setScreenState('MENU');
  }

  _runInitialLoading() {
    this.controls.setUiBlocked(true);
    const MIN_LOADING_MS = 5000;
    const startMs = performance.now();
    let assetsReady = false;

    const setProgress = (pct, label) => {
      const rounded = Math.max(0, Math.min(100, Math.round(pct)));
      if (this.el.loadingFill) this.el.loadingFill.style.width = `${rounded}%`;
      if (this.el.loadingPercent) this.el.loadingPercent.textContent = `${rounded}%`;
      if (this.el.loadingStep && label) this.el.loadingStep.textContent = label;
    };

    const waitImg = new Promise((resolve) => {
      const img = this.el.loadingBg;
      if (!img || img.complete) {
        resolve();
        return;
      }
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 1800);
    });

    waitImg.then(() => {
      this.buildLevel(this.level, this.seed, false);
      try {
        this.renderer.compile(this.scene, this.camera);
      } catch (_) {}
      assetsReady = true;
    });

    const tick = (now) => {
      const elapsed = now - startMs;
      const t = Math.min(1, elapsed / MIN_LOADING_MS);
      const pct = assetsReady ? t * 100 : Math.min(88, t * 100);

      let label = 'Caricamento motore 3D e texture arenaria...';
      if (this.pendingInviteRoom && pct >= 55) {
        label = `Invito Co-op rilevato (${this.pendingInviteRoom})...`;
      } else if (pct >= 88) {
        label = 'Attivazione touch mobile, controller e stanza online...';
      } else if (pct >= 62) {
        label = 'Calibrazione ombre reali della torcia e raggi X...';
      } else if (pct >= 32) {
        label = 'Generazione labirinto speculare, stanze e 5 simboli...';
      }

      setProgress(pct, label);

      if (elapsed >= MIN_LOADING_MS && assetsReady) {
        const invite = this.pendingInviteRoom;
        const inviteMode = this.pendingInviteMode;
        this.pendingInviteRoom = '';
        setProgress(100, invite ? `Ingresso Stanza (${invite})...` : 'Pronto! Apertura Menu Principale...');

        // Prepara gia' sotto il menu (o il gioco su invito) prima di far sfumare lo splash,
        // cosi' non si intravede mai il canvas 3D nudo durante la transizione.
        if (invite) {
          if (inviteMode === 'coop_bots' || invite.startsWith('CB')) {
            this.startCoopBotsGuest(invite, { keepLoadingVisible: true });
          } else if (inviteMode === 'duel_online' || invite.startsWith('D1')) {
            this.startDuelOnlineGuest(invite, { keepLoadingVisible: true });
          } else {
            this.startCoopGuest(invite, { keepLoadingVisible: true });
          }
        } else {
          this.setScreenState('MENU', { keepLoadingVisible: true });
        }

        requestAnimationFrame(() => {
          this.el.loadingScreen?.classList.add('fade-out');
          setTimeout(() => {
            this.el.loadingScreen?.classList.add('hidden');
            this.el.loadingScreen?.classList.remove('fade-out');
          }, 380);
        });
        return;
      }
      requestAnimationFrame(tick);
    };

    setProgress(0, 'Caricamento motore 3D e texture arenaria...');
    requestAnimationFrame(tick);
  }

  _initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.el.canvas,
      antialias: false,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 1);
    // Shadow map attiva: impedisce alla torcia di illuminare muri oltre altre pareti
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    // Nebbia calibrata oltre la distanza camera-giocatore (~25.5): intorno al giocatore e' limpido, lontano cade nel nero totale
    this.scene.fog = new THREE.Fog(0x000000, CONFIG.FOG_NEAR, CONFIG.FOG_FAR);

    // Ambient minima: muri schermati da altri muri restano quasi completamente bui
    const ambient = new THREE.AmbientLight(0x1f1913, 0.08);
    this.scene.add(ambient);

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.CAMERA.FOV,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.3,
      90
    );

    this.wallTex = createSandstoneWallTexture();
    this.floorTex = createFloorTexture();
    this.chestTex = createChestTexture();

    this.levelGroup = new THREE.Group();
    this.scene.add(this.levelGroup);

    this.player = new PlayerCube('local', 'TU', 0x2563eb);
    this.scene.add(this.player.group);

    this.remoteVisuals = new Map();
    this.pages = [];
    this.chests = [];
    this.bots = [];
    this.door = null;

    this._resize();
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._resize(), 120));
    window.visualViewport?.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const w = Math.max(1, window.visualViewport?.width || window.innerWidth);
    const h = Math.max(1, window.visualViewport?.height || window.innerHeight);
    const aspect = w / h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = aspect;
    // Compensa il FOV verticale in modalita' verticale (iPhone/Android Portrait) per vedere corridoi abbastanza ampi
    this.camera.fov = aspect < 1 ? Math.min(76, CONFIG.CAMERA.FOV / Math.max(0.58, aspect)) : CONFIG.CAMERA.FOV;
    this.camera.updateProjectionMatrix();
  }

  _initNetwork() {
    this.network = new RealtimeNetwork({
      onStatusChange: (label) => {
        if (this.el.netStatus) this.el.netStatus.textContent = label;
      },
      onPeerHello: () => {
        if (this.isNetworkedMode() && this.maze && this.network.coopRole === 'host') {
          this.network.publishFullRoomSync(this._buildRoomSnapshot());
          if (this.gameMode === 'coop_bots') {
            this._reconcileRivalBots(false);
            this.network.publishRivalBotsState(1.0, this._buildRivalBotsPayload());
          }
        }
      },
      onRoomFull: () => {
        if (this.gameMode === 'duel_online') {
          this.network.disconnect();
          this.returnToMainMenu();
          this.showToast('⛔ Stanza 1v1 già piena (massimo 2 giocatori)!');
        }
      },
      onRoomMeta: (meta) => {
        if (this.isNetworkedMode()) {
          this._applyFullRoomSync(meta);
        }
      },
      onFullRoomSync: (snapshot) => {
        if (this.isNetworkedMode()) {
          this._applyFullRoomSync(snapshot);
        }
      },
      onPlayersUpdate: (map) => {
        for (const [pid, vis] of this.remoteVisuals.entries()) {
          if (!map.has(pid)) {
            vis.dispose(this.scene);
            this.remoteVisuals.delete(pid);
          }
        }
        const isCoop = this.isCoopMode();
        for (const pid of map.keys()) {
          if (!this.remoteVisuals.has(pid)) {
            this.remoteVisuals.set(pid, new RemotePlayerVisual(pid, this.scene, isCoop));
          }
        }
        if (this.gameMode === 'coop_bots' && this.network.coopRole === 'host' && this.maze) {
          const prevLen = this.rivalBots.length;
          this._reconcileRivalBots(true);
          if (this.rivalBots.length !== prevLen) {
            this.network.publishRivalBotsState(1.0, this._buildRivalBotsPayload());
          }
        }
      },
      onIncomingHit: (hit) => {
        if (!this.player.alive || this.gameMode === 'coop') return;
        if (this.gameMode === 'coop_bots' && !hit?.isBotHit) return;
        const attackerLabel = hit?.isBotHit ? (hit.attackerName || 'Cubo Rosso (BOT)') : 'Rivale Online';
        const res = this._applyPlayerDamage(
          hit.damage || CONFIG.BASE_SWORD_DAMAGE,
          hit.fromX,
          hit.fromZ,
          attackerLabel
        );
        if (!hit?.isBotHit) {
          this.network.sendHitResult(hit.fromId, {
            hitId: hit.hitId,
            blocked: Boolean(res.blocked),
            died: Boolean(res.died),
            remainingHp: Math.ceil(this.player.hp)
          });
        }
      },
      onRivalBotsState: (state) => {
        if (this.gameMode !== 'coop_bots' || this.network.coopRole === 'host' || !state) return;
        this.remoteRivalState = state;
        const incomingIds = new Set((state.bots || []).map((b) => b.id));
        for (const [bid, vis] of this.remoteRivalVisuals.entries()) {
          if (!incomingIds.has(bid)) {
            vis.dispose(this.scene);
            this.remoteRivalVisuals.delete(bid);
          }
        }
        for (const b of (state.bots || [])) {
          if (!this.remoteRivalVisuals.has(b.id)) {
            this.remoteRivalVisuals.set(b.id, new RemotePlayerVisual(b.id, this.scene, false));
          }
        }
      },
      onBotHit: (hit) => {
        if (this.gameMode !== 'coop_bots' || this.network.coopRole !== 'host' || !hit || !this.maze) return;
        const bot = this.rivalBots.find((b) => b.id === hit.botId);
        if (!bot || !bot.alive) return;
        const dx = bot.x - (hit.fromX ?? this.player.x);
        const dz = bot.z - (hit.fromZ ?? this.player.z);
        const pushX = Math.hypot(dx, dz) > 0.01 ? dx : 1;
        const pushZ = Math.hypot(dx, dz) > 0.01 ? dz : 0;
        const res = bot.takeDamage(hit.damage || CONFIG.BASE_SWORD_DAMAGE, pushX, pushZ, this.maze);
        this.network.sendBotHitResult(hit.fromId, {
          hitId: hit.hitId,
          botId: bot.id,
          botName: bot.name,
          blocked: Boolean(res.blocked),
          died: Boolean(res.died),
          droppedCount: res.droppedCount || 0
        });
        if (res.died) {
          const text = `⚔️ Un alleato ha abbattuto ${bot.name}!`;
          this.showToast(text);
          this.network.publishBotEvent({ kind: 'BOT_KILLED', botId: bot.id, botName: bot.name, text });
        }
        this.network.publishRivalBotsState(1.0, this._buildRivalBotsPayload());
      },
      onBotHitResult: (res) => {
        if (!res) return;
        if (res.blocked) {
          audio.playShieldBlock();
          this.controls.rumble(60, 0.25, 0.15);
          this.showToast(`🛡️ ${res.botName || 'Cubo Rosso'} ha parato il colpo!`);
        } else if (res.died) {
          this.rivalKills += 1;
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + CONFIG.RIVAL_KILL_HEAL);
          this.showToast(`⚔️ ${res.botName || 'Cubo Rosso'} eliminato! (+${CONFIG.RIVAL_KILL_HEAL} HP)`);
          this._syncHud();
        }
      },
      onBotEvent: (ev) => {
        if (!ev) return;
        if (ev.kind === 'PORTAL_ALERT') {
          audio.playPunish();
        }
        if (ev.text) {
          this.showToast(ev.text);
        }
      },
      onHitResult: (res) => {
        if (!res) return;
        if (res.blocked) {
          audio.playShieldBlock();
          this.showToast('🛡️ Il Cubo Rosso ha parato il colpo!');
        } else if (res.died) {
          this.rivalKills += 1;
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + CONFIG.RIVAL_KILL_HEAL);
          this.showToast(`⚔️ Rivale eliminato! (+${CONFIG.RIVAL_KILL_HEAL} HP — segnalini caduti)`);
          this._syncHud();
        }
      },
      onDuelWin: (msg) => {
        if (!msg) return;
        if (this.gameMode === 'duel_online' && msg.winnerId !== this.network.playerId) {
          this._onDuelFinished(false, msg.winnerName || 'Cubo Rosso (Rivale)');
        } else if (this.gameMode === 'coop_bots' && this.screenState !== 'VICTORY') {
          this._onDuelFinished(Boolean(msg.teamWon), msg.winnerName || 'Squadra');
        }
      },
      onDuelReset: (msg) => {
        if ((this.gameMode !== 'duel_online' && this.gameMode !== 'coop_bots') || !msg?.seed) return;
        const nextLevel = Math.max(1, Math.min(CONFIG.MAX_LEVELS, msg.level || 1));
        this.duelResult = null;
        if (nextLevel === 1) {
          this.kills = 0;
          this.rivalKills = 0;
        }
        this.buildLevel(nextLevel, msg.seed, false);
        const sp = this.spawnSide === 'B' ? this.maze.spawnB : this.maze.spawnA;
        const spawnPos = this.gameMode === 'coop_bots'
          ? findSafeDropPosition(this.maze, sp.x, sp.z, 1.35, 1.4)
          : sp;
        if (nextLevel === 1) {
          this.player.resetToFreshRun(spawnPos.x, spawnPos.z);
        } else {
          this.player.spawnAt(spawnPos.x, spawnPos.z, 0);
        }
        this.snapCameraToPlayer();
        this.setScreenState('PLAYING');
        this._syncHud();
        this.showToast(this.gameMode === 'coop_bots'
          ? `🛡️ Nuovo Round Co-op vs Bot — Livello ${nextLevel}/${CONFIG.MAX_LEVELS}!`
          : `⚔️ Nuova sfida 1v1 — Livello ${nextLevel}/${CONFIG.MAX_LEVELS}!`);
      },
      onPageEvent: (ev) => {
        if (!ev || !this.isCoopMode()) return;
        const wp = this.pages.find((p) => p.originalIndex === ev.index);
        if (ev.action === 'PICKUP') {
          if (wp) {
            wp.collected = true;
            wp.mesh.visible = false;
          }
          this._applySharedPage({
            originalIndex: ev.index,
            slot: wp?.slot ?? ev.slot,
            symbol: wp?.symbol ?? ev.symbol
          }, true);
        }
      },
      onChestOpened: (chestId) => {
        const ch = this.chests.find((c) => c.id === chestId);
        if (ch && !ch.opened) ch.open();
      },
      onLevelAdvance: (lvl, nextSeed, winnerName, victory = false) => {
        if (this.gameMode !== 'coop') return;
        if (victory) {
          this._onVictory(winnerName);
          return;
        }
        this.level = Math.max(1, Math.min(CONFIG.MAX_LEVELS, lvl));
        this.seed = nextSeed;
        this.buildLevel(this.level, this.seed, false);
        this.showToast(`🚪 ${winnerName || 'Il tuo compagno'} ha risolto il Portale! Livello ${this.level}/${CONFIG.MAX_LEVELS}`);
      }
    });
    this.network.connect('solo', 'solo');
  }

  _buildRoomSnapshot() {
    return {
      gameMode: this.gameMode,
      level: this.level,
      seed: this.seed,
      collectedPages: this.isCoopMode()
        ? this.sharedPages.map((p) => ({
            originalIndex: p.originalIndex,
            slot: p.slot,
            symbol: p.symbol
          }))
        : [],
      openedChests: this.chests.filter((c) => c.opened).map((c) => c.id),
      victory: this.gameMode === 'coop' && this.screenState === 'VICTORY'
    };
  }

  _buildRivalBotsPayload() {
    const redPages = this.rivalTeamPages.filter((p) => p.collected).length;
    const unlocking = this.rivalBots.some((b) => b.unlockingDoorTimer > 0);
    return {
      level: this.level,
      teamPages: redPages,
      unlocking,
      bots: this.rivalBots.map((b) => b.serializeState())
    };
  }

  _reconcileRivalBots(notify = false) {
    if (!this.maze) return;
    if (this.gameMode === 'duel_bot') {
      if (this.rivalBots.length === 0) {
        const b = new RivalBot(this.maze, this.levelGroup, { id: 'rival-bot', botIndex: 0 });
        this.rivalBots = [b];
        this.rivalBot = b;
      }
      return;
    }
    if (this.gameMode !== 'coop_bots' || this.network?.coopRole !== 'host') return;

    const desired = this.getDesiredRivalBotCount();
    const prevCount = this.rivalBots.length;

    while (this.rivalBots.length < desired) {
      const idx = this.rivalBots.length;
      const b = new RivalBot(this.maze, this.levelGroup, {
        id: `rival-bot-${idx}`,
        botIndex: idx,
        name: `Cubo Rosso #${idx + 1}`,
        sharedPages: this.rivalTeamPages
      });
      this.rivalBots.push(b);
    }

    while (this.rivalBots.length > desired) {
      const removed = this.rivalBots.pop();
      if (removed) {
        removed.collectedPages = [];
        removed.dispose(this.levelGroup);
      }
    }

    this.rivalBot = this.rivalBots[0] || null;
    if (notify && prevCount !== desired) {
      const text = desired > prevCount
        ? `🛡️ Nuovo alleato in squadra! Ora è ${desired} vs ${desired} (${desired} Bot Rossi)!`
        : `⚖️ Alleato uscito — Sfida riequilibrata a ${desired} vs ${desired}!`;
      this.showToast(text);
      this.network.publishBotEvent({ kind: 'SCALE', desired, text });
    }
  }

  _applySharedPage(pageInfo, notify = false) {
    if (!pageInfo || pageInfo.symbol === undefined) return;
    const wp = this.pages.find((p) => p.originalIndex === pageInfo.originalIndex);
    if (wp) {
      wp.collected = true;
      wp.mesh.visible = false;
    }

    const entry = {
      originalIndex: pageInfo.originalIndex,
      slot: wp?.slot ?? pageInfo.slot,
      symbol: wp?.symbol ?? pageInfo.symbol
    };

    const alreadyShared = this.sharedPages.some((p) => p.originalIndex === entry.originalIndex);
    if (!alreadyShared) {
      this.sharedPages.push(entry);
    }

    const alreadyHeld = this.player.collectedPages.some((p) => p.originalIndex === entry.originalIndex);
    if (!alreadyHeld) {
      this.player.collectedPages.push(entry);
      if (notify) {
        audio.playPagePickup();
        this.showToast(`🤝 Foglio condiviso #${entry.slot}: ${entry.symbol}`);
      }
      if (this.doorModalOpen) {
        this._refreshDoorKeypadOwned();
      }
    }
    this._syncHud();
  }

  _applyFullRoomSync(snapshot) {
    if (!snapshot) return;
    if (snapshot.gameMode === 'duel_online' || snapshot.gameMode === 'coop' || snapshot.gameMode === 'coop_bots') {
      if (this.gameMode !== snapshot.gameMode) {
        this.gameMode = snapshot.gameMode;
        this.network.maxPeers = this.gameMode === 'duel_online' ? 1 : 0;
        this.network.modeLabel = this.gameMode === 'duel_online'
          ? '1v1'
          : (this.gameMode === 'coop_bots' ? 'CO-OP vs BOT' : 'CO-OP');
        if (this.gameMode === 'coop_bots' && this.network.coopRole === 'guest') {
          this.spawnSide = 'A';
        }
        this._rebuildRemoteVisuals();
      }
    }

    if (snapshot.duelWinner && (this.gameMode === 'duel_online' || this.gameMode === 'coop_bots')) {
      if (this.screenState !== 'VICTORY') {
        if (this.gameMode === 'coop_bots') {
          this._onDuelFinished(Boolean(snapshot.duelWinner.teamWon), snapshot.duelWinner.winnerName || 'Squadra');
        } else if (snapshot.duelWinner.winnerId !== this.network.playerId) {
          this._onDuelFinished(false, snapshot.duelWinner.winnerName || 'Cubo Rosso (Rivale)');
        }
      }
      return;
    }

    if (snapshot.victory && this.gameMode === 'coop') {
      if (this.screenState !== 'VICTORY') {
        this._onVictory(snapshot.winnerName);
      }
      return;
    }
    if (!snapshot.seed) return;

    const targetLevel = Math.max(1, Math.min(CONFIG.MAX_LEVELS, snapshot.level || 1));
    const targetSeed = snapshot.seed;
    const changed = targetLevel !== this.level || targetSeed !== this.seed;

    if (changed || !this._coopInitialSynced) {
      const prevLevel = this.level;
      this._coopInitialSynced = true;
      this.duelResult = null;
      this.buildLevel(targetLevel, targetSeed, false);
      if (this.gameMode === 'duel_online') {
        this.showToast(`⚔️ Stanza 1v1 (${this.network.roomId}) — Trova i tuoi 5 segnalini!`);
      } else if (this.gameMode === 'coop_bots') {
        this.showToast(`🛡️ Co-op vs Bot (${this.network.roomId}) — Livello ${this.level}/${CONFIG.MAX_LEVELS}`);
      } else if (snapshot.winnerName && targetLevel > prevLevel) {
        this.showToast(`🚪 ${snapshot.winnerName} ha sbloccato il Portale! Livello ${this.level}/${CONFIG.MAX_LEVELS}`);
      } else {
        this.showToast(`🤝 Mondo Co-op (${this.network.roomId}) — Livello ${this.level}/${CONFIG.MAX_LEVELS}`);
      }
    }

    if (this.isCoopMode()) {
      for (const pg of (snapshot.collectedPages || [])) {
        this._applySharedPage(pg, false);
      }
    }
    for (const cid of (snapshot.openedChests || [])) {
      const ch = this.chests.find((c) => c.id === cid);
      if (ch && !ch.opened) ch.open();
    }
    this._syncHud();
  }

  /**
   * Genera il labirinto speculare NxN, usa InstancedMesh per muri/pavimenti
   * e popola fogli, casse, bot e porta al centro (0, 0).
   */
  buildLevel(level, seed, publishMeta = false) {
    // Pulizia geometrie precedenti
    while (this.levelGroup.children.length > 0) {
      const child = this.levelGroup.children.pop();
      if (child.geometry) child.geometry.dispose();
    }
    this.pages = [];
    this.chests = [];
    this.bots = [];
    this.rivalBots = [];
    this.rivalBot = null;
    this.rivalTeamPages = [];
    this._clearRemoteRivalVisuals();

    this.level = level;
    this.seed = seed;
    this.maze = generateSymmetricMaze(level, seed);

    const cs = this.maze.cellSize;
    const wallH = CONFIG.WALL_HEIGHT;

    // 1. InstancedMesh Muri arenaria egiziana (60 FPS garantiti anche su 41x41!)
    const wallGeo = new THREE.BoxGeometry(cs, wallH, cs);
    const wallMat = new THREE.MeshStandardMaterial({
      map: this.wallTex,
      roughness: 0.88,
      metalness: 0.04,
      shadowSide: THREE.DoubleSide
    });
    const wallInst = new THREE.InstancedMesh(wallGeo, wallMat, this.maze.wallCells.length);
    wallInst.frustumCulled = false;
    wallInst.castShadow = true;
    wallInst.receiveShadow = true;
    wallInst.renderOrder = 0;

    const dummy = new THREE.Object3D();
    this.maze.wallCells.forEach((wc, idx) => {
      dummy.position.set(wc.x, wallH * 0.5, wc.z);
      dummy.updateMatrix();
      wallInst.setMatrixAt(idx, dummy.matrix);
    });
    wallInst.instanceMatrix.needsUpdate = true;
    this.levelGroup.add(wallInst);

    // 2. InstancedMesh Pavimento scuro pixel-art
    const floorGeo = new THREE.PlaneGeometry(cs, cs);
    floorGeo.rotateX(-Math.PI * 0.5);
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.floorTex,
      roughness: 0.94,
      metalness: 0.02
    });
    const floorInst = new THREE.InstancedMesh(floorGeo, floorMat, this.maze.floorCells.length);
    floorInst.frustumCulled = false;
    floorInst.castShadow = false;
    floorInst.receiveShadow = true;
    floorInst.renderOrder = 0;
    this.maze.floorCells.forEach((fc, idx) => {
      dummy.position.set(fc.x, 0, fc.z);
      dummy.updateMatrix();
      floorInst.setMatrixAt(idx, dummy.matrix);
    });
    floorInst.instanceMatrix.needsUpdate = true;
    this.levelGroup.add(floorInst);

    // 3. Porta finale esattamente al centro (0, 0)
    this.door = new CenterDoor(this.levelGroup);

    // 4. 5 Fogli nei vicoli ciechi/stanze
    for (const pData of this.maze.pageSpawns) {
      this.pages.push(new WorldPage(pData, this.levelGroup));
    }

    // 5. Casse loot anti-camper
    for (const cData of this.maze.chestSpawns) {
      this.chests.push(new LootChest(cData, this.levelGroup, this.chestTex));
    }

    // 6. Bot nemici verdi lenti (40 HP, invisibili nel buio e dietro i muri)
    const botSpawns = this.isCompetitiveMode()
      ? this.maze.botSpawns.slice(0, Math.min(8, 2 + level * 2))
      : this.maze.botSpawns;
    for (const bData of botSpawns) {
      this.bots.push(new EnemyBot(bData, this.levelGroup));
    }

    // 7. Rivale/Squadra Cubi Rossi IA (duel_bot = 1 bot; coop_bots Host = N bot pari agli umani)
    if (this.gameMode === 'duel_bot') {
      this._reconcileRivalBots(false);
    } else if (this.gameMode === 'coop_bots' && this.network?.coopRole === 'host') {
      this.rivalTeamPages = this.maze.pageSpawns.map((p) => ({
        originalIndex: p.index,
        slot: p.slot,
        symbol: p.symbol,
        x: p.x,
        z: p.z,
        collected: false,
        collectedBy: null
      }));
      this._reconcileRivalBots(false);
    }

    // Spawn giocatore: A (Team Blu / Spawn A) o B (Duello Spawn B) + camera snap istantaneo!
    const sp = this.spawnSide === 'B' ? this.maze.spawnB : this.maze.spawnA;
    const spawnPos = this.gameMode === 'coop_bots' && this.network?.coopRole === 'guest'
      ? findSafeDropPosition(this.maze, sp.x, sp.z, 1.35, 1.4)
      : sp;
    this.sharedPages = [];
    this.player.collectedPages = [];
    this.player.spawnAt(spawnPos.x, spawnPos.z, 0);
    this.snapCameraToPlayer();

    this.el.deathOverlay?.classList.add('hidden');
    this.el.victoryOverlay?.classList.add('hidden');
    this.el.respawnOverlay?.classList.add('hidden');
    this.closeDoorModal();
    this._syncHud();

    if (publishMeta && this.isNetworkedMode()) {
      this.network.publishFullRoomSync(this._buildRoomSnapshot());
    }
  }

  snapCameraToPlayer() {
    this.camera.position.set(
      this.player.x,
      CONFIG.CAMERA.HEIGHT,
      this.player.z + CONFIG.CAMERA.OFFSET_Z
    );
    this.camera.lookAt(
      this.player.x,
      0.5,
      this.player.z + CONFIG.CAMERA.LOOK_AHEAD_Z
    );
  }

  _updateCamera(dt) {
    const targetPosX = this.player.x;
    const targetPosY = CONFIG.CAMERA.HEIGHT;
    const targetPosZ = this.player.z + CONFIG.CAMERA.OFFSET_Z;

    const alpha = Math.min(1, dt * CONFIG.CAMERA.FOLLOW_LERP);
    this.camera.position.x += (targetPosX - this.camera.position.x) * alpha;
    this.camera.position.y += (targetPosY - this.camera.position.y) * alpha;
    this.camera.position.z += (targetPosZ - this.camera.position.z) * alpha;
    this.camera.lookAt(
      this.camera.position.x,
      0.5,
      this.camera.position.z - CONFIG.CAMERA.OFFSET_Z + CONFIG.CAMERA.LOOK_AHEAD_Z
    );
  }

  _dropPagesToWorld(droppedPages, broadcast = true) {
    for (const d of droppedPages) {
      const wp = this.pages.find((p) => p.originalIndex === d.originalIndex);
      if (wp) {
        wp.setWorldPosition(d.x, d.z);
        if (broadcast) {
          this.network.publishPageEvent({ action: 'DROP', index: wp.originalIndex, x: d.x, z: d.z });
        }
      }
    }
    this._syncHud();
  }

  _onPlayerDied(lastPagesCount = 0) {
    this.closeDoorModal();
    this.deadElapsed = 0;

    if (this.gameMode === 'coop') {
      // In Co-op le carte trovate restano condivise tra i giocatori anche dopo una caduta
      this.player.collectedPages = [...this.sharedPages];
      if (this.el.deathStats) {
        this.el.deathStats.textContent = `Livello ${this.level}/${CONFIG.MAX_LEVELS} (${this.maze.N}×${this.maze.N}) • Fogli condivisi: ${this.sharedPages.length}/5 • Guardiani eliminati: ${this.kills}`;
      }
      if (this.el.deathHint) {
        this.el.deathHint.textContent = 'Sei caduto! Puoi rientrare allo Spawn Co-op oppure ricominciare dal Livello 1.';
      }
      if (this.el.btnRespawnPvp) {
        this.el.btnRespawnPvp.textContent = '🔄 RIENTRA IN CO-OP';
        this.el.btnRespawnPvp.classList.remove('hidden');
      }
    } else {
      if (this.el.deathStats) {
        this.el.deathStats.textContent = `Livello raggiunto: ${this.level}/${CONFIG.MAX_LEVELS} (${this.maze.N}×${this.maze.N}) • Fogli raccolti: ${lastPagesCount}/5 • Guardiani eliminati: ${this.kills}`;
      }
      if (this.el.deathHint) {
        this.el.deathHint.textContent = 'Fine partita Arcade! Premi Spazio / Invio / Nuova Partita per ricominciare dal Livello 1.';
      }
      this.el.btnRespawnPvp?.classList.add('hidden');
    }

    this.setScreenState('GAMEOVER');
    this._syncHud();
  }

  _onLocalDuelRespawn() {
    this.el.respawnOverlay?.classList.add('hidden');
    if (this.isCoopMode()) {
      this.player.collectedPages = [...this.sharedPages];
    }
    this.snapCameraToPlayer();
    this._syncHud();
    this.showToast(this.gameMode === 'coop_bots'
      ? '🔄 Rientrato allo Spawn A! I fogli della squadra sono salvi!'
      : `🔄 Rientrato allo Spawn ${this.spawnSide}! Recupera i tuoi segnalini!`);
  }

  _applyPlayerDamage(amount, fromX = undefined, fromZ = undefined, attackerLabel = 'Nemico') {
    if (!this.player.alive) return { blocked: false, died: false };
    const lastPagesCount = this.player.collectedPages.length;
    const isComp = this.isCompetitiveMode();
    const res = this.player.takeDamage(
      amount,
      this.maze,
      this.isCoopMode()
        ? null
        : (dropped) => {
            // In 1v1 e Singleplayer i segnalini caduti restano PRIVATI sullo schermo locale!
            this._dropPagesToWorld(dropped, false);
          },
      isComp
    );

    if (res.blocked) {
      this.controls.rumble(65, 0.35, 0.2);
      this.showToast('🛡️ Attacco parato dallo Scudo!');
      return res;
    }

    this.controls.rumble(140, 0.35, 0.75);
    this._triggerDamageFlash();

    if (res.died) {
      if (isComp) {
        this.closeDoorModal();
        if (this.isCoopMode()) {
          this.player.collectedPages = [...this.sharedPages];
        }
        if (this.el.respawnSub) {
          this.el.respawnSub.textContent = this.gameMode === 'coop_bots'
            ? `Abbattuto da ${attackerLabel} — i fogli del Team Blu restano al sicuro!`
            : (lastPagesCount > 0
              ? `Abbattuto da ${attackerLabel} — i tuoi ${lastPagesCount} segnalini sono caduti a terra!`
              : `Abbattuto da ${attackerLabel} — rientro allo Spawn...`);
        }
        this.showToast(`💀 Eliminato da ${attackerLabel}! Respawn tra ${CONFIG.RESPAWN_SECONDS}s!`);
      } else {
        this._onPlayerDied(lastPagesCount);
      }
    } else if (fromX !== undefined && fromZ !== undefined) {
      this.player.applyKnockback(this.player.x - fromX, this.player.z - fromZ);
    }

    this._syncHud();
    return res;
  }

  _onVictory(winnerName = '') {
    this.closeDoorModal();
    this.player.shieldActive = false;
    this.duelResult = 'WIN';
    this.el.victoryOverlay?.classList.remove('defeat-theme');
    this.el.btnVictoryNext?.classList.add('hidden');
    if (this.el.victoryBadge) this.el.victoryBadge.textContent = '🏆 CAMPAGNA COMPLETATA 🏆';
    if (this.el.victoryTitle) this.el.victoryTitle.textContent = 'LABIRINTO CONQUISTATO!';
    if (this.el.victorySub) {
      this.el.victorySub.textContent = `Tutti e ${CONFIG.MAX_LEVELS} i livelli (fino a ${5 + CONFIG.MAX_LEVELS * 8}×${5 + CONFIG.MAX_LEVELS * 8}) sono stati superati!`;
    }
    if (this.el.victoryStats) {
      const modeLabel = this.gameMode === 'coop' ? `Co-op (${this.network.roomId})` : 'Singleplayer';
      const by = winnerName ? ` • Sbloccato da: ${winnerName}` : '';
      const maxN = 5 + CONFIG.MAX_LEVELS * 8;
      this.el.victoryStats.textContent = `${modeLabel} • 5/${CONFIG.MAX_LEVELS} Livelli completati (Labirinto finale ${maxN}×${maxN}) • Guardiani eliminati: ${this.kills}${by}`;
    }
    this.setScreenState('VICTORY');
    this._syncHud();
  }

  _onDuelFinished(playerWon, winnerName = '') {
    this.closeDoorModal();
    this.player.shieldActive = false;
    this.duelResult = playerWon ? 'WIN' : 'LOSS';
    this.el.victoryOverlay?.classList.toggle('defeat-theme', !playerWon);
    const isCoopBots = this.gameMode === 'coop_bots';
    const teamSize = isCoopBots
      ? (this.network.coopRole === 'host'
        ? this.rivalBots.length
        : (this.remoteRivalState?.bots?.length || (1 + this.network.remotePlayers.size)))
      : 1;

    if (this.el.victoryBadge) {
      this.el.victoryBadge.textContent = isCoopBots
        ? (playerWon ? `🛡️ VITTORIA SQUADRA ${teamSize}v${teamSize} (${this.maze.N}×${this.maze.N})` : `🟥 SCONFITTA — BOT RIVALI ${teamSize}v${teamSize}`)
        : (playerWon ? `⚔️ VITTORIA DUELLO 1V1 (${this.maze.N}×${this.maze.N})` : '🟥 SCONFITTA DUELLO 1V1');
    }
    if (this.el.victoryTitle) {
      this.el.victoryTitle.textContent = isCoopBots
        ? (playerWon ? 'LA SQUADRA BLU HA VINTO!' : 'I BOT RIVALI HANNO VINTO!')
        : (playerWon ? 'HAI VINTO IL DUELLO!' : 'IL RIVALE HA VINTO!');
    }
    if (this.el.victorySub) {
      this.el.victorySub.textContent = isCoopBots
        ? (playerWon
          ? `${winnerName || 'Il Team Blu'} ha sbloccato il Portale del Livello ${this.level}!`
          : 'I Cubi Rossi hanno completato la sequenza al Portale centrale!')
        : (playerWon
          ? `Hai sbloccato per primo il Portale al centro del Livello ${this.level}!`
          : `${winnerName || 'Il Cubo Rosso'} ha sbloccato per primo il Portale centrale!`);
    }
    if (this.el.victoryStats) {
      const oppPages = this.gameMode === 'duel_bot'
        ? (this.rivalBot?.collectedPages.length ?? 0)
        : (isCoopBots
          ? (this.network.coopRole === 'host'
            ? (this.rivalTeamPages.filter((p) => p.collected).length)
            : (this.remoteRivalState?.teamPages ?? 0))
          : (([...this.network.remotePlayers.values()][0]?.pagesCount) ?? 0));
      const myLabel = isCoopBots ? 'Fogli Squadra Blu' : 'Tuoi Fogli';
      const oppLabel = isCoopBots ? 'Fogli Bot Rossi' : 'Fogli Rivale';
      const koLabel = isCoopBots ? 'Bot Rossi Abbattuti' : 'Rivale Abbattuto';
      this.el.victoryStats.textContent =
        `Livello ${this.level}/${CONFIG.MAX_LEVELS} • ${myLabel}: ${this.player.collectedPages.length}/5 • ${oppLabel}: ${oppPages}/5 • ${koLabel}: ${this.rivalKills} • Guardiani: ${this.kills}`;
    }
    const canAdvance = playerWon && this.level < CONFIG.MAX_LEVELS && (!isCoopBots || this.network.coopRole === 'host');
    this.el.btnVictoryNext?.classList.toggle('hidden', !canAdvance);
    this.setScreenState('VICTORY');
    this._syncHud();
  }

  restartArcadeRun() {
    if (this.gameMode === 'duel_bot') {
      this.startDuelBot(1);
      return;
    }
    this.level = 1;
    this.seed = Math.floor(Math.random() * 900000) + 1000;
    this.kills = 0;
    this.rivalKills = 0;
    this.duelResult = null;
    this.deadElapsed = 0;
    this.sharedPages = [];
    this.controls.keys.delete('Space');
    this.controls.keys.delete('Enter');
    this.controls.buttons.attackQueued = false;
    this.controls.gamepad.prevAttack = true;
    this.buildLevel(1, this.seed, this.gameMode === 'coop');
    const sp = this.spawnSide === 'B' ? this.maze.spawnB : this.maze.spawnA;
    const spawnPos = this.gameMode === 'coop_bots' && this.network?.coopRole === 'guest'
      ? findSafeDropPosition(this.maze, sp.x, sp.z, 1.35, 1.4)
      : sp;
    this.player.resetToFreshRun(spawnPos.x, spawnPos.z);
    this.snapCameraToPlayer();
    this.setScreenState('PLAYING');
    this._syncHud();
    if (this.gameMode === 'coop') {
      this.network.publishLevelAdvance(1, this.seed, this.player.name, false);
      this.network.publishFullRoomSync(this._buildRoomSnapshot());
      this.showToast(`Co-op riavviata — Livello 1/${CONFIG.MAX_LEVELS} (${this.maze.N}×${this.maze.N})!`);
    } else if (this.gameMode === 'coop_bots') {
      this.network.publishDuelReset(1, this.seed, 'coop_bots');
      if (this.network.coopRole === 'host') {
        this.network.publishRivalBotsState(1.0, this._buildRivalBotsPayload());
      }
      this.showToast(`🛡️ Nuova sfida Co-op vs Bot — Livello 1/${CONFIG.MAX_LEVELS} (${this.maze.N}×${this.maze.N})!`);
    } else if (this.gameMode === 'duel_online') {
      this.network.publishDuelReset(1, this.seed, 'duel_online');
      this.showToast(`⚔️ Nuovo Duello 1v1 — Livello 1/${CONFIG.MAX_LEVELS} (${this.maze.N}×${this.maze.N})!`);
    } else {
      this.showToast(`Partita Singleplayer — Livello 1/${CONFIG.MAX_LEVELS} (${this.maze.N}×${this.maze.N})!`);
    }
  }

  respawnInPvpRoom() {
    if (this.player.alive) return;
    const sp = this.spawnSide === 'B' ? this.maze.spawnB : this.maze.spawnA;
    this.player.collectedPages = [...this.sharedPages];
    this.player.spawnAt(sp.x, sp.z, 0);
    this.snapCameraToPlayer();
    this.setScreenState('PLAYING');
    this.showToast(`Sei rientrato allo Spawn ${this.spawnSide}!`);
    this._syncHud();
  }

  _triggerDamageFlash() {
    this.el.damageFlash.classList.remove('active');
    void this.el.damageFlash.offsetWidth;
    this.el.damageFlash.classList.add('active');
  }

  showToast(text) {
    if (!this.el.toast) return;
    this.el.toast.textContent = text;
    this.el.toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.el.toast.classList.remove('visible');
    }, 2400);
  }

  _toggleMusic() {
    const muted = audio.toggleBgmMuted();
    this._syncMusicUi();
    this.showToast(muted ? '🔇 Musica disattivata' : '🔊 Musica attivata');
  }

  _syncMusicUi() {
    const muted = audio.isBgmMuted();
    const label = muted ? '🔇 MUSICA: OFF' : '🔊 MUSICA: ON';
    if (this.el.btnMenuMusic) {
      this.el.btnMenuMusic.textContent = label;
      this.el.btnMenuMusic.classList.toggle('muted', muted);
    }
    if (this.el.btnPauseMusic) {
      this.el.btnPauseMusic.textContent = label;
      this.el.btnPauseMusic.classList.toggle('muted', muted);
    }
    if (this.el.btnHudMusic) {
      this.el.btnHudMusic.textContent = muted ? '🔇' : '🔊';
      this.el.btnHudMusic.classList.toggle('muted', muted);
      this.el.btnHudMusic.title = muted ? 'Musica OFF (Tocca per attivare)' : 'Musica ON (Tocca per disattivare)';
    }
  }

  _bindModals() {
    const closeBtn = document.getElementById('btn-door-close');
    const clearBtn = document.getElementById('btn-door-clear');
    const submitBtn = document.getElementById('btn-door-submit');

    closeBtn?.addEventListener('click', () => this.closeDoorModal());
    clearBtn?.addEventListener('click', () => {
      this.doorEntered = [];
      this._renderDoorSlots();
    });
    submitBtn?.addEventListener('click', () => this._submitDoorCode());

    this.el.btnRestartArcade?.addEventListener('click', () => this.restartArcadeRun());
    this.el.btnRespawnPvp?.addEventListener('click', () => this.respawnInPvpRoom());
    this.el.btnDeathMenu?.addEventListener('click', () => this.returnToMainMenu());
    this.el.btnVictoryNext?.addEventListener('click', () => {
      const nextLevel = Math.min(CONFIG.MAX_LEVELS, this.level + 1);
      if (this.gameMode === 'duel_bot') {
        this.startDuelBot(nextLevel);
      } else if (this.gameMode === 'duel_online' || this.gameMode === 'coop_bots') {
        const nextSeed = Math.floor(Math.random() * 900000) + 1000;
        this.duelResult = null;
        this.buildLevel(nextLevel, nextSeed, false);
        const sp = this.spawnSide === 'B' ? this.maze.spawnB : this.maze.spawnA;
        this.player.spawnAt(sp.x, sp.z, 0);
        this.snapCameraToPlayer();
        this.network.publishDuelReset(nextLevel, nextSeed, this.gameMode);
        if (this.gameMode === 'coop_bots' && this.network.coopRole === 'host') {
          this.network.publishRivalBotsState(1.0, this._buildRivalBotsPayload());
        }
        this.setScreenState('PLAYING');
        this._syncHud();
        this.showToast(this.gameMode === 'coop_bots'
          ? `🛡️ Co-op vs Bot — Livello ${nextLevel}/${CONFIG.MAX_LEVELS}!`
          : `⚔️ Round 1v1 — Livello ${nextLevel}/${CONFIG.MAX_LEVELS}!`);
      }
    });
    this.el.btnVictoryRestart?.addEventListener('click', () => this.restartArcadeRun());
    this.el.btnVictoryMenu?.addEventListener('click', () => this.returnToMainMenu());

    this.el.btnMenuDuelBot?.addEventListener('click', () => this.startDuelBot(1));
    this.el.btnMenuCoopBots?.addEventListener('click', () => this.openRoomModal('coop_bots'));
    this.el.btnMenuDuelOnline?.addEventListener('click', () => this.openRoomModal('duel_online'));
    this.el.btnMenuSingle?.addEventListener('click', () => this.startSingleplayer());
    this.el.btnMenuCoop?.addEventListener('click', () => this.openRoomModal('coop'));
    this.el.btnMenuMulti?.addEventListener('click', () => this.openNetModal());
    this.el.btnMenuMusic?.addEventListener('click', () => this._toggleMusic());

    this.el.btnCoopCopy?.addEventListener('click', () => {
      const code = this.el.coopHostCode?.textContent?.trim() || this.hostRoomCode;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code).catch(() => null);
      }
      this.showToast(`Codice stanza copiato: ${code}`);
    });
    this.el.btnCoopShare?.addEventListener('click', () => {
      this._shareOrCopyInvite(this.el.coopHostCode?.textContent || this.hostRoomCode, this.pendingRoomModalMode);
    });
    this.el.btnPauseShare?.addEventListener('click', () => {
      const mode = this.isNetworkedMode() ? this.gameMode : 'coop';
      this._shareOrCopyInvite(this.network?.roomId || this.hostRoomCode, mode);
    });
    this.el.btnCoopHost?.addEventListener('click', () => {
      const code = this.el.coopHostCode?.textContent || this.hostRoomCode;
      if (this.pendingRoomModalMode === 'duel_online') {
        this.startDuelOnlineHost(code);
      } else if (this.pendingRoomModalMode === 'coop_bots') {
        this.startCoopBotsHost(code);
      } else {
        this.startCoopHost(code);
      }
    });
    this.el.btnCoopJoin?.addEventListener('click', () => {
      const raw = this.el.inpCoopCode?.value;
      const detected = this._extractRoomMode(raw, this.pendingRoomModalMode);
      if (detected === 'duel_online') {
        this.startDuelOnlineGuest(raw);
      } else if (detected === 'coop_bots') {
        this.startCoopBotsGuest(raw);
      } else {
        this.startCoopGuest(raw);
      }
    });
    this.el.inpCoopCode?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const raw = this.el.inpCoopCode.value;
        const detected = this._extractRoomMode(raw, this.pendingRoomModalMode);
        if (detected === 'duel_online') {
          this.startDuelOnlineGuest(raw);
        } else if (detected === 'coop_bots') {
          this.startCoopBotsGuest(raw);
        } else {
          this.startCoopGuest(raw);
        }
      }
    });
    this.el.btnCoopClose?.addEventListener('click', () => this.closeCoopModal());

    this.el.btnHudMusic?.addEventListener('click', () => this._toggleMusic());
    this.el.btnHudPause?.addEventListener('click', () => this.pauseGame());
    this.el.btnPauseResume?.addEventListener('click', () => this.resumeGame());
    this.el.btnPauseMusic?.addEventListener('click', () => this._toggleMusic());
    this.el.btnPauseRestart?.addEventListener('click', () => this.restartArcadeRun());
    this.el.btnPauseMenu?.addEventListener('click', () => this.returnToMainMenu());

    this.el.btnOpenNet?.addEventListener('click', () => this.openNetModal());
    this.el.btnCloseNet?.addEventListener('click', () => this.closeNetModal());

    this.el.btnNewMaze?.addEventListener('click', () => {
      const nextSeed = Math.floor(Math.random() * 900000) + 1000;
      this.closeNetModal();
      this.buildLevel(1, nextSeed, this.isNetworkedMode());
      this.setScreenState('PLAYING');
      this.showToast('Nuovo Labirinto Speculare generato!');
    });

    this.el.btnClearFb?.addEventListener('click', () => {
      saveFirebaseConfig(null);
      this.el.inpFbJson.value = '';
      if (this.isNetworkedMode()) {
        const isDuel = this.gameMode === 'duel_online';
        const isCoopBots = this.gameMode === 'coop_bots';
        this.network.connect(
          this.el.inpRoom.value || this.network.roomId,
          (!isCoopBots && this.spawnSide === 'B') ? 'guest' : (this.network.coopRole === 'guest' ? 'guest' : 'host'),
          { maxPeers: isDuel ? 1 : 0, modeLabel: isDuel ? '1v1' : (isCoopBots ? 'CO-OP vs BOT' : 'CO-OP') }
        );
      }
      this.showToast("Modalita' Locale multi-scheda ripristinata");
    });

    this.el.btnSaveNet?.addEventListener('click', () => {
      const side = this.el.inpSpawnSide.value === 'B' ? 'B' : 'A';
      if (side !== this.spawnSide) {
        this.spawnSide = side;
        const sp = side === 'B' ? this.maze.spawnB : this.maze.spawnA;
        this.player.spawnAt(sp.x, sp.z, 0);
        this.snapCameraToPlayer();
      }

      const raw = (this.el.inpFbJson.value || '').trim();
      if (raw) {
        try {
          const parsed = raw.startsWith('http') ? { databaseURL: raw } : JSON.parse(raw);
          saveFirebaseConfig(parsed);
        } catch (_) {
          this.showToast('JSON Firebase non valido (oppure incolla solo databaseURL)');
          return;
        }
      }

      this.closeNetModal();
      const targetRoom = (this.el.inpRoom.value || '').trim();
      if (targetRoom) {
        const isDuel = this.gameMode === 'duel_online';
        const isCoopBots = this.gameMode === 'coop_bots';
        this.gameMode = isDuel ? 'duel_online' : (isCoopBots ? 'coop_bots' : 'coop');
        const role = (!isCoopBots && this.spawnSide === 'B') ? 'guest' : (this.network.coopRole === 'guest' ? 'guest' : 'host');
        this.network.connect(targetRoom, role, {
          maxPeers: isDuel ? 1 : 0,
          modeLabel: isDuel ? '1v1' : (isCoopBots ? 'CO-OP vs BOT' : 'CO-OP')
        }).then(() => {
          this._rebuildRemoteVisuals();
          if (role === 'host') this.network.publishFullRoomSync(this._buildRoomSnapshot());
        });
      }
      this.showToast('Impostazioni stanza applicate');
    });
  }

  openDoorModal() {
    this.doorEntered = [];
    this.doorModalOpen = true;
    this.el.modalDoor.classList.remove('hidden');
    this._syncControlsBlocked();
    this._refreshDoorKeypadOwned();
    this._renderDoorSlots();
    this._syncHud();
  }

  _refreshDoorKeypadOwned() {
    if (!this.el.doorKeypad) return;
    const collectedBySlot = new Map(this.player.collectedPages.map((p) => [p.slot, p.symbol]));
    this.el.doorKeypad.innerHTML = '';
    for (const sym of CONFIG.SYMBOLS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sym-btn';
      const owned = [...collectedBySlot.values()].includes(sym);
      if (owned) btn.classList.add('owned');
      btn.textContent = sym;
      btn.addEventListener('click', () => {
        if (this.doorEntered.length >= 5) return;
        this.doorEntered.push(sym);
        this._renderDoorSlots();
      });
      this.el.doorKeypad.appendChild(btn);
    }
  }

  _renderDoorSlots() {
    this.el.doorSlots.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const cell = document.createElement('div');
      cell.className = 'door-slot';
      cell.textContent = this.doorEntered[i] || `${i + 1}`;
      if (this.doorEntered[i]) cell.classList.add('filled');
      cell.addEventListener('click', () => {
        if (this.doorEntered[i]) {
          this.doorEntered.splice(i, 1);
          this._renderDoorSlots();
        }
      });
      this.el.doorSlots.appendChild(cell);
    }
  }

  closeDoorModal() {
    this.doorModalOpen = false;
    this.el.modalDoor?.classList.add('hidden');
    this._syncControlsBlocked();
  }

  _submitDoorCode() {
    if (this.doorEntered.length < 5) {
      this.showToast('Seleziona 5 simboli prima di confermare!');
      return;
    }

    const expected = this.maze.doorCode;
    const isCorrect = expected.every((sym, idx) => this.doorEntered[idx] === sym);

    if (isCorrect) {
      audio.playSuccess();
      this.closeDoorModal();

      if (this.isCompetitiveMode()) {
        if (this.gameMode === 'duel_online' || this.gameMode === 'coop_bots') {
          this.network.publishDuelWin(
            this.level,
            this.player.name,
            this.player.collectedPages.length,
            this.rivalKills,
            {
              gameMode: this.gameMode,
              teamWon: true
            }
          );
        }
        this._onDuelFinished(true, this.player.name);
        return;
      }

      if (this.level >= CONFIG.MAX_LEVELS) {
        this.network.publishLevelAdvance(CONFIG.MAX_LEVELS, this.seed, this.player.name, true);
        this._onVictory(this.player.name);
        return;
      }

      const nextLevel = this.level + 1;
      const nextSeed = Math.floor(Math.random() * 900000) + 1000;
      this.network.publishLevelAdvance(nextLevel, nextSeed, this.player.name, false);
      this.buildLevel(nextLevel, nextSeed, false);
      this.showToast(`COMBINAZIONE ESATTA! Livello ${nextLevel}/${CONFIG.MAX_LEVELS} (${this.maze.N}×${this.maze.N})`);
      return;
    }

    // CODICE SBAGLIATO: chiudi UI, 20 danni e teletrasporto punitivo allo spawn!
    audio.playPunish();
    this.closeDoorModal();
    this.player.shieldActive = false; // La maledizione della porta non si para con lo scudo
    const res = this._applyPlayerDamage(CONFIG.WRONG_CODE_DAMAGE, undefined, undefined, 'Maledizione Portale');

    if (!res.died && this.player.alive) {
      this.player.x = this.player.spawn.x;
      this.player.z = this.player.spawn.z;
      this.player.syncTransform();
      this.snapCameraToPlayer();
      this.showToast(`Codice Sbagliato! -${CONFIG.WRONG_CODE_DAMAGE} HP e Teletrasporto allo Spawn!`);
    }
    this._syncHud();
  }

  _handleInteract() {
    if (!this.nearInteractable || !this.player.alive) return;
    if (this.nearInteractable.kind === 'CHEST') {
      const reward = this.nearInteractable.target.open();
      if (!reward) return;
      audio.playChestOpen();
      if (reward.type === 'HEAL') {
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + reward.amount);
      } else if (reward.type === 'MAX_HP') {
        this.player.maxHp += reward.amount;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + reward.amount);
      } else if (reward.type === 'DAMAGE') {
        this.player.swordDamage += reward.amount;
      }
      this.network.publishChestOpened(this.nearInteractable.target.id);
      this.showToast(reward.text);
      this._syncHud();
    } else if (this.nearInteractable.kind === 'DOOR') {
      this.openDoorModal();
    }
  }

  _updateWorldLogic(dt) {
    if (!this.maze) return;
    const input = this.controls.poll();

    // Tasto ESC o Start Controller: chiude modali o mette/toglie Pausa
    if (input.pausePressed) {
      if (this.doorModalOpen || !this.el.modalDoor?.classList.contains('hidden')) {
        this.closeDoorModal();
        return;
      }
      if (this.coopModalOpen || !this.el.modalCoop?.classList.contains('hidden')) {
        this.closeCoopModal();
        return;
      }
      if (this.netModalOpen || !this.el.modalNet?.classList.contains('hidden')) {
        this.closeNetModal();
        return;
      }
      if (this.screenState === 'PLAYING') {
        this.pauseGame();
        return;
      }
      if (this.screenState === 'PAUSED') {
        this.resumeGame();
        return;
      }
    }

    // Menu principale: conferma rapida da controller/tastiera (Invio) solo se nessun modale e' aperto
    if (this.screenState === 'MENU' && !this.netModalOpen && !this.coopModalOpen) {
      if (input.confirmPressed || this.controls.keys.has('Enter')) {
        this.controls.keys.delete('Enter');
        this.startSingleplayer();
      }
      return;
    }

    // Game Over: premi Spazio/Invio o Croce/A sul controller dopo 0.65s
    if (this.screenState === 'GAMEOVER') {
      this.deadElapsed += dt;
      if (this.deadElapsed > 0.65) {
        const gp = this.controls._getActiveGamepad?.();
        const padConfirm = Boolean(gp && (gp.buttons?.[0]?.pressed || gp.buttons?.[9]?.pressed));
        const keyConfirm = this.controls.keys.has('Enter') || this.controls.keys.has('Space');
        if (padConfirm || keyConfirm) {
          if (this.gameMode === 'coop') {
            this.respawnInPvpRoom();
          } else {
            this.restartArcadeRun();
          }
        }
      }
      return;
    }

    // In Loading / Pausa / Vittoria la simulazione del labirinto rimane ferma
    if (this.screenState !== 'PLAYING') return;

    if (input.attackPressed || input.dashPressed || input.interactPressed) {
      audio.unlock();
    }

    const activeHitbox = this.player.update(dt, this.maze, input, {
      onRespawn: () => this._onLocalDuelRespawn()
    });

    // Countdown overlay respawn live durante 1v1 o Co-op vs Bot
    if (this.el.respawnOverlay) {
      const showRespawn = this.isCompetitiveMode() && !this.player.alive && this.player.respawnTimer > 0;
      this.el.respawnOverlay.classList.toggle('hidden', !showRespawn);
      if (showRespawn && this.el.respawnCountdown) {
        this.el.respawnCountdown.textContent = String(Math.max(1, Math.ceil(this.player.respawnTimer)));
      }
    }

    // Fendente spada contro Guardiani verdi, Bot Rivali Rossi e Avversario 1v1 Online (ZERO fuoco amico in Co-op!)
    if (activeHitbox && this.player.alive) {
      for (const bot of this.bots) {
        if (!bot.alive || activeHitbox.hitTargets.has(bot.id)) continue;
        const d = Math.hypot(bot.x - activeHitbox.x, bot.z - activeHitbox.z);
        if (d <= activeHitbox.radius + CONFIG.BOT_RADIUS && hasLineOfSight(this.maze, this.player.x, this.player.z, bot.x, bot.z)) {
          activeHitbox.hitTargets.add(bot.id);
          const dx = bot.x - this.player.x;
          const dz = bot.z - this.player.z;
          const pushX = Math.hypot(dx, dz) > 0.01 ? dx : Math.sin(this.player.rotY);
          const pushZ = Math.hypot(dx, dz) > 0.01 ? dz : Math.cos(this.player.rotY);
          const killed = bot.takeDamage(activeHitbox.damage, pushX, pushZ);
          audio.playHit();
          this.controls.rumble(75, 0.2, 0.4);
          if (killed) {
            this.kills += 1;
            this.showToast('Guardiano del Labirinto eliminato!');
          }
        }
      }

      // Colpo ai Bot Rivali (Cubi Rossi) simulati localmente (duel_bot oppure Host di coop_bots)
      if ((this.gameMode === 'duel_bot' || (this.gameMode === 'coop_bots' && this.network.coopRole === 'host')) && this.rivalBots.length > 0) {
        for (const rbot of this.rivalBots) {
          if (!rbot.alive || activeHitbox.hitTargets.has(rbot.id)) continue;
          const d = Math.hypot(rbot.x - activeHitbox.x, rbot.z - activeHitbox.z);
          if (d <= activeHitbox.radius + CONFIG.PLAYER_RADIUS && hasLineOfSight(this.maze, this.player.x, this.player.z, rbot.x, rbot.z)) {
            activeHitbox.hitTargets.add(rbot.id);
            const dx = rbot.x - this.player.x;
            const dz = rbot.z - this.player.z;
            const pushX = Math.hypot(dx, dz) > 0.01 ? dx : Math.sin(this.player.rotY);
            const pushZ = Math.hypot(dx, dz) > 0.01 ? dz : Math.cos(this.player.rotY);
            const res = rbot.takeDamage(activeHitbox.damage, pushX, pushZ, this.maze);
            if (res.blocked) {
              audio.playShieldBlock();
              this.controls.rumble(60, 0.25, 0.15);
              this.showToast(`🛡️ ${rbot.name} ha parato il colpo!`);
            } else {
              audio.playHit();
              this.controls.rumble(105, 0.3, 0.6);
              if (res.died) {
                this.rivalKills += 1;
                this.player.hp = Math.min(this.player.maxHp, this.player.hp + CONFIG.RIVAL_KILL_HEAL);
                const msg = `⚔️ ${rbot.name} eliminato! (+${CONFIG.RIVAL_KILL_HEAL} HP)`;
                this.showToast(msg);
                if (this.gameMode === 'coop_bots') {
                  this.network.publishBotEvent({ kind: 'BOT_KILLED', botId: rbot.id, botName: rbot.name, text: msg });
                  this.network.publishRivalBotsState(1.0, this._buildRivalBotsPayload());
                }
              }
            }
          }
        }
      }

      // Colpo da parte di un Guest ai Bot Rivali sincronizzati in Co-op vs Bot
      if (this.gameMode === 'coop_bots' && this.network.coopRole === 'guest') {
        const syncedBots = this.remoteRivalState?.bots || [];
        for (const [bid, vis] of this.remoteRivalVisuals.entries()) {
          if (activeHitbox.hitTargets.has(bid)) continue;
          const bData = syncedBots.find((b) => b.id === bid);
          if (!bData || !bData.alive) continue;
          const visPos = vis.getWorldPosition();
          const dRaw = Math.hypot(bData.x - activeHitbox.x, bData.z - activeHitbox.z);
          const dVis = visPos ? Math.hypot(visPos.x - activeHitbox.x, visPos.z - activeHitbox.z) : dRaw;
          const d = Math.min(dRaw, dVis);
          const tx = visPos ? visPos.x : bData.x;
          const tz = visPos ? visPos.z : bData.z;
          if (d <= activeHitbox.radius + CONFIG.PLAYER_RADIUS && hasLineOfSight(this.maze, this.player.x, this.player.z, tx, tz)) {
            activeHitbox.hitTargets.add(bid);
            this.network.sendBotHit(bid, activeHitbox.damage, this.player.x, this.player.z);
            audio.playHit();
            this.controls.rumble(90, 0.25, 0.5);
          }
        }
      }

      // Colpo al Rivale Online esclusivamente in 1v1 Online
      if (this.gameMode === 'duel_online') {
        for (const [pid, remote] of this.network.remotePlayers.entries()) {
          if (!remote.alive || activeHitbox.hitTargets.has(pid)) continue;
          const visPos = this.remoteVisuals.get(pid)?.getWorldPosition();
          const dRaw = Math.hypot(remote.x - activeHitbox.x, remote.z - activeHitbox.z);
          const dVis = visPos ? Math.hypot(visPos.x - activeHitbox.x, visPos.z - activeHitbox.z) : dRaw;
          const d = Math.min(dRaw, dVis);
          const tx = visPos ? visPos.x : remote.x;
          const tz = visPos ? visPos.z : remote.z;
          if (d <= activeHitbox.radius + CONFIG.PLAYER_RADIUS && hasLineOfSight(this.maze, this.player.x, this.player.z, tx, tz)) {
            activeHitbox.hitTargets.add(pid);
            this.network.sendHit(pid, activeHitbox.damage, this.player.x, this.player.z);
            audio.playHit();
            this.controls.rumble(90, 0.25, 0.5);
          }
        }
      }
    }

    // Raccolta dei 5 fogli sul pavimento (condivisi in Co-op e Co-op vs Bot, PRIVATI in 1v1 e Singleplayer!)
    if (this.player.alive) {
      for (const wp of this.pages) {
        wp.update(dt, this.elapsedSec, this.maze, this.player);
        if (wp.collected) continue;
        if (Math.hypot(wp.x - this.player.x, wp.z - this.player.z) < 1.5) {
          this._applySharedPage({
            originalIndex: wp.originalIndex,
            slot: wp.slot,
            symbol: wp.symbol
          }, false);
          audio.playPagePickup();
          if (this.isCoopMode()) {
            this.network.publishPageEvent({
              action: 'PICKUP',
              index: wp.originalIndex,
              slot: wp.slot,
              symbol: wp.symbol
            });
            this.network.publishFullRoomSync(this._buildRoomSnapshot());
          }
          this.showToast(`Foglio #${wp.slot} raccolto: ${wp.symbol}`);
        }
      }
    } else {
      for (const wp of this.pages) wp.update(dt, this.elapsedSec, this.maze, this.player);
    }

    // Casse loot: visibili solo con luce + LoS
    for (const ch of this.chests) {
      ch.updateVisibility(this.maze, this.player);
    }

    // Prune peer disconnessi prima del bilanciamento automatico bot in Co-op vs Bot
    this.network.pruneStaleLocalPeers();

    // Aggiornamento Bot Rivali Rossi (duel_bot oppure Host di coop_bots)
    if (this.gameMode === 'coop_bots' && this.network.coopRole === 'host') {
      this._reconcileRivalBots(true);
    }

    if ((this.gameMode === 'duel_bot' || (this.gameMode === 'coop_bots' && this.network.coopRole === 'host')) && this.rivalBots.length > 0) {
      const humanTargets = [{
        id: this.network?.playerId || 'local',
        x: this.player.x,
        z: this.player.z,
        alive: this.player.alive,
        attackTimer: this.player.attackTimer,
        attacking: this.player.attackTimer > 0,
        isLocal: true
      }];
      if (this.gameMode === 'coop_bots') {
        for (const [pid, rp] of this.network.remotePlayers.entries()) {
          const visPos = this.remoteVisuals.get(pid)?.getWorldPosition();
          humanTargets.push({
            id: pid,
            x: visPos ? visPos.x : rp.x,
            z: visPos ? visPos.z : rp.z,
            alive: Boolean(rp.alive),
            attackTimer: rp.attacking ? 0.15 : 0,
            attacking: Boolean(rp.attacking),
            isLocal: false
          });
        }
      }

      const claimedPageIndices = new Set();
      for (const rbot of this.rivalBots) {
        rbot.update(dt, this.maze, humanTargets, this.chests, this.bots, {
          onAttackHuman: (target, dmg, bot) => {
            if (target.isLocal) {
              this._applyPlayerDamage(dmg, bot.x, bot.z, bot.name);
            } else {
              this.network.sendHit(target.id, dmg, bot.x, bot.z, {
                isBotHit: true,
                attackerName: bot.name
              });
            }
          },
          onCollectPage: (_bp, bot) => {
            const cnt = bot.getTeamCollectedCount();
            const text = `🟥 ${bot.name} ha trovato un segnalino! (${cnt}/5)`;
            this.showToast(text);
            if (this.gameMode === 'coop_bots') {
              this.network.publishBotEvent({ kind: 'PAGE', text });
            }
          },
          onPortalUnlockStart: (bot) => {
            audio.playPunish();
            const text = `⚠️ ALLERTA! ${bot.name} sta sbloccando il Portale al centro!`;
            this.showToast(text);
            if (this.gameMode === 'coop_bots') {
              this.network.publishBotEvent({ kind: 'PORTAL_ALERT', text });
            }
          },
          onPortalUnlocked: (bot) => {
            if (this.screenState === 'PLAYING') {
              audio.playPunish();
              const label = this.gameMode === 'coop_bots' ? 'Squadra Rossa (BOT)' : (bot?.name || 'Cubo Rosso (BOT)');
              if (this.gameMode === 'coop_bots') {
                this.network.publishDuelWin(this.level, label, 5, 0, {
                  gameMode: 'coop_bots',
                  teamWon: false
                });
              }
              this._onDuelFinished(false, label);
            }
          },
          onRespawn: (bot) => {
            const text = `🟥 ${bot.name} è rientrato allo Spawn B!`;
            this.showToast(text);
            if (this.gameMode === 'coop_bots') {
              this.network.publishBotEvent({ kind: 'RESPAWN', text });
            }
          }
        }, { localPlayer: this.player, claimedPageIndices });
      }

      // Separazione fisica Giocatore locale vs ciascun Bot Rivale
      if (this.player.alive) {
        for (const rbot of this.rivalBots) {
          if (!rbot.alive) continue;
          const sepDx = this.player.x - rbot.x;
          const sepDz = this.player.z - rbot.z;
          const sepDist = Math.hypot(sepDx, sepDz);
          const minSep = CONFIG.PLAYER_RADIUS * 1.92;
          if (sepDist < minSep) {
            const nx = sepDist > 1e-4 ? sepDx / sepDist : 1;
            const nz = sepDist > 1e-4 ? sepDz / sepDist : 0;
            const pushHalf = (minSep - sepDist) * 0.5;
            const pNext = resolveMazeCollision(
              this.maze,
              this.player.x,
              this.player.z,
              this.player.x + nx * pushHalf,
              this.player.z + nz * pushHalf,
              CONFIG.PLAYER_RADIUS
            );
            this.player.x = pNext.x;
            this.player.z = pNext.z;
            this.player.syncTransform();

            const bNext = resolveMazeCollision(
              this.maze,
              rbot.x,
              rbot.z,
              rbot.x - nx * pushHalf,
              rbot.z - nz * pushHalf,
              CONFIG.PLAYER_RADIUS
            );
            rbot.x = bNext.x;
            rbot.z = bNext.z;
            rbot.group.position.set(rbot.x, 0, rbot.z);
          }
        }
      }

      // Separazione tra i Bot Rivali stessi quando sono in squadra (N vs N)
      for (let i = 0; i < this.rivalBots.length; i++) {
        const a = this.rivalBots[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < this.rivalBots.length; j++) {
          const b = this.rivalBots[j];
          if (!b.alive) continue;
          const dx = a.x - b.x;
          const dz = a.z - b.z;
          const d = Math.hypot(dx, dz);
          const minSep = CONFIG.PLAYER_RADIUS * 1.85;
          if (d < minSep) {
            const nx = d > 1e-4 ? dx / d : 1;
            const nz = d > 1e-4 ? dz / d : 0;
            const pushHalf = (minSep - d) * 0.5;
            const aNext = resolveMazeCollision(this.maze, a.x, a.z, a.x + nx * pushHalf, a.z + nz * pushHalf, CONFIG.PLAYER_RADIUS);
            const bNext = resolveMazeCollision(this.maze, b.x, b.z, b.x - nx * pushHalf, b.z - nz * pushHalf, CONFIG.PLAYER_RADIUS);
            a.x = aNext.x; a.z = aNext.z; a.group.position.set(a.x, 0, a.z);
            b.x = bNext.x; b.z = bNext.z; b.group.position.set(b.x, 0, b.z);
          }
        }
      }

      if (this.gameMode === 'coop_bots') {
        this.network.publishRivalBotsState(dt, this._buildRivalBotsPayload());
      }
    }

    // Bot verdi lenti: si vedono e attaccano ANCHE mentre il giocatore inserisce il codice del portale!
    const activeRivalsForGuardians = this.rivalBots.length > 0 ? this.rivalBots : null;
    for (const bot of this.bots) {
      bot.update(
        dt,
        this.maze,
        this.player,
        (dmg, b) => {
          this._applyPlayerDamage(dmg, b.x, b.z, 'Guardiano del Labirinto');
        },
        activeRivalsForGuardians,
        (dmg, b, targetRival) => {
          if (!targetRival || !targetRival.alive) return;
          const res = targetRival.takeDamage(
            dmg,
            targetRival.x - b.x,
            targetRival.z - b.z,
            this.maze
          );
          if (res.died) {
            const text = `🟩 Un Guardiano ha abbattuto ${targetRival.name}! Respawn tra 3s`;
            this.showToast(text);
            if (this.gameMode === 'coop_bots') {
              this.network.publishBotEvent({ kind: 'GUARDIAN_KO', text });
            }
          }
        }
      );
    }

    // Controllo raggio < 3 per mostrare/nascondere il tasto Interagisci (Viola)
    this.nearInteractable = null;
    if (this.player.alive) {
      const doorDist = Math.hypot(this.player.x - this.door.x, this.player.z - this.door.z);
      if (doorDist < CONFIG.INTERACT_RADIUS) {
        this.nearInteractable = { kind: 'DOOR', target: this.door };
      } else {
        let bestChest = null;
        let bestDist = CONFIG.INTERACT_RADIUS;
        for (const ch of this.chests) {
          if (ch.opened) continue;
          const d = Math.hypot(ch.x - this.player.x, ch.z - this.player.z);
          if (d < bestDist) {
            bestDist = d;
            bestChest = ch;
          }
        }
        if (bestChest) {
          this.nearInteractable = { kind: 'CHEST', target: bestChest };
        }
      }
    }

    if (this.nearInteractable) {
      const label = this.nearInteractable.kind === 'DOOR' ? 'PORTA' : 'APRI';
      this.controls.setInteractVisible(true, label);
    } else {
      this.controls.setInteractVisible(false);
    }

    if (input.interactPressed && this.nearInteractable) {
      this._handleInteract();
    }

    // Cooldown grafico sul pulsante Scatto / Dash
    this.controls.setDashCooldownRatio(this.player.dashCooldown / CONFIG.DASH_COOLDOWN);

    // Sincronizzazione multiplayer e visibilita' condizionale dei giocatori/bot remoti
    this.network.publishPlayerState(dt, this.player, this.spawnSide);
    for (const [pid, vis] of this.remoteVisuals.entries()) {
      const data = this.network.remotePlayers.get(pid);
      vis.sync(dt, data, this.maze, this.player);
    }
    if (this.gameMode === 'coop_bots' && this.network.coopRole === 'guest') {
      const syncedBots = this.remoteRivalState?.bots || [];
      for (const [bid, vis] of this.remoteRivalVisuals.entries()) {
        const bData = syncedBots.find((b) => b.id === bid);
        vis.sync(dt, bData, this.maze, this.player);
        if (this.player.alive && bData?.alive) {
          const vp = vis.getWorldPosition();
          if (vp) {
            const dx = this.player.x - vp.x;
            const dz = this.player.z - vp.z;
            const d = Math.hypot(dx, dz);
            const minSep = CONFIG.PLAYER_RADIUS * 1.9;
            if (d < minSep) {
              const nx = d > 1e-4 ? dx / d : 1;
              const nz = d > 1e-4 ? dz / d : 0;
              const push = (minSep - d) * 0.6;
              const pNext = resolveMazeCollision(
                this.maze,
                this.player.x,
                this.player.z,
                this.player.x + nx * push,
                this.player.z + nz * push,
                CONFIG.PLAYER_RADIUS
              );
              this.player.x = pNext.x;
              this.player.z = pNext.z;
              this.player.syncTransform();
            }
          }
        }
      }
    }

    this._updateCamera(dt);
    this._syncHud();
  }

  _syncHud() {
    if (!this.maze) return;
    const pct = Math.max(0, Math.min(100, (this.player.hp / this.player.maxHp) * 100));
    this.el.hpFill.style.width = `${pct}%`;
    this.el.hpText.textContent = `${Math.ceil(this.player.hp)} / ${this.player.maxHp} HP`;
    this.el.levelBadge.textContent = `LIVELLO ${this.level}/${CONFIG.MAX_LEVELS} (${this.maze.N}×${this.maze.N})`;

    const aliveBots = this.bots.filter((b) => b.alive).length;
    const peers = this.network.remotePlayers.size;
    const padTxt = this.controls.gamepad.connected ? ' • 🎮 Pad' : '';
    let modeTxt = '';
    if (this.gameMode === 'coop') {
      modeTxt = ` • Co-op:${peers + 1}`;
    } else if (this.gameMode === 'coop_bots') {
      const redCount = this.network.coopRole === 'host'
        ? this.rivalBots.length
        : (this.remoteRivalState?.bots?.length || (peers + 1));
      modeTxt = ` • Squadra ${peers + 1}v${redCount} (KO:${this.rivalKills})`;
    } else if (this.gameMode === 'duel_bot') {
      modeTxt = ` • Duello 1v1:${this.rivalKills}`;
    } else if (this.gameMode === 'duel_online') {
      modeTxt = ` • 1v1:${peers + 1}/2 (KO:${this.rivalKills})`;
    }
    this.el.statsLine.textContent = `Spada: ${this.player.swordDamage} DMG • Bot: ${aliveBots}${modeTxt}${padTxt}`;

    if (this.el.rivalHud) {
      const showRivalHud = this.isCompetitiveMode();
      this.el.rivalHud.classList.toggle('hidden', !showRivalHud);
      if (showRivalHud) {
        if (this.gameMode === 'duel_bot' && this.rivalBot) {
          const hpPct = Math.max(0, Math.min(100, (this.rivalBot.hp / this.rivalBot.maxHp) * 100));
          if (this.el.rivalHudLabel) this.el.rivalHudLabel.textContent = '🟥 BOT';
          if (this.el.rivalHudPages) this.el.rivalHudPages.textContent = `${this.rivalBot.collectedPages.length}/5`;
          if (this.el.rivalHpFill) this.el.rivalHpFill.style.width = `${hpPct}%`;
          if (this.rivalBot.unlockingDoorTimer > 0) {
            this.el.rivalHud.classList.add('portal-alert');
            if (this.el.rivalHudState) this.el.rivalHudState.textContent = '⚠️ PORTALE!';
          } else {
            this.el.rivalHud.classList.remove('portal-alert');
            if (this.el.rivalHudState) {
              this.el.rivalHudState.textContent = this.rivalBot.alive
                ? `${Math.ceil(this.rivalBot.hp)} HP`
                : `RESPAWN ${Math.max(1, Math.ceil(this.rivalBot.respawnTimer))}s`;
            }
          }
        } else if (this.gameMode === 'coop_bots') {
          const isHost = this.network.coopRole === 'host';
          const botList = isHost
            ? this.rivalBots
            : (this.remoteRivalState?.bots || []);
          const total = botList.length || (peers + 1);
          const redPages = isHost
            ? this.rivalTeamPages.filter((p) => p.collected).length
            : (this.remoteRivalState?.teamPages ?? 0);
          const aliveList = botList.filter((b) => b.alive);
          const hpPct = aliveList.length > 0
            ? Math.max(0, Math.min(100, (aliveList.reduce((acc, b) => acc + ((b.hp || 0) / Math.max(1, b.maxHp || CONFIG.PLAYER_MAX_HP)), 0) / aliveList.length) * 100))
            : 0;
          const anyUnlocking = isHost
            ? botList.some((b) => (b.unlockingDoorTimer || 0) > 0)
            : (Boolean(this.remoteRivalState?.unlocking) || botList.some((b) => b.unlocking));
          if (this.el.rivalHudLabel) this.el.rivalHudLabel.textContent = `🟥 BOT×${total}`;
          if (this.el.rivalHudPages) this.el.rivalHudPages.textContent = `${redPages}/5`;
          if (this.el.rivalHpFill) this.el.rivalHpFill.style.width = `${hpPct}%`;
          this.el.rivalHud.classList.toggle('portal-alert', anyUnlocking);
          if (this.el.rivalHudState) {
            this.el.rivalHudState.textContent = anyUnlocking
              ? '⚠️ PORTALE!'
              : `${aliveList.length}/${total} VIVI`;
          }
        } else if (this.gameMode === 'duel_online') {
          const remote = [...this.network.remotePlayers.values()][0];
          if (!remote) {
            this.el.rivalHud.classList.remove('portal-alert');
            if (this.el.rivalHudLabel) this.el.rivalHudLabel.textContent = '🟥 1V1';
            if (this.el.rivalHudPages) this.el.rivalHudPages.textContent = '0/5';
            if (this.el.rivalHpFill) this.el.rivalHpFill.style.width = '0%';
            if (this.el.rivalHudState) this.el.rivalHudState.textContent = 'ATTESA...';
          } else {
            const maxHp = Math.max(1, remote.maxHp || CONFIG.PLAYER_MAX_HP);
            const hpPct = Math.max(0, Math.min(100, ((remote.hp ?? maxHp) / maxHp) * 100));
            const atPortal = (remote.pagesCount ?? 0) >= 5 && remote.alive && Math.hypot(remote.x || 0, remote.z || 0) < 3.5;
            this.el.rivalHud.classList.toggle('portal-alert', atPortal);
            if (this.el.rivalHudLabel) this.el.rivalHudLabel.textContent = '🟥 RIVALE';
            if (this.el.rivalHudPages) this.el.rivalHudPages.textContent = `${remote.pagesCount ?? 0}/5`;
            if (this.el.rivalHpFill) this.el.rivalHpFill.style.width = `${hpPct}%`;
            if (this.el.rivalHudState) {
              this.el.rivalHudState.textContent = atPortal
                ? '⚠️ PORTALE!'
                : (remote.alive ? `${Math.ceil(remote.hp ?? maxHp)} HP` : 'RESPAWN');
            }
          }
        }
      }
    }

    if (this.doorModalOpen && this.el.doorHint) {
      this.el.doorHint.textContent = `⚠️ ATTENZIONE: i Guardiani ti attaccano mentre scrivi! • ❤️ ${Math.ceil(this.player.hp)}/${this.player.maxHp} HP • Fogli: ${this.player.collectedPages.length}/5`;
    }

    // 5 slot centrati in alto in font monospace
    const bySlot = new Map(this.player.collectedPages.map((p) => [p.slot, p.symbol]));
    const slotEls = this.el.pageSlots.querySelectorAll('.hud-slot');
    slotEls.forEach((slotEl, i) => {
      const slotNum = i + 1;
      const sym = bySlot.get(slotNum);
      slotEl.textContent = sym || String(slotNum);
      slotEl.classList.toggle('collected', Boolean(sym));
    });
  }

  _loop(now) {
    if (!this.lastTime) this.lastTime = now;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsedSec += dt;

    if (this.maze) {
      this._updateWorldLogic(dt);
      if (this.screenState !== 'LOADING' && this.screenState !== 'MENU') {
        this.renderer.render(this.scene, this.camera);
      }
    }

    requestAnimationFrame((t) => this._loop(t));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.__mazeRoyaleApp = new MazeRoyaleApp();
});
