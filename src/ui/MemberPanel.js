// 成员面板：4 名虚拟成员的卡片（头像、血条、武器、当前意图、最近台词、token 消耗）
//
// 信息来自两处：memberSystem（存活/血量/武器/重生倒计时）+ AgentManager.stats()（意图/台词/token）

import { TEAM_NAMES, TEAM_PLAYER } from '../constants.js';
import { WEAPONS } from '../sandbox/memberDefs.js';
import { session } from '../core/session.js';
import { escapeHtml } from './escape.js';

export class MemberPanel {
  constructor() {
    this._dom = null;
    this._sig = '';
  }

  init() {
    this._dom = { list: document.getElementById('memberList') };
    this._sig = '';
    if (this._dom.list) this._dom.list.innerHTML = '';
  }

  /**
   * @param gameState
   * @param memberSystem
   * @param agentStats AgentManager.stats() 的结果（可为 null，表示未接入 LLM 层）
   */
  update(gameState, memberSystem, agentStats) {
    if (!this._dom || !this._dom.list || !memberSystem) return;
    const slots = memberSystem.slotStatus().slice().sort(function (a, b) {
      // 己方排在前面（玩家可选阵营，所以按 session.humanTeam 而不是固定 0/1）
      if (a.spec.team === b.spec.team) return 0;
      return a.spec.team === session.humanTeam ? -1 : 1;
    });
    const byKey = {};
    if (agentStats && agentStats.perMember) {
      agentStats.perMember.forEach(function (p) { byKey[p.key] = p; });
    }

    let sig = '';
    slots.forEach(function (s) {
      const a = byKey[s.spec.key] || {};
      sig += s.spec.key + '|' + (s.alive ? Math.ceil(s.entity.hp) + s.entity.weaponMode : 'dead' + s.respawnLeftSec) +
        '|' + (a.intent || '') + '|' + (a.lastSay || '') + '|' + Math.round((a.tokens || 0) / 100) + '|' + (a.calls || 0) +
        '|' + (a.inFlight ? 1 : 0) + '|' + (a.degraded ? 1 : 0) + '|' + (a.actionBlocked ? 1 : 0) + ';';
    });
    if (sig === this._sig) return;
    this._sig = sig;

    const humanTeam = session.humanTeam;
    const html = slots.map(function (s) {
      const spec = s.spec;
      const a = byKey[spec.key] || {};
      const isHuman = spec.team === humanTeam;
      const cls = (isHuman ? 'blue' : 'red') + (s.alive ? '' : ' dead');
      const sideLabel = isHuman ? '你指挥' : '电脑';
      const avatar = '<div class="mp-avatar ' + (isHuman ? 'blue' : 'red') + '">' + escapeHtml(spec.name.charAt(0)) + '</div>';

      if (!s.alive) {
        return '<div class="mp-card ' + cls + '">' +
          avatar +
          '<div class="mp-main">' +
          '<div class="mp-name">' + escapeHtml(spec.name) +
          '<span class="mp-side">' + TEAM_NAMES[spec.team] + ' · ' + sideLabel + '</span></div>' +
          '<div class="mp-state">阵亡 · ' + s.respawnLeftSec + 's 后重生（已重生 ' + s.respawnCount + ' 次）</div>' +
          '</div></div>';
      }

      const u = s.entity;
      const pct = Math.max(0, Math.round(u.hp / u.maxHp * 100));
      const w = WEAPONS[u.weaponMode] || WEAPONS.mg;
      const barColor = pct > 60 ? '#2ecc71' : (pct > 30 ? '#f1c40f' : '#e74c3c');
      const stateLabel = a.degraded ? '脚本模式' : (a.inFlight ? '思考中…' : (a.actionBlocked ? '行动受阻' : '在线'));
      const tokens = a.tokens ? (a.tokens >= 1000 ? (a.tokens / 1000).toFixed(1) + 'k' : String(a.tokens)) : '0';

      return '<div class="mp-card ' + cls + '">' +
        avatar +
        '<div class="mp-main">' +
        '<div class="mp-name">' + escapeHtml(spec.name) +
        '<span class="mp-side">' + TEAM_NAMES[spec.team] + ' · ' + sideLabel + '</span></div>' +
        '<div class="mp-bar"><i style="width:' + pct + '%;background:' + barColor + '"></i>' +
        '<span class="mp-hp">' + Math.ceil(u.hp) + '/' + u.maxHp + '</span></div>' +
        '<div class="mp-meta">' + w.icon + ' ' + w.name + ' · ' + stateLabel + ' · ' + tokens + ' tok</div>' +
        (a.intent ? '<div class="mp-intent">意图：' + escapeHtml(a.intent) + '</div>' : '') +
        (a.lastSay ? '<div class="mp-say">「' + escapeHtml(a.lastSay) + '」</div>' : '') +
        (a.actionBlocked ? '<div class="mp-state">上次行动未落实，正在重新判断</div>' : '') +
        '</div></div>';
    }).join('');

    this._dom.list.innerHTML = html;
  }
}
