import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { createPageTexture, createChestTexture, createDoorTexture } from './textures.js';
import { resolveMazeCollision } from './collision.js';
import { isIlluminatedWithLoS } from './visibility.js';
import { createXRayMaterial } from './player.js';

/**
 * Fogli collezionabili sparsi nei vicoli ciechi/stanze e droppabili in caso di morte.
 */
export class WorldPage {
  constructor(data, scene) {
    this.originalIndex = data.index;
    this.slot = data.slot;
    this.symbol = data.symbol;
    this.x = data.x;
    this.z = data.z;
    this.collected = false;
    this.bobPhase = Math.random() * Math.PI * 2;

    const tex = createPageTexture(this.symbol, this.slot);
    const geo = new THREE.PlaneGeometry(1.25, 1.45);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.45,
      metalness: 0.05,
      side: THREE.DoubleSide
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.rotation.x = -Math.PI * 0.28;
    this.mesh.position.set(this.x, 0.85, this.z);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  setWorldPosition(x, z) {
    this.x = x;
    this.z = z;
    this.collected = false;
    this.mesh.position.set(x, 0.85, z);
  }

  update(dt, timeSec, maze = null, player = null) {
    if (this.collected) {
      this.mesh.visible = false;
      return;
    }
    if (maze && player) {
      this.mesh.visible = player.alive && isIlluminatedWithLoS(maze, player.x, player.z, this.x, this.z, CONFIG.TORCH_RANGE);
    } else {
      this.mesh.visible = true;
    }
    if (!this.mesh.visible) return;
    this.mesh.position.y = 0.82 + Math.sin(timeSec * 3.1 + this.bobPhase) * 0.14;
    this.mesh.rotation.y += dt * 1.45;
  }
}

/**
 * Casse loot anti-camper apribili col tasto Interagisci (raggio < 3).
 */
export class LootChest {
  constructor(data, scene, chestTex = createChestTexture()) {
    this.id = data.id;
    this.x = data.x;
    this.z = data.z;
    this.opened = false;

    this.group = new THREE.Group();
    this.group.position.set(this.x, 0, this.z);

    const baseGeo = new THREE.BoxGeometry(1.25, 0.62, 0.92);
    const mat = new THREE.MeshStandardMaterial({ map: chestTex, roughness: 0.65 });
    const base = new THREE.Mesh(baseGeo, mat);
    base.position.y = 0.31;
    base.receiveShadow = true;
    this.group.add(base);

    const lidGeo = new THREE.BoxGeometry(1.28, 0.26, 0.95);
    this.lid = new THREE.Mesh(lidGeo, mat);
    this.lid.position.set(0, 0.74, 0);
    this.lid.receiveShadow = true;
    this.group.add(this.lid);

    this.group.visible = false;
    scene.add(this.group);
  }

  updateVisibility(maze, player) {
    if (!maze || !player) return;
    this.group.visible = player.alive && isIlluminatedWithLoS(maze, player.x, player.z, this.x, this.z, CONFIG.TORCH_RANGE);
  }

  open() {
    if (this.opened) return null;
    this.opened = true;
    this.lid.position.set(0, 0.95, -0.34);
    this.lid.rotation.x = -0.95;

    const roll = Math.random();
    if (roll < 0.38) {
      return { type: 'HEAL', amount: 38, text: '+38 HP Recuperati!' };
    }
    if (roll < 0.70) {
      return { type: 'MAX_HP', amount: 20, text: '+20 Max HP Permanenti!' };
    }
    return { type: 'DAMAGE', amount: 8, text: '+8 Danni Spada!' };
  }
}

/**
 * Porta / Altare Finale al centro esatto (0, 0).
 */
export class CenterDoor {
  constructor(scene) {
    this.x = 0;
    this.z = 0;
    this.group = new THREE.Group();

    const tex = createDoorTexture();
    const archMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 });
    const pillarGeo = new THREE.BoxGeometry(0.65, 2.8, 0.65);

    const leftP = new THREE.Mesh(pillarGeo, archMat);
    leftP.position.set(-1.15, 1.4, 0);
    this.group.add(leftP);

    const rightP = new THREE.Mesh(pillarGeo, archMat);
    rightP.position.set(1.15, 1.4, 0);
    this.group.add(rightP);

    const lintelGeo = new THREE.BoxGeometry(3.1, 0.7, 0.85);
    const lintel = new THREE.Mesh(lintelGeo, archMat);
    lintel.position.set(0, 3.05, 0);
    this.group.add(lintel);

    const portalGeo = new THREE.BoxGeometry(1.68, 2.55, 0.25);
    const portalMat = new THREE.MeshStandardMaterial({
      color: 0x6d28d9,
      roughness: 0.35
    });
    const portal = new THREE.Mesh(portalGeo, portalMat);
    portal.position.set(0, 1.3, 0);
    portal.receiveShadow = true;
    leftP.receiveShadow = true;
    rightP.receiveShadow = true;
    lintel.receiveShadow = true;
    this.group.add(portal);

    scene.add(this.group);
  }
}

/**
 * Bot nemici cubi verdi lenti (40 HP).
 * REGOLA CRITICA: visibili e attivi SOLO se toccati dalla torcia del giocatore E c'e' linea di vista diretta!
 * Nel buio o dietro i muri -> visible = false (nessun alone o sagoma).
 */
export class EnemyBot {
  constructor(data, scene) {
    this.id = data.id;
    this.x = data.x;
    this.z = data.z;
    this.rotY = Math.random() * Math.PI * 2;
    this.hp = CONFIG.BOT_MAX_HP;
    this.maxHp = CONFIG.BOT_MAX_HP;
    this.alive = true;
    this.aware = false;
    this.visibleToPlayer = false;
    this.attackCooldown = 0;
    this.hurtFlash = 0;
    this.knockVx = 0;
    this.knockVz = 0;
    this.stunTimer = 0;
    this.patrolAngle = Math.random() * Math.PI * 2;
    this.patrolTimer = 1 + Math.random() * 2;

    this.group = new THREE.Group();
    const s = CONFIG.BOT_SIZE;
    const half = s * 0.5;

    // ZERO emissive permanente per impedire aloni verdi nel buio profondo!
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x22c55e,
      roughness: 0.62,
      metalness: 0.08
    });
    this.bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), this.bodyMat);
    this.bodyMesh.position.y = half;
    this.bodyMesh.renderOrder = 1;
    this.group.add(this.bodyMesh);

    const faceMat = new THREE.MeshStandardMaterial({ color: 0xa3e635, roughness: 0.5 });
    const face = new THREE.Mesh(new THREE.BoxGeometry(s * 0.68, s * 0.38, 0.12), faceMat);
    face.position.set(0, half + 0.16, half + 0.02);
    face.renderOrder = 1;
    this.group.add(face);

    // Silhouette X-Ray (visibile SOLO quando group.visible === true, cioe' illuminato e in LoS!)
    this.xrayMat = createXRayMaterial(0x22c55e, 0.48);
    this.xrayMesh = new THREE.Mesh(new THREE.BoxGeometry(s * 1.002, s * 1.002, s * 1.002), this.xrayMat);
    this.xrayMesh.position.y = half;
    this.xrayMesh.renderOrder = 50;
    this.group.add(this.xrayMesh);

    // Mini barra vita 3D (dentro group -> sparisce automaticamente nel buio con visible=false)
    this.hpBarFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.14),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, side: THREE.DoubleSide })
    );
    this.hpBarFill.position.set(0, s + 0.45, 0);
    this.hpBarFill.rotation.x = -Math.PI * 0.22;
    this.group.add(this.hpBarFill);

    // Di default nel buio assoluto parte invisibile!
    this.group.visible = false;
    scene.add(this.group);
  }

  update(dt, maze, player, onAttackPlayer, rivalTarget = null, onAttackRival = null) {
    if (!this.alive) {
      this.group.visible = false;
      this.visibleToPlayer = false;
      return;
    }

    if (this.attackCooldown > 0) this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (this.stunTimer > 0) this.stunTimer = Math.max(0, this.stunTimer - dt);
    if (this.hurtFlash > 0) {
      this.hurtFlash = Math.max(0, this.hurtFlash - dt);
      this.bodyMat.color.setHex(this.hurtFlash > 0 ? 0xfca5a5 : 0x22c55e);
    }

    // Regola ferrea di visibilita': illuminato dalla torcia del giocatore + Line of Sight senza muri!
    const playerLit = player.alive && isIlluminatedWithLoS(maze, player.x, player.z, this.x, this.z, CONFIG.TORCH_RANGE);
    this.visibleToPlayer = playerLit;
    this.group.visible = playerLit;

    const rivalLit = Boolean(
      rivalTarget &&
      rivalTarget.alive &&
      isIlluminatedWithLoS(maze, rivalTarget.x, rivalTarget.z, this.x, this.z, CONFIG.TORCH_RANGE * 0.78)
    );

    const dPlayer = playerLit ? Math.hypot(player.x - this.x, player.z - this.z) : Infinity;
    const dRival = rivalLit ? Math.hypot(rivalTarget.x - this.x, rivalTarget.z - this.z) : Infinity;

    let chaseTarget = null;
    let chaseAttackCb = null;
    if (playerLit && rivalLit) {
      if (dPlayer <= dRival) {
        chaseTarget = player;
        chaseAttackCb = onAttackPlayer;
      } else {
        chaseTarget = rivalTarget;
        chaseAttackCb = onAttackRival;
      }
    } else if (playerLit) {
      chaseTarget = player;
      chaseAttackCb = onAttackPlayer;
    } else if (rivalLit) {
      chaseTarget = rivalTarget;
      chaseAttackCb = onAttackRival;
    }

    this.aware = Boolean(chaseTarget);

    let vx = 0;
    let vz = 0;
    const dist = chaseTarget ? Math.hypot(chaseTarget.x - this.x, chaseTarget.z - this.z) : Infinity;

    if (this.stunTimer <= 0) {
      if (this.aware && chaseTarget && dist > 1.25) {
        vx = ((chaseTarget.x - this.x) / dist) * CONFIG.BOT_SPEED;
        vz = ((chaseTarget.z - this.z) / dist) * CONFIG.BOT_SPEED;
        this.rotY = Math.atan2(vx, vz);
      } else if (!this.aware) {
        // Lento pattugliamento cieco nei corridoi (non conosce la posizione dei giocatori nel buio!)
        this.patrolTimer -= dt;
        if (this.patrolTimer <= 0) {
          this.patrolAngle += (Math.random() - 0.5) * 2.4;
          this.patrolTimer = 1.8 + Math.random() * 2.2;
        }
        vx = Math.cos(this.patrolAngle) * 0.42 * CONFIG.BOT_SPEED;
        vz = Math.sin(this.patrolAngle) * 0.42 * CONFIG.BOT_SPEED;
        this.rotY = Math.atan2(vx, vz);
      }
    }

    const totalVx = vx + this.knockVx;
    const totalVz = vz + this.knockVz;

    if (Math.hypot(totalVx, totalVz) > 0.01) {
      const next = resolveMazeCollision(
        maze,
        this.x,
        this.z,
        this.x + totalVx * dt,
        this.z + totalVz * dt,
        CONFIG.BOT_RADIUS
      );
      if (Math.hypot(next.x - this.x, next.z - this.z) < 0.004 && !this.aware && this.stunTimer <= 0) {
        this.patrolAngle += Math.PI * 0.75;
      }
      this.x = next.x;
      this.z = next.z;
    }

    // Decadimento esponenziale del rinculo
    if (Math.abs(this.knockVx) > 0.05 || Math.abs(this.knockVz) > 0.05) {
      const damp = Math.exp(-CONFIG.BOT_KNOCKBACK_FRICTION * dt);
      this.knockVx *= damp;
      this.knockVz *= damp;
    } else {
      this.knockVx = 0;
      this.knockVz = 0;
    }

    if (this.aware && chaseTarget && this.stunTimer <= 0 && dist <= 1.85 && this.attackCooldown <= 0) {
      this.attackCooldown = CONFIG.BOT_ATTACK_COOLDOWN;
      if (typeof chaseAttackCb === 'function') {
        chaseAttackCb(CONFIG.BOT_DAMAGE, this);
      }
    }

    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.rotY;

    const hpPct = Math.max(0.05, this.hp / this.maxHp);
    this.hpBarFill.scale.x = hpPct;
    this.hpBarFill.position.x = -(1 - hpPct) * 0.55;
  }

  takeDamage(amount, pushDirX = 0, pushDirZ = 0) {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.hurtFlash = 0.14;
    const pLen = Math.hypot(pushDirX, pushDirZ);
    if (pLen > 1e-4) {
      this.knockVx = (pushDirX / pLen) * CONFIG.BOT_KNOCKBACK_SPEED;
      this.knockVz = (pushDirZ / pLen) * CONFIG.BOT_KNOCKBACK_SPEED;
    }
    this.stunTimer = CONFIG.BOT_STUN_TIME;
    if (this.hp <= 0) {
      this.alive = false;
      this.group.visible = false;
      return true;
    }
    return false;
  }
}
