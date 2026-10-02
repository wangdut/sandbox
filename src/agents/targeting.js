// AI 自动索敌的唯一判定
//
// 中立高楼是「障碍 + 掩体」而不是猎物：它会挡住双方的直射弹道，打它既浪费火力又暴露位置。
// 引擎层的自动索敌本来就排除了中立单位（见 GameState.getEnemiesInRange），
// 但大脑层（提示词快照 / 兜底 AI / 观战触发）此前各自写了一份 `team !== myTeam`，
// 于是中立高楼被列成"敌人"喂给模型和脚本 AI —— 三处统一走这里，避免再次漂移。
//
// 注意：本判定只约束「AI 自己挑目标」。上帝玩家明确下令攻击某栋楼时，
// 执行层（AgentManager._applyDecision）按 id 解析目标，不经过这里，因此"高楼仍可拆"。

/** 该实体是否值得被 AI 主动选为目标 */
export function isAIAutoTargetable(e, team) {
  return !!e && !e.dead && e.team !== team && !e.aiIgnore;
}
