// 聊天/命令面板：上帝命令输入、成员台词与喊话显示、快捷命令、token 计数
//
// M2 只做可用版；M3 会加上成员头像、阵营频道区分与完整预算表。

import { TEAM_NAMES } from '../constants.js';

export class ChatPanel {
  constructor() {
    this._dom = null;
    this._callbacks = null;
    this.maxEntries = 40;
  }

  init(callbacks) {
    this._callbacks = callbacks || {};
    this._dom = {
      root: document.getElementById('chatPanel'),
      log: document.getElementById('chatLog'),
      input: document.getElementById('chatInput'),
      send: document.getElementById('chatSend'),
      stats: document.getElementById('chatStats'),
      quickRow: document.getElementById('chatQuick'),
      voiceBtn: document.getElementById('voiceBtn'),
    };
    const self = this;
    const dom = this._dom;

    function submit() {
      const text = dom.input.value.trim();
      if (!text) return;
      if (self._callbacks.onSendCommand) self._callbacks.onSendCommand(text);
      dom.input.value = '';
    }

    dom.send.addEventListener('click', submit);
    dom.input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); dom.input.blur(); }
    });

    // 快捷命令（结构化指令，不消耗 token）
    dom.quickRow.addEventListener('click', function (ev) {
      const kind = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-quick');
      if (kind && self._callbacks.onQuickCommand) self._callbacks.onQuickCommand(kind);
    });

    // 回车聚焦输入框（不在输入态时）；语音按钮为 M4 预留
    document.addEventListener('keydown', function (ev) {
      const inField = ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA');
      if (ev.key === 'Enter' && !inField) { ev.preventDefault(); dom.input.focus(); }
    });
    if (dom.voiceBtn) {
      dom.voiceBtn.disabled = true;
      dom.voiceBtn.title = '语音输入将在 M4 开放（接口已预留：commandBus type=voice）';
    }
  }

  /** 系统提示（上帝命令、通讯中断等） */
  addSystem(text) {
    const div = document.createElement('div');
    div.className = 'chat-entry system';
    div.textContent = text;
    this._push(div);
  }

  /**
   * 成员消息
   * @param msg { name, team, text, to, at }
   */
  addMessage(msg) {
    const teamName = TEAM_NAMES[msg.team] || '';
    const div = document.createElement('div');
    div.className = 'chat-entry ' + (msg.team === 0 ? 'blue' : 'red');
    if (msg.to === '敌方') div.classList.add('shout-enemy');
    if (msg.to === '队友') div.classList.add('shout-ally');

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = '[' + teamName + '] ' + msg.name + (msg.to ? '→' + msg.to : '') + '：';
    const body = document.createElement('span');
    body.className = 'body';
    // 台词来自 LLM，用 textContent 注入，避免 HTML 注入
    body.textContent = (msg.to === '敌方' ? '📣 ' : (msg.to === '队友' ? '💬 ' : '')) + msg.text;

    div.appendChild(who);
    div.appendChild(body);
    this._push(div);
  }

  _push(div) {
    if (!this._dom || !this._dom.log) return;
    this._dom.log.appendChild(div);
    while (this._dom.log.childNodes.length > this.maxEntries) {
      this._dom.log.removeChild(this._dom.log.firstChild);
    }
    this._dom.log.scrollTop = this._dom.log.scrollHeight;
  }

  setStats(text) {
    if (this._dom && this._dom.stats && this._dom.stats.textContent !== text) {
      this._dom.stats.textContent = text;
    }
  }

  focusInput() {
    if (this._dom && this._dom.input) this._dom.input.focus();
  }
}
