// 成员系统：4 名虚拟成员的生命周期管理
//
// 职责：
//   1. 阵亡后定时在己方指挥所重生（否则一方减员后局面不可逆）
//   2. 缓慢回血（无医疗建筑时的保底恢复，让「撤退保存实力」有意义）
//   3. 武器切换（机枪 ↔ 火箭筒）
//   4. 山顶高地加成（步兵站上 HILL_TOP 获得射程与伤害收益，离开精确回滚）
// M2 的 AgentManager 会基于本系统提供的注册表下发决策。

import { FPS, TEAM_PLAYER, TEAM_ENEMY, HILL_TOP, MAP_WIDTH, MAP_HEIGHT } from '../constants.js';
import { MEMBERS, DEFAULT_WEAPON, WEAPONS, applyWeapon, dismountVehicle } from './memberDefs.js';
import { findHQ, findRespawnSpot, mountPads, spawnParkedMount } from './scenario.js';

export const RESPAWN_SEC = 30;      // 阵亡后重生等待（秒）
export const REGEN_INTERVAL = 120;  // 每 2 秒回 1 次血
export const REGEN_AMOUNT = 3;      // 每次回复量（≈1.5 点/秒，让「撤退重整」有实际收益）
export const EJECT_HP_RATIO = 0.3;  // 弹射后保留的步兵血量比例
export const EJECT_INVULN = 120;    // 弹射后的无敌帧（2 秒，够从残骸里跑出来）
export const EJECT_COOLDOWN = 300;  // 两次弹射的最小间隔（5 秒，防连续弃车刷保命血）
export const MOUNT_RESPAWN_SEC = 45;   // 载具损失后在停机坪补车的等待（秒）
export const MOUNT_CHECK_INTERVAL = FPS; // 车队对账频率：每秒一次
export const HG_RANGE_BONUS = 2;       // 山顶观察位：射程加成（格）
export const HG_DAMAGE_MULT = 1.25;    // 山顶观察位：伤害加成（俯射）

export class MemberSystem {
  constructor() {
    // 槽位：每个成员一条，与实体解耦（实体死了这里仍然记得它）
    this.slots = [];
    this.frameCount = 0;
    // 双方载具补车倒计时（单位：秒）；-1 = 车队满编，不计时
    this._mountWait = [-1, -1];
  }

  init(gameState) {
    this.slots = MEMBERS.map(function (spec) {
      return { spec: spec, entity: null, missingSince: -1, respawnCount: 0 };
    });
    this._mountWait = [-1, -1];
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
        if (e.ejectCooldown > 0) e.ejectCooldown--;
        if (e.ejectInvuln > 0) {
          e.ejectInvuln--;
          if (e.ejectInvuln === 0) e.invulnerable = false;
        }
        self._applyHighGround(gameState, e);
        return;
      }
      // 实体已阵亡（或从未生成）：进入重生倒计时
      if (slot.missingSince < 0) slot.missingSince = frameCount;
      slot.entity = null;
      if (frameCount - slot.missingSince < RESPAWN_SEC * FPS) return;
      self._respawn(gameState, slot);
    });
    this._replenishMounts(gameState, frameCount);
  }

  /**
   * 载具补给：车队总数（停放中的 + 成员正开着的）恒定等于停机坪数量，
   * 少一辆就在 45 秒后于原停机坪补一辆。否则载具是一次性资源，
   * 开局几分钟内被开走/打光后就再也用不上了。
   */
  _replenishMounts(gameState, frameCount) {
    if (frameCount % MOUNT_CHECK_INTERVAL !== 0) return;
    const self = this;
    [TEAM_PLAYER, TEAM_ENEMY].forEach(function (team) {
      if (!findHQ(gameState, team)) return;          // 指挥所没了就不再补车
      const pads = mountPads(team);
      const fleet = gameState.entities.filter(function (e) {
        return !e.dead && e.team === team && (e.isMount || (e.isMember && e.mountType));
      });
      if (fleet.length >= pads.length) { self._mountWait[team] = -1; return; }
      if (self._mountWait[team] < 0) { self._mountWait[team] = MOUNT_RESPAWN_SEC; return; }
      if (self._mountWait[team] > 0) { self._mountWait[team]--; return; }
      // 补当前车队里缺失的那个机型/车型，且停机坪上没有实体占位
      const have = {};
      fleet.forEach(function (e) { have[e.isMount ? e.type : e.mountType] = true; });
      const pad = pads.filter(function (p) { return !have[p.type]; })
        .find(function (p) {
          return !gameState.entities.some(function (e) {
            return !e.dead && Math.abs(e.x - p.x) < 1 && Math.abs(e.y - p.y) < 1;
          });
        });
      if (!pad) return;                              // 停机坪被占，下一秒再试
      self._mountWait[team] = -1;
      const e = spawnParkedMount(gameState, pad.type, team, pad.x, pad.y);
      gameState.addFloatingText(e.getCenterX(), e.getCenterY() - 14, e.name + ' 已就位', '#f1c40f');
    });
  }

  /**
   * 高地加成：只有步兵（含刚弃车的成员）能占山顶，载具与飞行器不算。
   * 差量法——进出格子的瞬间各改一次，数值不重复累加；
   * 换武器/上下车会整体覆盖 damage/range，那些路径里会把 _hgApplied 清掉，本帧自动重挂。
   */
  _applyHighGround(gameState, e) {
    const map = gameState.map;
    if (!map) return;
    const tx = Math.floor(e.x), ty = Math.floor(e.y);
    let onSummit = false;
    if (e.type2 === 'infantry' && !e.isAirUnit && ty >= 0 && ty < MAP_HEIGHT && tx >= 0 && tx < MAP_WIDTH) {
      onSummit = map.terrain[ty][tx] === HILL_TOP;
    }
    if (onSummit && !e._hgApplied) {
      e._hgBaseDamage = e.damage;
      e.damage = Math.floor(e.damage * HG_DAMAGE_MULT);
      e.range += HG_RANGE_BONUS;
      e._hgApplied = true;
      e.onHighGround = true;
      gameState.addFloatingText(e.getCenterX(), e.getCenterY() - 14,
        '占领高地 射程+' + HG_RANGE_BONUS + ' 伤害+' + Math.round((HG_DAMAGE_MULT - 1) * 100) + '%', '#f1c40f');
    } else if (!onSummit && e._hgApplied) {
      if (typeof e._hgBaseDamage === 'number') e.damage = e._hgBaseDamage;
      e.range -= HG_RANGE_BONUS;
      e._hgApplied = false;
      e.onHighGround = false;
    }
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

  /**
   * 弹射逃生：乘驾的载具被击毁时，成员弃车存活（不进重生流程）
   * 由 GameState.damageEntity 的致死分支通过 _memberEject 回调
   * @returns true=已接管（不阵亡）；false=按正常死亡处理
   */
  tryEject(gameState, member) {
    if (!member || !member.isMember || !member.mountType) return false;
    if (member.ejectCooldown > 0) return false;   // 刚弃过车，这次真阵亡
    dismountVehicle(member);
    member.hp = Math.max(1, Math.round(member.maxHp * EJECT_HP_RATIO));
    member.ejectCooldown = EJECT_COOLDOWN;
    member.ejectInvuln = EJECT_INVULN;
    member.invulnerable = true;
    member.path = [];
    member.pathIndex = 0;
    member.attackTarget = null;
    member.attackMoveTarget = null;
    member.boardTarget = null;
    member.guardPos = null;
    gameState.addFloatingText(member.getCenterX(), member.getCenterY() - 14, member.memberName + ' 弃车逃生', '#f1c40f');
    gameState.addSpeech(member, '我中弹了，弃车！', '#f1c40f');
    return true;
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
    if (!unit || !unit.isMember || unit.mountType || !WEAPONS[mode]) return false;
    return applyWeapon(unit, mode);
  }

  toggleWeapon(unit) {
    if (!unit || !unit.isMember || unit.mountType) return false;
    const next = unit.weaponMode === 'mg' ? 'rocket' : 'mg';
    applyWeapon(unit, next);
    unit.muzzleFlash = 4;
    return true;
  }
}
