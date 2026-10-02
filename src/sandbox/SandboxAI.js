// 红方（电脑阵营）驱动
//
// M1 阶段：只负责让红方单位跑通用单位 AI —— 射程内自动交战、被袭击时反击，
// 因此红方成员会守卫指挥所并追击靠近的蓝方成员。
// M2 将由 LLM 代理接管决策（AgentManager），本类退化为「无 API / 解析失败」时的脚本兜底。

export class SandboxAI {
  constructor() {
    // 字段与基座 EnemyAI 保持同名，读档/存档逻辑无需改动
    this.aiTimer = 0;
    this.buildQueue = [];
    this.attackTimer = 0;
    this.attackWave = 0;
    this.scoutTimer = 0;
    this._callbacks = null;
  }

  init(callbacks) {
    this._callbacks = callbacks;
  }

  update(gameState, difficulty, frameCount) {
    if (!this._callbacks || !this._callbacks.updateUnitAI) return;
    const units = gameState.getEnemyUnits();
    for (let i = 0; i < units.length; i++) {
      if (!units[i].dead) this._callbacks.updateUnitAI(units[i]);
    }
  }
}
