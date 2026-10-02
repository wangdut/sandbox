// 带宽预算面板：本局 LLM 成本与社交频率（沙盘的成本可视化）
//
// 位置在侧栏成员卡片下方。数据全部来自 AgentManager.stats()。

import { escapeHtml } from './escape.js';

export class BudgetPanel {
  constructor() {
    this._dom = null;
    this._sig = '';
  }

  init() {
    this._dom = { root: document.getElementById('budgetPanel'), body: document.getElementById('budgetBody') };
    this._sig = '';
  }

  /**
   * @param agentStats AgentManager.stats()
   * @param budget 配置里的 budget（含上限）
   */
  update(agentStats, budget) {
    if (!this._dom || !this._dom.body || !agentStats) return;
    const cap = budget && budget.maxTokensPerGame ? budget.maxTokensPerGame : 0;
    const tokens = agentStats.totalTokens;
    const pct = cap > 0 ? Math.min(100, Math.round(tokens / cap * 100)) : 0;

    const sig = [tokens, agentStats.totalCalls, agentStats.totalErrors, agentStats.inFlight,
      agentStats.chatCounts.self, agentStats.chatCounts.ally, agentStats.chatCounts.enemy,
      agentStats.llmReady, agentStats.budgetExceeded, cap].join('|');
    if (sig === this._sig) return;
    this._sig = sig;

    if (!agentStats.llmReady) {
      this._dom.body.innerHTML =
        '<div class="bp-mode">脚本 AI 模式</div>' +
        '<div class="bp-hint">未配置 API Key：成员由脚本驱动。到 <a href="config.html" target="_blank">API 配置</a> 粘贴 Key 后刷新页面。</div>' +
        '<div class="bp-social">自语 ' + agentStats.chatCounts.self + ' · 队友喊话 ' + agentStats.chatCounts.ally +
        ' · 跨阵营喊话 ' + agentStats.chatCounts.enemy + '</div>';
      return;
    }

    const perMember = (agentStats.perMember || []).map(function (p) {
      const t = p.tokens >= 1000 ? (p.tokens / 1000).toFixed(1) + 'k' : String(p.tokens);
      const cls = p.team === 0 ? 'blue' : 'red';
      return '<span class="bp-chip ' + cls + (p.degraded ? ' degraded' : '') + '">' +
        escapeHtml(p.name) + ' ' + t + '</span>';
    }).join('');

    const capText = cap > 0 ? (tokens / 1000).toFixed(1) + 'k / ' + (cap / 1000).toFixed(0) + 'k' : (tokens / 1000).toFixed(1) + 'k';
    const barColor = agentStats.budgetExceeded ? '#e74c3c' : (pct > 80 ? '#f1c40f' : '#2ecc71');

    this._dom.body.innerHTML =
      '<div class="bp-bar"><i style="width:' + pct + '%;background:' + barColor + '"></i></div>' +
      '<div class="bp-line">token ' + capText + (agentStats.budgetExceeded ? ' · 已超限，降级脚本 AI' : '') + '</div>' +
      '<div class="bp-line dim">调用 ' + agentStats.totalCalls + ' · 失败 ' + agentStats.totalErrors +
      (agentStats.inFlight ? ' · 思考中 ' + agentStats.inFlight : '') + '</div>' +
      '<div class="bp-chips">' + perMember + '</div>' +
      '<div class="bp-social">自语 ' + agentStats.chatCounts.self + ' · 队友喊话 ' + agentStats.chatCounts.ally +
      ' · 跨阵营喊话 ' + agentStats.chatCounts.enemy + '</div>';
  }
}
