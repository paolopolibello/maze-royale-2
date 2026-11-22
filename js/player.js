import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { resolveMazeCollision, findSafeDropPosition } from './collision.js';
import { audio } from './audio.js';

/**
 * Calcola la hitbox del fendente spada esattamente DAVANTI al giocatore (+Z locale).
 */
export function getForwardAttackCenter(x, z, rotY, offset = CONFIG.ATTACK_OFFSET_Z) {
  return {
    x: x + Math.sin(rotY) * offset,
    z: z + Math.cos(rotY) * offset
  };
}

/**
 * Crea un materiale X-Ray semitrasparente che buca i muri (GreaterDepth + fog:false).
 */
export function createXRayMaterial(colorHex, opacity = 0.48) {
  return new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
    fog: false
  });
}

export class PlayerCube {
  constructor(id, name = 'TU', colorHex = 0x2563eb) {
    this.id = id;
    this.name = name;
    this.x = 0;
    this.z = 0;
    this.rotY = 0;
    this.spawn = { x: 0, z: 0 };

    this.maxHp = CONFIG.PLAYER_MAX_HP;
    this.hp = CONFIG.PLAYER_MAX_HP;
    this.swordDamage = CONFIG.BASE_SWORD_DAMAGE;
    this.alive = true;
    this.respawnTimer = 0;
    this.knockVx = 0;
    this.knockVz = 0;

    this.shieldActive = false;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.dashDirX = 0;
    this.dashDirZ = 1;

    this.attackTimer = 0;
    this.attackCooldown = 0;
    this.hitTargetsInSwing = new Set();

    // Fogli raccolti: array di { slot, symbol, originalIndex }
    this.collectedPages = [];

    this._buildMeshes(colorHex);
  }

  _buildMeshes(bodyColor) {
    this.group = new THREE.Group();
    const s = CONFIG.PLAYER_SIZE;
    const half = s * 0.5;

    // 1. Corpo cubo principale (renderOrder = 1 opaco)
    const bodyGeo = new THREE.BoxGeometry(s, s, s);
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: bodyColor,
      roughness: 0.52,
      metalness: 0.18
    });
    this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
    this.bodyMesh.position.y = half;
    this.bodyMesh.renderOrder = 1;
    this.group.add(this.bodyMesh);

    // 2. Faccia frontale (+Z locale!): blu ghiaccio di base, blu ciano brillante quando lo Scudo e' tenuto premuto
    const frontGeo = new THREE.BoxGeometry(s * 0.82, s * 0.68, 0.14);
    this.frontMat = new THREE.MeshBasicMaterial({
      color: 0xbfdbfe
    });
    this.frontFaceMesh = new THREE.Mesh(frontGeo, this.frontMat);
    this.frontFaceMesh.position.set(0, half + 0.04, half + 0.03);
    this.frontFaceMesh.renderOrder = 1;
    this.group.add(this.frontFaceMesh);

    // 3. Piastra Scudo Energetico frontale (+Z locale)
    const shieldGeo = new THREE.BoxGeometry(s * 1.16, s * 1.08, 0.12);
    this.shieldMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.45,
      depthWrite: false
    });
    this.shieldPlate = new THREE.Mesh(shieldGeo, this.shieldMat);
    this.shieldPlate.position.set(0, half + 0.02, half + 0.24);
    this.shieldPlate.visible = false;
    this.shieldPlate.renderOrder = 12;
    this.group.add(this.shieldPlate);

    // 4. Silhouette X-Ray che "buca" i muri (renderOrder = 50 dopo tutti i muri opachi)
    const xrayGeo = new THREE.BoxGeometry(s * 1.002, s * 1.002, s * 1.002);
    this.xrayMat = createXRayMaterial(0x60a5fa, 0.55);
    this.xrayMesh = new THREE.Mesh(xrayGeo, this.xrayMat);
    this.xrayMesh.position.y = half;
    this.xrayMesh.renderOrder = 50;
    this.group.add(this.xrayMesh);

    // 5. Fendente Spada bianco RIGOROSAMENTE davanti (+Z locale)
    this.slashGroup = new THREE.Group();
    this.slashGroup.position.set(0, half + 0.05, CONFIG.ATTACK_OFFSET_Z);

    const bladeGeo = new THREE.RingGeometry(0.45, 1.52, 16, 1, -Math.PI * 0.72, Math.PI * 1.44);
    bladeGeo.rotateX(-Math.PI * 0.5);
    this.slashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.slashArcMesh = new THREE.Mesh(bladeGeo, this.slashMat);
    this.slashGroup.add(this.slashArcMesh);

    // Barra bianca netta di taglio frontale
    const slashBarGeo = new THREE.BoxGeometry(2.15, 0.18, 0.42);
    this.slashBarMesh = new THREE.Mesh(slashBarGeo, this.slashMat);
    this.slashBarMesh.position.z = 0.22;
    this.slashGroup.add(this.slashBarMesh);

    this.slashGroup.visible = false;
    this.slashGroup.renderOrder = 20;
    this.group.add(this.slashGroup);

    // 6. Torcia PointLight con ombre reali (sotto WALL_HEIGHT=3.6 così i muri bloccano fisicamente la luce!)
    this.torchLight = new THREE.PointLight(
      0xffbe73,
      CONFIG.TORCH_INTENSITY,
      CONFIG.TORCH_RANGE,
      CONFIG.TORCH_DECAY
    );
    this.torchLight.position.set(0, 2.2, 0);
    this.torchLight.castShadow = true;
    this.torchLight.shadow.mapSize.set(1024, 1024);
    this.torchLight.shadow.camera.near = 0.25;
    this.torchLight.shadow.camera.far = CONFIG.TORCH_RANGE;
    this.torchLight.shadow.bias = -0.001;
    this.torchLight.shadow.normalBias = 0.05;
    this.group.add(this.torchLight);
  }

  resetToFreshRun(spawnX, spawnZ) {
    this.maxHp = CONFIG.PLAYER_MAX_HP;
    this.swordDamage = CONFIG.BASE_SWORD_DAMAGE;
    this.collectedPages = [];
    this.dashCooldown = 0;
    this.attackCooldown = 0;
    this.spawnAt(spawnX, spawnZ, 0);
  }

  spawnAt(x, z, rotY = 0) {
    this.spawn = { x, z };
    this.x = x;
    this.z = z;
    this.rotY = rotY;
    this.hp = this.maxHp;
    this.alive = true;
    this.respawnTimer = 0;
    this.dashTimer = 0;
    this.attackTimer = 0;
    this.knockVx = 0;
    this.knockVz = 0;
    this.shieldActive = false;
    this.group.visible = true;
    this.syncTransform();
  }

  applyKnockback(pushDirX, pushDirZ, speed = CONFIG.PLAYER_KNOCKBACK_SPEED) {
    const pLen = Math.hypot(pushDirX, pushDirZ);
    if (pLen > 1e-4) {
      this.knockVx = (pushDirX / pLen) * speed;
      this.knockVz = (pushDirZ / pLen) * speed;
    }
  }

  syncTransform() {
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.rotY;
  }

  update(dt, maze, input, events = {}) {
    if (!this.alive) {
      if (this.respawnTimer > 0) {
        this.respawnTimer -= dt;
        if (this.respawnTimer <= 0) {
          this.spawnAt(this.spawn.x, this.spawn.z, 0);
          if (typeof events.onRespawn === 'function') {
            events.onRespawn();
          }
        }
      }
      return null;
    }

    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.attackCooldown > 0) this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    // Rotazione Twin-Stick: se usa lo stick destro (aimX/aimZ) mira indipendentemente, altrimenti segue il movimento
    const moveMag = Math.hypot(input.moveX, input.moveZ);
    const aimMag = Math.hypot(input.aimX || 0, input.aimZ || 0);
    if (this.dashTimer <= 0 && (aimMag > 0.2 || moveMag > 0.08)) {
      const targetRot = aimMag > 0.2
        ? Math.atan2(input.aimX, input.aimZ)
        : Math.atan2(input.moveX, input.moveZ);
      let diff = targetRot - this.rotY;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.rotY += diff * Math.min(1, dt * 18);
    }

    // Scudo frontale (hold)
    this.shieldActive = Boolean(input.shieldHeld) && this.dashTimer <= 0;
    if (this.shieldActive) {
      this.frontMat.color.setHex(0x38bdf8);
      this.shieldPlate.visible = true;
      this.xrayMat.color.setHex(0x38bdf8);
    } else {
      this.frontMat.color.setHex(0xbfdbfe);
      this.shieldPlate.visible = false;
      this.xrayMat.color.setHex(0x60a5fa);
    }

    // Scatto / Dash in avanti lungo `rotY`
    if (input.dashPressed && this.dashCooldown <= 0 && this.dashTimer <= 0) {
      this.dashTimer = CONFIG.DASH_DURATION;
      this.dashCooldown = CONFIG.DASH_COOLDOWN;
      this.dashDirX = Math.sin(this.rotY);
      this.dashDirZ = Math.cos(this.rotY);
      audio.playDash();
    }

    // Attacco spada davanti (+Z locale)
    let activeHitbox = null;
    if (input.attackPressed && this.attackCooldown <= 0 && !this.shieldActive) {
      this.attackTimer = CONFIG.ATTACK_DURATION;
      this.attackCooldown = CONFIG.ATTACK_COOLDOWN;
      this.hitTargetsInSwing.clear();
      audio.playSlash();
    }

    if (this.attackTimer > 0) {
      this.attackTimer = Math.max(0, this.attackTimer - dt);
      const t = 1 - this.attackTimer / CONFIG.ATTACK_DURATION;
      this.slashGroup.visible = true;
      this.slashArcMesh.rotation.y = (t - 0.5) * 1.1;
      this.slashMat.opacity = Math.max(0.1, 1 - t * 0.75);
      activeHitbox = {
        ...getForwardAttackCenter(this.x, this.z, this.rotY),
        radius: CONFIG.ATTACK_RADIUS,
        damage: this.swordDamage,
        hitTargets: this.hitTargetsInSwing
      };
    } else {
      this.slashGroup.visible = false;
    }

    // Calcolo spostamento, rinculo e risoluzione rigorosa Circle-vs-AABB
    let targetX = this.x;
    let targetZ = this.z;

    if (this.dashTimer > 0) {
      this.dashTimer = Math.max(0, this.dashTimer - dt);
      targetX += this.dashDirX * CONFIG.DASH_SPEED * dt;
      targetZ += this.dashDirZ * CONFIG.DASH_SPEED * dt;
    } else if (moveMag > 0.08) {
      const speed = CONFIG.PLAYER_SPEED * (this.shieldActive ? CONFIG.SHIELD_SPEED_MULT : 1.0);
      const clampedMag = Math.min(1, moveMag);
      targetX += (input.moveX / moveMag) * clampedMag * speed * dt;
      targetZ += (input.moveZ / moveMag) * clampedMag * speed * dt;
    }

    targetX += this.knockVx * dt;
    targetZ += this.knockVz * dt;

    const resolved = resolveMazeCollision(maze, this.x, this.z, targetX, targetZ, CONFIG.PLAYER_RADIUS);
    this.x = resolved.x;
    this.z = resolved.z;

    if (Math.abs(this.knockVx) > 0.05 || Math.abs(this.knockVz) > 0.05) {
      const damp = Math.exp(-CONFIG.PLAYER_KNOCKBACK_FRICTION * dt);
      this.knockVx *= damp;
      this.knockVz *= damp;
    } else {
      this.knockVx = 0;
      this.knockVz = 0;
    }

    this.syncTransform();

    return activeHitbox;
  }

  takeDamage(amount, maze, onKilledDropPages, autoRespawn = false) {
    if (!this.alive) return { blocked: false, died: false };
    if (this.shieldActive) {
      audio.playShieldBlock();
      return { blocked: true, died: false };
    }

    this.hp = Math.max(0, this.hp - amount);
    audio.playHit();

    if (this.hp <= 0) {
      this.alive = false;
      this.respawnTimer = autoRespawn ? CONFIG.RESPAWN_SECONDS : -1;
      this.shieldActive = false;
      this.knockVx = 0;
      this.knockVz = 0;
      this.slashGroup.visible = false;
      this.group.visible = false;
      audio.playDeath();

      // Droppa tutti i fogli raccolti in punti sicuri vicini al luogo della morte
      const dropped = [];
      const count = this.collectedPages.length;
      for (let i = 0; i < count; i++) {
        const p = this.collectedPages[i];
        const angle = (Math.PI * 2 * i) / Math.max(1, count);
        const dropPos = findSafeDropPosition(maze, this.x, this.z, count > 1 ? 1.15 : 0.35, angle);
        dropped.push({ ...p, x: dropPos.x, z: dropPos.z });
      }
      this.collectedPages = [];
      if (typeof onKilledDropPages === 'function') {
        onKilledDropPages(dropped);
      }
      return { blocked: false, died: true, dropped };
    }

    return { blocked: false, died: false };
  }
}
