import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { resolveMazeCollision, findSafeDropPosition } from './collision.js';
import { hasLineOfSight, isIlluminatedWithLoS } from './visibility.js';
import { createXRayMaterial } from './player.js';

/**
 * Pathfinding deterministico BFS su griglia NxN del labirinto.
 * Restituisce un array di tappe [{ gx, gz, x, z }] dalla cella iniziale al target.
 */
export function findMazePath(maze, startGx, startGz, goalGx, goalGz) {
  const N = maze.N;
  const clamp = (v) => Math.max(0, Math.min(N - 1, Math.round(v)));

  const snapWalkable = (gx, gz) => {
    const cx = clamp(gx);
    const cz = clamp(gz);
    if (!maze.isWall(cx, cz)) return { gx: cx, gz: cz };
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx >= 0 && nx < N && nz >= 0 && nz < N && !maze.isWall(nx, nz)) {
        return { gx: nx, gz: nz };
      }
    }
    const fallback = maze.floorCells?.[0];
    return fallback ? { gx: fallback.gx, gz: fallback.gz } : { gx: cx, gz: cz };
  };

  const start = snapWalkable(startGx, startGz);
  const goal = snapWalkable(goalGx, goalGz);

  if (start.gx === goal.gx && start.gz === goal.gz) {
    const w = maze.cellToWorld(goal.gx, goal.gz);
    return [{ gx: goal.gx, gz: goal.gz, x: w.x, z: w.z }];
  }

  const total = N * N;
  const parent = new Int32Array(total).fill(-1);
  const visited = new Uint8Array(total);

  const startIdx = start.gz * N + start.gx;
  const goalIdx = goal.gz * N + goal.gx;

  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIdx;
  visited[startIdx] = 1;

  let found = false;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goalIdx) {
      found = true;
      break;
    }
    const cx = cur % N;
    const cz = (cur - cx) / N;

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx <= 0 || nx >= N - 1 || nz <= 0 || nz >= N - 1) continue;
      if (maze.isWall(nx, nz)) continue;
      const nIdx = nz * N + nx;
      if (visited[nIdx]) continue;
      visited[nIdx] = 1;
      parent[nIdx] = cur;
      queue[tail++] = nIdx;
    }
  }

  if (!found) return [];

  const rev = [];
  let cur = goalIdx;
  while (cur !== -1) {
    const gx = cur % N;
    const gz = (cur - gx) / N;
    const w = maze.cellToWorld(gx, gz);
    rev.push({ gx, gz, x: w.x, z: w.z });
    if (cur === startIdx) break;
    cur = parent[cur];
  }
  rev.reverse();
  if (rev.length > 1) rev.shift();
  return rev;
}

/**
 * Avversario 1v1 Cubo Rosso guidato dall'IA:
 * - Possiede i SUOI 5 segnalini privati (perfettamente sovrapposti agli spawn originali, invisibili al giocatore)
 * - Esplora il labirinto, raccoglie casse, combatte i guardiani e duella contro il giocatore blu
 * - Invisibile nel buio o dietro ai muri (regola ferrea Torcia + LoS)
 */
export class RivalBot {
  constructor(maze, scene) {
    this.id = 'rival-bot';
    this.name = 'Cubo Rosso (BOT)';
    this.maze = maze;

    this.x = maze.spawnB.x;
    this.z = maze.spawnB.z;
    this.rotY = Math.PI;
    this.maxHp = CONFIG.PLAYER_MAX_HP;
    this.hp = CONFIG.PLAYER_MAX_HP;
    this.swordDamage = CONFIG.BASE_SWORD_DAMAGE;
    this.alive = true;
    this.respawnTimer = 0;

    this.shieldActive = false;
    this.shieldTimer = 0;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.dashDirX = 0;
    this.dashDirZ = 1;

    this.attackTimer = 0;
    this.attackCooldown = 0;
    this.hitTargetsInSwing = new Set();

    this.knockVx = 0;
    this.knockVz = 0;
    this.hurtFlash = 0;
    this.stunTimer = 0;
    this.visibleToPlayer = false;

    // 5 segnalini duplicati perfettamente sovrapposti alle coordinate del livello, SOLO lato bot
    this.pages = maze.pageSpawns.map((p) => ({
      originalIndex: p.index,
      slot: p.slot,
      symbol: p.symbol,
      x: p.x,
      z: p.z,
      collected: false
    }));
    this.collectedPages = [];

    // Stato navigazione e combattimento
    this.exploreTargets = this._buildExploreQueue(maze);
    this.visitedCells = new Set();
    this.currentPath = [];
    this.pathRecalcTimer = 0;
    this.searchHintTimer = Math.max(5.5, 9.0 - (maze.level || 1) * 0.6);
    this.stuckTimer = 0;
    this.lastCheckPos = { x: this.x, z: this.z };
    this.unlockingDoorTimer = 0;
    this.alertedDoor = false;
    this.combatMemoryTimer = 0;
    this.lastKnownPlayerPos = null;
    this.strafeSign = Math.random() < 0.5 ? 1 : -1;
    this.strafeFlipTimer = 1.6;

    this._buildMeshes(scene);
  }

  _buildExploreQueue(maze) {
    const queue = [];
    const seen = new Set();
    const pushTarget = (gx, gz) => {
      const k = `${gx},${gz}`;
      if (seen.has(k) || maze.isWall(gx, gz)) return;
      seen.add(k);
      queue.push({ gx, gz, ...maze.cellToWorld(gx, gz) });
    };

    // Ordina le stanze (vicoli ciechi allargati) in modo avido partendo dallo Spawn B
    const remainingRooms = [...(maze.rooms || [])];
    let curX = maze.spawnB.x;
    let curZ = maze.spawnB.z;
    while (remainingRooms.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remainingRooms.length; i++) {
        const w = maze.cellToWorld(remainingRooms[i].gx, remainingRooms[i].gz);
        const d = Math.hypot(w.x - curX, w.z - curZ);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const picked = remainingRooms.splice(bestIdx, 1)[0];
      pushTarget(picked.gx, picked.gz);
      const pw = maze.cellToWorld(picked.gx, picked.gz);
      curX = pw.x;
      curZ = pw.z;
    }

    // Celle distribuite come fallback esplorativo
    for (let i = 0; i < maze.floorCells.length; i += 4) {
      const fc = maze.floorCells[i];
      pushTarget(fc.gx, fc.gz);
    }
    return queue;
  }

  _buildMeshes(scene) {
    this.group = new THREE.Group();
    const s = CONFIG.PLAYER_SIZE;
    const half = s * 0.5;

    // 1. Corpo Cubo Rosso Rivale
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.48,
      metalness: 0.16
    });
    this.bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), this.bodyMat);
    this.bodyMesh.position.y = half;
    this.bodyMesh.renderOrder = 1;
    this.group.add(this.bodyMesh);

    // 2. Visore frontale rosa/corallo (+Z locale) -> ciano quando para con lo Scudo
    this.frontMat = new THREE.MeshBasicMaterial({ color: 0xfca5a5 });
    this.frontFaceMesh = new THREE.Mesh(new THREE.BoxGeometry(s * 0.82, s * 0.68, 0.14), this.frontMat);
    this.frontFaceMesh.position.set(0, half + 0.04, half + 0.03);
    this.frontFaceMesh.renderOrder = 1;
    this.group.add(this.frontFaceMesh);

    // 3. Piastra Scudo frontale
    this.shieldMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.48,
      depthWrite: false
    });
    this.shieldPlate = new THREE.Mesh(new THREE.BoxGeometry(s * 1.16, s * 1.08, 0.12), this.shieldMat);
    this.shieldPlate.position.set(0, half + 0.02, half + 0.24);
    this.shieldPlate.visible = false;
    this.shieldPlate.renderOrder = 12;
    this.group.add(this.shieldPlate);

    // 4. Silhouette X-Ray rossa (solo quando illuminato e in LoS)
    this.xrayMat = createXRayMaterial(0xef4444, 0.55);
    this.xrayMesh = new THREE.Mesh(new THREE.BoxGeometry(s * 1.002, s * 1.002, s * 1.002), this.xrayMat);
    this.xrayMesh.position.y = half;
    this.xrayMesh.renderOrder = 50;
    this.group.add(this.xrayMesh);

    // 5. Fendente Spada davanti (+Z locale)
    this.slashGroup = new THREE.Group();
    this.slashGroup.position.set(0, half + 0.05, CONFIG.ATTACK_OFFSET_Z);
    const bladeGeo = new THREE.RingGeometry(0.45, 1.52, 16, 1, -Math.PI * 0.72, Math.PI * 1.44);
    bladeGeo.rotateX(-Math.PI * 0.5);
    this.slashMat = new THREE.MeshBasicMaterial({
      color: 0xffe4e6,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.slashArcMesh = new THREE.Mesh(bladeGeo, this.slashMat);
    this.slashGroup.add(this.slashArcMesh);

    const slashBarGeo = new THREE.BoxGeometry(2.15, 0.18, 0.42);
    this.slashBarMesh = new THREE.Mesh(slashBarGeo, this.slashMat);
    this.slashBarMesh.position.z = 0.22;
    this.slashGroup.add(this.slashBarMesh);
    this.slashGroup.visible = false;
    this.slashGroup.renderOrder = 20;
    this.group.add(this.slashGroup);

    // 6. Mini barra HP 3D sopra la testa
    this.hpBarBg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.24, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x1e1b2e, side: THREE.DoubleSide })
    );
    this.hpBarBg.position.set(0, s + 0.52, 0);
    this.hpBarBg.rotation.x = -Math.PI * 0.22;
    this.group.add(this.hpBarBg);

    this.hpBarFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.18, 0.13),
      new THREE.MeshBasicMaterial({ color: 0xef4444, side: THREE.DoubleSide })
    );
    this.hpBarFill.position.set(0, s + 0.525, 0.01);
    this.hpBarFill.rotation.x = -Math.PI * 0.22;
    this.group.add(this.hpBarFill);

    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.rotY;
    this.group.visible = false;
    scene.add(this.group);
  }

  _rotateTowards(targetRot, dt, rate = 14) {
    let diff = targetRot - this.rotY;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.rotY += diff * Math.min(1, dt * rate);
  }

  _pickNextObjectiveCell(maze, chests, player) {
    // 1. Se ha tutti e 5 i suoi segnalini -> vai al Portale Centrale (0, 0)
    if (this.collectedPages.length >= 5) {
      return { gx: maze.mid, gz: maze.mid };
    }

    // 2. Segnalino non ancora raccolto direttamente visibile al Bot -> vallo a prendere subito!
    let visibleBestPage = null;
    let visibleBestDist = Infinity;
    for (const bp of this.pages) {
      if (bp.collected) continue;
      const d = Math.hypot(bp.x - this.x, bp.z - this.z);
      if (d <= CONFIG.TORCH_RANGE * 0.88 && hasLineOfSight(maze, this.x, this.z, bp.x, bp.z)) {
        if (d < visibleBestDist) {
          visibleBestDist = d;
          visibleBestPage = bp;
        }
      }
    }
    if (visibleBestPage) {
      return maze.worldToCell(visibleBestPage.x, visibleBestPage.z);
    }

    // 3. Se inseguiva la memoria dell'ultima posizione del giocatore
    if (this.combatMemoryTimer > 0 && this.lastKnownPlayerPos) {
      return maze.worldToCell(this.lastKnownPlayerPos.x, this.lastKnownPlayerPos.z);
    }

    // 4. Cassa loot visibile vicina (solo se utile e non sta finendo i 5 fogli)
    if (this.collectedPages.length < 4 && chests) {
      for (const ch of chests) {
        if (ch.opened) continue;
        const d = Math.hypot(ch.x - this.x, ch.z - this.z);
        if (d <= 9.5 && hasLineOfSight(maze, this.x, this.z, ch.x, ch.z)) {
          return maze.worldToCell(ch.x, ch.z);
        }
      }
    }

    // 5. Hint periodico verso il proprio segnalino piu' vicino se l'esplorazione si protrae
    if (this.searchHintTimer <= 0) {
      let closestPage = null;
      let closestDist = Infinity;
      for (const bp of this.pages) {
        if (bp.collected) continue;
        const d = Math.hypot(bp.x - this.x, bp.z - this.z);
        if (d < closestDist) {
          closestDist = d;
          closestPage = bp;
        }
      }
      if (closestPage) {
        this.searchHintTimer = Math.max(5.0, 8.5 - (maze.level || 1) * 0.5) + Math.random() * 2.5;
        return maze.worldToCell(closestPage.x, closestPage.z);
      }
    }

    // 6. Prossima stanza/cella non ancora visitata nella coda di esplorazione
    while (this.exploreTargets.length > 0) {
      const next = this.exploreTargets[0];
      const key = `${next.gx},${next.gz}`;
      const d = Math.hypot(next.x - this.x, next.z - this.z);
      if (this.visitedCells.has(key) || d < 1.6) {
        this.exploreTargets.shift();
        continue;
      }
      return { gx: next.gx, gz: next.gz };
    }

    // Fallback finale: punta al primo segnalino residuo
    const rem = this.pages.find((p) => !p.collected);
    if (rem) return maze.worldToCell(rem.x, rem.z);
    if (player && player.alive) return maze.worldToCell(player.x, player.z);
    return { gx: maze.mid, gz: maze.mid };
  }

  _startAttack() {
    this.attackTimer = CONFIG.ATTACK_DURATION;
    this.attackCooldown = CONFIG.RIVAL_BOT_ATTACK_COOLDOWN;
    this.hitTargetsInSwing.clear();
  }

  update(dt, maze, player, chests = [], greenBots = [], callbacks = {}) {
    if (!this.alive) {
      this.group.visible = false;
      this.visibleToPlayer = false;
      if (this.respawnTimer > 0) {
        this.respawnTimer -= dt;
        if (this.respawnTimer <= 0) {
          this.x = maze.spawnB.x;
          this.z = maze.spawnB.z;
          this.rotY = Math.PI;
          this.hp = this.maxHp;
          this.alive = true;
          this.respawnTimer = 0;
          this.dashTimer = 0;
          this.attackTimer = 0;
          this.shieldActive = false;
          this.shieldTimer = 0;
          this.knockVx = 0;
          this.knockVz = 0;
          this.stunTimer = 0;
          this.unlockingDoorTimer = 0;
          this.alertedDoor = false;
          this.combatMemoryTimer = 0;
          this.lastKnownPlayerPos = null;
          this.currentPath = [];
          this.group.position.set(this.x, 0, this.z);
          this.group.rotation.y = this.rotY;
          callbacks.onRespawn?.(this);
        }
      }
      return;
    }

    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.attackCooldown > 0) this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (this.stunTimer > 0) this.stunTimer = Math.max(0, this.stunTimer - dt);
    if (this.shieldTimer > 0) this.shieldTimer = Math.max(0, this.shieldTimer - dt);
    if (this.combatMemoryTimer > 0) this.combatMemoryTimer = Math.max(0, this.combatMemoryTimer - dt);
    if (this.searchHintTimer > 0) this.searchHintTimer = Math.max(0, this.searchHintTimer - dt);
    this.pathRecalcTimer = Math.max(0, this.pathRecalcTimer - dt);

    this.strafeFlipTimer -= dt;
    if (this.strafeFlipTimer <= 0) {
      this.strafeSign *= -1;
      this.strafeFlipTimer = 1.4 + Math.random() * 1.4;
    }

    if (this.hurtFlash > 0) {
      this.hurtFlash = Math.max(0, this.hurtFlash - dt);
      this.bodyMat.color.setHex(this.hurtFlash > 0 ? 0xffffff : 0xdc2626);
    } else {
      this.bodyMat.color.setHex(0xdc2626);
    }

    // Marca cella corrente come visitata
    const curCell = maze.worldToCell(this.x, this.z);
    this.visitedCells.add(`${curCell.gx},${curCell.gz}`);

    // Raccolta PRIVATA dei propri 5 segnalini (non tocca quelli del giocatore!)
    for (const bp of this.pages) {
      if (bp.collected) continue;
      if (Math.hypot(bp.x - this.x, bp.z - this.z) < 1.55) {
        bp.collected = true;
        if (!this.collectedPages.some((c) => c.originalIndex === bp.originalIndex)) {
          this.collectedPages.push({
            originalIndex: bp.originalIndex,
            slot: bp.slot,
            symbol: bp.symbol
          });
        }
        this.currentPath = [];
        this.searchHintTimer = Math.max(5.0, 8.5 - (maze.level || 1) * 0.5) + Math.random() * 2.5;
        callbacks.onCollectPage?.(bp, this);
      }
    }

    // Raccolta casse loot vicine
    for (const ch of chests) {
      if (ch.opened) continue;
      if (Math.hypot(ch.x - this.x, ch.z - this.z) < 2.2) {
        const reward = ch.open();
        if (reward) {
          if (reward.type === 'HEAL') {
            this.hp = Math.min(this.maxHp, this.hp + reward.amount);
          } else if (reward.type === 'MAX_HP') {
            this.maxHp += reward.amount;
            this.hp = Math.min(this.maxHp, this.hp + reward.amount);
          } else if (reward.type === 'DAMAGE') {
            this.swordDamage += reward.amount;
          }
          callbacks.onOpenChest?.(ch, reward, this);
        }
      }
    }

    // Rilevamento giocatore blu entro linea di vista
    const distToPlayer = player ? Math.hypot(player.x - this.x, player.z - this.z) : Infinity;
    const canSeePlayer = Boolean(
      player &&
      player.alive &&
      distToPlayer <= 13.5 &&
      hasLineOfSight(maze, this.x, this.z, player.x, player.z)
    );
    if (canSeePlayer) {
      this.combatMemoryTimer = 2.8;
      this.lastKnownPlayerPos = { x: player.x, z: player.z };
    }

    // Eventuale guardiano verde vicino in LoS
    let nearestGuardian = null;
    let nearestGuardianDist = Infinity;
    for (const gb of greenBots) {
      if (!gb.alive) continue;
      const gd = Math.hypot(gb.x - this.x, gb.z - this.z);
      if (gd < 3.2 && gd < nearestGuardianDist && hasLineOfSight(maze, this.x, this.z, gb.x, gb.z)) {
        nearestGuardianDist = gd;
        nearestGuardian = gb;
      }
    }

    let moveVx = 0;
    let moveVz = 0;

    if (this.stunTimer <= 0 && this.dashTimer <= 0) {
      if (canSeePlayer && (this.collectedPages.length < 5 || distToPlayer < 8.5)) {
        // Duello ravvicinato col giocatore blu!
        const dirX = (player.x - this.x) / Math.max(0.001, distToPlayer);
        const dirZ = (player.z - this.z) / Math.max(0.001, distToPlayer);
        this._rotateTowards(Math.atan2(dirX, dirZ), dt, 18);

        if (distToPlayer > 3.2) {
          this.unlockingDoorTimer = 0;
        }

        // Scudo reattivo quando il giocatore sferra un colpo vicino
        if (player.attackTimer > 0 && distToPlayer < 3.4 && this.shieldTimer <= 0 && this.attackTimer <= 0) {
          if (Math.random() < 0.5) {
            this.shieldTimer = 0.42;
          }
        }

        const wantShield = this.shieldTimer > 0 && this.attackTimer <= 0;
        this.shieldActive = wantShield;

        // Attacco spada
        if (!this.shieldActive && distToPlayer <= 2.5 && this.attackCooldown <= 0) {
          this._startAttack();
        } else if (!this.shieldActive && distToPlayer > 4.8 && distToPlayer < 9.5 && this.dashCooldown <= 0 && Math.random() < 0.35) {
          // Dash tattico verso il giocatore (o fuga se ferito con tanti fogli)
          const retreat = this.hp < 32 && this.collectedPages.length >= 3 && distToPlayer < 5.2;
          const sign = retreat ? -1 : 1;
          this.dashTimer = CONFIG.DASH_DURATION;
          this.dashCooldown = CONFIG.DASH_COOLDOWN * 1.15;
          this.dashDirX = dirX * sign;
          this.dashDirZ = dirZ * sign;
          this.rotY = Math.atan2(this.dashDirX, this.dashDirZ);
        } else if (distToPlayer > 1.78) {
          const spd = CONFIG.RIVAL_BOT_SPEED * (this.shieldActive ? CONFIG.SHIELD_SPEED_MULT : 1.0);
          moveVx = dirX * spd;
          moveVz = dirZ * spd;
        } else {
          // Leggero strafe in corpo a corpo
          const perpX = -dirZ * this.strafeSign;
          const perpZ = dirX * this.strafeSign;
          const spd = CONFIG.RIVAL_BOT_SPEED * 0.48;
          moveVx = perpX * spd;
          moveVz = perpZ * spd;
        }
      } else {
        this.shieldActive = this.shieldTimer > 0 && this.attackTimer <= 0;

        // Difesa contro guardiano verde che gli blocca il passo
        if (nearestGuardian && !this.shieldActive && nearestGuardianDist <= 2.4 && this.attackCooldown <= 0) {
          const gdx = nearestGuardian.x - this.x;
          const gdz = nearestGuardian.z - this.z;
          this._rotateTowards(Math.atan2(gdx, gdz), dt, 20);
          this._startAttack();
        }

        // Ha tutti i 5 fogli e si trova al Portale (0, 0) -> Sblocca il codice!
        const distCenter = Math.hypot(this.x, this.z);
        if (this.collectedPages.length >= 5 && distCenter < 2.2) {
          this._rotateTowards(Math.atan2(-this.x, -this.z), dt, 10);
          if (this.unlockingDoorTimer === 0 && !this.alertedDoor) {
            this.alertedDoor = true;
            callbacks.onPortalUnlockStart?.(this);
          } else if (this.unlockingDoorTimer === 0) {
            callbacks.onPortalUnlockStart?.(this);
          }
          this.unlockingDoorTimer += dt;
          if (this.unlockingDoorTimer >= CONFIG.RIVAL_BOT_UNLOCK_SECONDS) {
            this.unlockingDoorTimer = CONFIG.RIVAL_BOT_UNLOCK_SECONDS;
            callbacks.onPortalUnlocked?.(this);
          }
        } else {
          if (this.collectedPages.length < 5) {
            this.unlockingDoorTimer = 0;
            this.alertedDoor = false;
          }

          // Navigazione BFS verso l'obiettivo corrente
          if (this.pathRecalcTimer <= 0 || this.currentPath.length === 0) {
            const goal = this._pickNextObjectiveCell(maze, chests, player);
            this.currentPath = findMazePath(maze, curCell.gx, curCell.gz, goal.gx, goal.gz);
            this.pathRecalcTimer = 0.55;
          }

          while (this.currentPath.length > 0) {
            const wp = this.currentPath[0];
            if (Math.hypot(wp.x - this.x, wp.z - this.z) < 0.72) {
              this.currentPath.shift();
            } else {
              break;
            }
          }

          if (this.currentPath.length > 0) {
            const wp = this.currentPath[0];
            const dx = wp.x - this.x;
            const dz = wp.z - this.z;
            const len = Math.max(0.001, Math.hypot(dx, dz));
            const spd = CONFIG.RIVAL_BOT_SPEED * (this.shieldActive ? CONFIG.SHIELD_SPEED_MULT : 1.0);
            moveVx = (dx / len) * spd;
            moveVz = (dz / len) * spd;
            this._rotateTowards(Math.atan2(moveVx, moveVz), dt, 14);
          }
        }
      }
    }

    // Stato visivo Scudo
    if (this.shieldActive) {
      this.frontMat.color.setHex(0x38bdf8);
      this.shieldPlate.visible = true;
      this.xrayMat.color.setHex(0x38bdf8);
    } else {
      this.frontMat.color.setHex(0xfca5a5);
      this.shieldPlate.visible = false;
      this.xrayMat.color.setHex(0xef4444);
    }

    // Fendente spada attivo e rilevamento colpi verso giocatore & guardiani
    if (this.attackTimer > 0) {
      this.attackTimer = Math.max(0, this.attackTimer - dt);
      const t = 1 - this.attackTimer / CONFIG.ATTACK_DURATION;
      this.slashGroup.visible = true;
      this.slashArcMesh.rotation.y = (t - 0.5) * 1.1;
      this.slashMat.opacity = Math.max(0.1, 1 - t * 0.75);

      const hitX = this.x + Math.sin(this.rotY) * CONFIG.ATTACK_OFFSET_Z;
      const hitZ = this.z + Math.cos(this.rotY) * CONFIG.ATTACK_OFFSET_Z;

      if (
        player &&
        player.alive &&
        !this.hitTargetsInSwing.has('player') &&
        Math.hypot(player.x - hitX, player.z - hitZ) <= CONFIG.ATTACK_RADIUS + CONFIG.PLAYER_RADIUS &&
        hasLineOfSight(maze, this.x, this.z, player.x, player.z)
      ) {
        this.hitTargetsInSwing.add('player');
        callbacks.onAttackPlayer?.(this.swordDamage, this);
      }

      for (const gb of greenBots) {
        if (!gb.alive || this.hitTargetsInSwing.has(gb.id)) continue;
        if (
          Math.hypot(gb.x - hitX, gb.z - hitZ) <= CONFIG.ATTACK_RADIUS + CONFIG.BOT_RADIUS &&
          hasLineOfSight(maze, this.x, this.z, gb.x, gb.z)
        ) {
          this.hitTargetsInSwing.add(gb.id);
          const pdx = gb.x - this.x;
          const pdz = gb.z - this.z;
          const pushX = Math.hypot(pdx, pdz) > 0.01 ? pdx : Math.sin(this.rotY);
          const pushZ = Math.hypot(pdx, pdz) > 0.01 ? pdz : Math.cos(this.rotY);
          gb.takeDamage(this.swordDamage, pushX, pushZ);
        }
      }
    } else {
      this.slashGroup.visible = false;
    }

    // Spostamento + Dash + Rinculo + Collisione muri
    let targetX = this.x;
    let targetZ = this.z;
    if (this.dashTimer > 0) {
      this.dashTimer = Math.max(0, this.dashTimer - dt);
      targetX += this.dashDirX * CONFIG.RIVAL_BOT_DASH_SPEED * dt;
      targetZ += this.dashDirZ * CONFIG.RIVAL_BOT_DASH_SPEED * dt;
    } else {
      targetX += moveVx * dt;
      targetZ += moveVz * dt;
    }
    targetX += this.knockVx * dt;
    targetZ += this.knockVz * dt;

    const resolved = resolveMazeCollision(maze, this.x, this.z, targetX, targetZ, CONFIG.PLAYER_RADIUS);
    this.x = resolved.x;
    this.z = resolved.z;

    // Decadimento rinculo
    if (Math.abs(this.knockVx) > 0.05 || Math.abs(this.knockVz) > 0.05) {
      const damp = Math.exp(-CONFIG.PLAYER_KNOCKBACK_FRICTION * dt);
      this.knockVx *= damp;
      this.knockVz *= damp;
    } else {
      this.knockVx = 0;
      this.knockVz = 0;
    }

    // Protezione anti-blocco durante la navigazione
    if (!canSeePlayer && this.unlockingDoorTimer === 0 && Math.hypot(moveVx, moveVz) > 0.5) {
      this.stuckTimer += dt;
      if (this.stuckTimer >= 0.65) {
        const moved = Math.hypot(this.x - this.lastCheckPos.x, this.z - this.lastCheckPos.z);
        this.lastCheckPos = { x: this.x, z: this.z };
        this.stuckTimer = 0;
        if (moved < 0.22) {
          this.currentPath = [];
          this.pathRecalcTimer = 0;
          const cellCenter = maze.cellToWorld(curCell.gx, curCell.gz);
          const nudged = resolveMazeCollision(
            maze,
            this.x,
            this.z,
            this.x + (cellCenter.x - this.x) * 0.5,
            this.z + (cellCenter.z - this.z) * 0.5,
            CONFIG.PLAYER_RADIUS
          );
          this.x = nudged.x;
          this.z = nudged.z;
        }
      }
    } else {
      this.stuckTimer = 0;
      this.lastCheckPos = { x: this.x, z: this.z };
    }

    // Regola ferrea di visibilita': illuminato dalla torcia del giocatore + Line of Sight diretta
    this.visibleToPlayer = Boolean(
      player &&
      player.alive &&
      isIlluminatedWithLoS(maze, player.x, player.z, this.x, this.z, CONFIG.TORCH_RANGE)
    );
    this.group.visible = this.visibleToPlayer;
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.rotY;

    const hpPct = Math.max(0.02, this.hp / this.maxHp);
    this.hpBarFill.scale.x = hpPct;
    this.hpBarFill.position.x = -(1 - hpPct) * 0.59;
  }

  takeDamage(amount, pushDirX = 0, pushDirZ = 0, maze = this.maze) {
    if (!this.alive) return { blocked: false, died: false };
    if (this.shieldActive) {
      return { blocked: true, died: false };
    }

    this.hp = Math.max(0, this.hp - amount);
    this.hurtFlash = 0.14;
    this.stunTimer = 0.14;
    this.unlockingDoorTimer = 0; // Interrompe lo sblocco del portale!

    const pLen = Math.hypot(pushDirX, pushDirZ);
    if (pLen > 1e-4) {
      this.knockVx = (pushDirX / pLen) * CONFIG.PLAYER_KNOCKBACK_SPEED;
      this.knockVz = (pushDirZ / pLen) * CONFIG.PLAYER_KNOCKBACK_SPEED;
    }

    if (this.hp <= 0) {
      this.alive = false;
      this.respawnTimer = CONFIG.RESPAWN_SECONDS;
      this.shieldActive = false;
      this.shieldTimer = 0;
      this.slashGroup.visible = false;
      this.group.visible = false;
      this.knockVx = 0;
      this.knockVz = 0;

      // Droppa i SUOI segnalini solo nei dati privati del bot (zero mesh sullo schermo del giocatore)
      const count = this.collectedPages.length;
      for (let i = 0; i < count; i++) {
        const held = this.collectedPages[i];
        const bp = this.pages.find((p) => p.originalIndex === held.originalIndex);
        if (!bp) continue;
        const angle = (Math.PI * 2 * i) / Math.max(1, count);
        const dropPos = findSafeDropPosition(maze, this.x, this.z, count > 1 ? 1.15 : 0.35, angle);
        bp.x = dropPos.x;
        bp.z = dropPos.z;
        bp.collected = false;
      }
      this.collectedPages = [];
      this.currentPath = [];
      return { blocked: false, died: true };
    }

    return { blocked: false, died: false };
  }
}
