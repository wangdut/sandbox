// 成员面板：显示 4 名虚拟成员的血量、武器、存活状态与重生倒计时
//
// M1 只做状态展示；M2/M3 会在此基础上加入「当前意图、台词、token 消耗」等信息。

import { WEAPONS } from '../sandbox/memberDefs.js';

export class MemberPanel {
  constructor() {
    this._dom = null;
    this._sig = '';
  }

  init() {
    this._dom = {
      list: document.getElementById('memberList'),
    };
    this._sig = '';
    if (this._dom.list) this._dom.list.innerHTML = '';
  }

  update(gameState, memberSystem) {
    if (!this._dom || !this._dom.list || !memberSystem) return;
    const slots = memberSystem.slotStatus();

    // 变更检测：签名不变就跳过 DOM 写入
    let sig = '';
    slots.forEach(function (s) {
      sig += s.spec.key + '|' + (s.alive ? Math.ceil(s.entity.hp) + ':' + s.entity.weaponMode : 'dead:' + s.respawnLeftSec) + ';';
    });
    if (sig === this._sig) return;
    this._sig = sig;

    const html = slots.map(function (s) {
      const spec = s.spec;
      const cls = spec.team === 0 ? 'blue' : 'red';
      const teamName = spec.team === 0 ? '蓝方' : '红方';
      if (!s.alive) {
        return '<div class="mp-card ' + cls + ' dead">' +
          '<div class="mp-name">' + spec.name + '<span class="mp-team">' + teamName + '</span></div>' +
          '<div class="mp-state">阵亡 · ' + s.respawnLeftSec + 's 后重生</div>' +
          '</div>';
      }
      const u = s.entity;
      const pct = Math.max(0, Math.round(u.hp / u.maxHp * 100));
      const w = WEAPONS[u.weaponMode] || WEAPONS.mg;
      const barColor = pct > 60 ? '#2ecc71' : (pct > 30 ? '#f1c40f' : '#e74c3c');
      return '<div class="mp-card ' + cls + '">' +
        '<div class="mp-name">' + spec.name + '<span class="mp-team">' + teamName + '</span></div>' +
        '<div class="mp-bar"><i style="width:' + pct + '%;background:' + barColor + '"></i></div>' +
        '<div class="mp-meta">HP ' + Math.ceil(u.hp) + '/' + u.maxHp + ' · ' + w.icon + ' ' + w.name + '</div>' +
        (s.respawnCount > 0 ? '<div class="mp-state dim">已重生 ' + s.respawnCount + ' 次</div>' : '') +
        '</div>';
    }).join('');

    this._dom.list.innerHTML = html;
  }
}
