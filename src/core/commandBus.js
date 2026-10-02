// 上帝命令通道：玩家指令进入游戏的唯一入口
//
// 这一层刻意做成抽象，为后续扩展留位置：
//   · 语音输入 = 新增 type:'voice'（先把语音转文字，之后与 'text' 同流程）
//   · 第二上帝玩家 = 把 sendCommand 远端化（WebSocket 房间转发），引擎无需改动
//   · 快捷命令 = type:'quick'，由 AgentManager 直接转成结构化指令，不消耗 token

export class CommandBus {
  constructor() {
    this.history = [];          // 最近命令（供快照与面板显示）
    this._pending = new Map();  // memberKey -> 命令数组
    this._seq = 0;
  }

  /**
   * @param opts { team, text, type='text'|'quick'|'voice', kind?, targets?, source='god', queue=true }
   *   targets 为成员 key 数组；不传则发给该阵营全体成员
   *   queue=false 时只记入历史/快照，不触发成员决策（快捷命令用，避免多花钱）
   */
  sendCommand(opts) {
    const type = opts.type || 'text';
    const cmd = {
      id: ++this._seq,
      team: opts.team,
      type: type,
      kind: opts.kind || null,       // 快捷命令种类：allAttack/retreat/defend/regroup
      text: (opts.text || '').trim(),
      source: opts.source || 'god',
      at: Date.now(),
      targets: opts.targets ? opts.targets.slice() : null, // 未点名则广播给全队
    };
    if (!cmd.text && type !== 'quick') return null;

    this.history.push(cmd);
    if (this.history.length > 60) this.history.shift();

    if (opts.queue === false) return cmd;

    const list = cmd.targets || this._memberKeysOfTeam(cmd.team);
    const self = this;
    list.forEach(function (key) {
      if (!self._pending.has(key)) self._pending.set(key, []);
      self._pending.get(key).push(cmd);
    });
    return cmd;
  }

  /** 该阵营最近的命令（快照里给成员看的"当前命令"） */
  lastForTeam(team) {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].team === team) return this.history[i];
    }
    return null;
  }

  /** 取走某成员待处理的命令（先进先出，一次只给最新的那条，避免堆积） */
  takeFor(memberKey) {
    const list = this._pending.get(memberKey);
    if (!list || list.length === 0) return null;
    const cmd = list[list.length - 1];
    this._pending.set(memberKey, []);
    return cmd;
  }

  /** 只看不取：用于触发判定（真正发起调用时再消费，避免冷却期把命令吃掉） */
  peekFor(memberKey) {
    const list = this._pending.get(memberKey);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  clearMember(memberKey) {
    this._pending.delete(memberKey);
  }

  // 由 AgentManager 注入，避免本模块依赖成员名册
  setMemberKeysResolver(fn) {
    this._memberKeysOfTeam = fn;
  }

  _memberKeysOfTeam() { return []; }
}
