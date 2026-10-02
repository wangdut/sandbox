// 成员系统：4 名虚拟成员的生命周期管理
//
// 职责：
//   1. 阵亡后定时在己方指挥所重生（否则一方减员后局面不可逆）
//   2. 缓慢回血（无医疗建筑时的保底恢复，让「撤退保存实力」有意义）
//   3. 武器切换（机枪 ↔ 火箭筒）
// M2 的 AgentManager 会基于本系统提供的注册表下发决策。

import { FPS } from '../constants.js';
import { MEMBERS, DEFAULT_WEAPON, WEAPONS, applyWeapon } from './memberDefs.js';
import { findHQ, findRespawnSpot } from './scenario.js';

export const RESPAWN_SEC = 30;      // 阵亡后重生等待（秒）
export const REGEN_INTERVAL = 120;  // 每 2 秒回 1 次血
export const REGEN_AMOUNT = 3;      // 每次回复量（≈1.5 点/秒，让「撤退重整」有实际收益）

export class MemberSystem {
  constructor() {
    // 槽位：每个成员一条，与实体解耦（实体死了这里仍然记得它）
    this.slots = [];
    this.frameCount = 0;
  }

  init(gameState) {
    this.slots = MEMBERS.map(function (spec) {
      return { spec: spec, entity: null, missingSince: -1, respawnCount: 0 };
    });
    // 名为 init 实则先做一次对账，把场景里已生成的成员认领进槽位
    this._reconcile(gameState);
  }

  /** 把场景中已存在的成员实体认领进对应槽位 */
  _reconcile(gameState) {
    const self = this;
    this.slots.forEach(function (slot) {
      if (slot.entity && !slot.entity.dead) return;
      for (let i = 0; i < gameState.entities.length; i++) {
        const e = gameState.entities[i];
        if (e.isMember && e.memberKey === slot.spec.key && !e.dead) {
          slot.entity = e;
          slot.missingSince = -1;
          return;
        }
      }
      if (!slot.entity) self._markMissing(slot);
    });
  }

  _markMissing(slot) {
    if (slot.missingSince < 0) slot.missingSince = this.frameCount;
  }

  update(gameState, frameCount) {
    this.frameCount = frameCount;
    const self = this;
    this.slots.forEach(function (slot) {
      const e = slot.entity;
      const alive = e && !e.dead;
      if (alive) {
        slot.missingSince = -1;
        // 缓慢回血：让「撤退重整」成为有效战术
        if (e.hp < e.maxHp && frameCount % REGEN_INTERVAL === 0) {
          e.hp = Math.min(e.maxHp, e.hp + REGEN_AMOUNT);
        }
        return;
      }
      // 实体已阵亡（或从未生成）：进入重生倒计时
      if (slot.missingSince < 0) slot.missingSince = frameCount;
      slot.entity = null;
      if (frameCount - slot.missingSince < RESPAWN_SEC * FPS) return;
      self._respawn(gameState, slot);
    });
  }

  _respawn(gameState, slot) {
    const hq = findHQ(gameState, slot.spec.team);
    if (!hq) return; // 指挥所没了就无从重生（此时通常已判负）
    const spot = findRespawnSpot(gameState, hq);
    const e = gameState.spawnEntity('member', slot.spec.team, spot.x, spot.y);
    e.faction = slot.spec.faction;
    e.isMember = true;
    e.avoidDanger = true;
    e.memberKey = slot.spec.key;
    e.memberName = slot.spec.name;
    e.name = slot.spec.name;
    applyWeapon(e, slot.spec.weapon || DEFAULT_WEAPON);
    slot.entity = e;
    slot.missingSince = -1;
    slot.respawnCount++;
    gameState.addFloatingText(e.getCenterX(), e.getCenterY() - 14, slot.spec.name + ' 归队', '#f1c40f');
  }

  /** 活着的成员（可用于 UI / AI 快照） */
  liveMembers(gameState) {
    return gameState.entities.filter(function (e) { return e.isMember && !e.dead; });
  }

  /** 某方的成员槽位状态，供面板显示 */
  slotStatus() {
    const fc = this.frameCount;
    const total = RESPAWN_SEC * FPS;
    return this.slots.map(function (slot) {
      const alive = !!(slot.entity && !slot.entity.dead);
      // 阵亡当帧 missingSince 还是 -1（成员系统尚未跑到），此时按「满倒计时」显示，
      // 否则面板会先闪一下 0s 再跳到 30s
      const since = slot.missingSince < 0 ? fc : slot.missingSince;
      const leftFrames = alive ? 0 : Math.max(0, total - (fc - since));
      return {
        spec: slot.spec,
        entity: alive ? slot.entity : null,
        alive: alive,
        respawnLeftSec: Math.ceil(leftFrames / FPS),
        respawnCount: slot.respawnCount,
      };
    });
  }

  setWeapon(unit, mode) {
    if (!unit || !unit.isMember || !WEAPONS[mode]) return false;
    return applyWeapon(unit, mode);
  }

  toggleWeapon(unit) {
    if (!unit || !unit.isMember) return false;
    const next = unit.weaponMode === 'mg' ? 'rocket' : 'mg';
    applyWeapon(unit, next);
    unit.muzzleFlash = 4;
    return true;
  }
}
