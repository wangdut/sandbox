// 本局会话状态：上帝玩家选定的阵营
//
// 引擎内部沿用地图几何（蓝方在左下、红方在右上）与队伍编号（0=蓝、1=红），
// 但「谁是人、谁是电脑」由这里的 humanTeam 决定，所有"我方/敌方"判断都读它，
// 不再写死 TEAM_PLAYER —— 这样上帝玩家可以选蓝方，也可以选红方。

export const session = {
  humanTeam: 0,
  humanFaction: 'allied',
  aiTeam: 1,
  aiFaction: 'soviet',
};

export function setHumanTeam(team) {
  const t = team === 1 ? 1 : 0;
  session.humanTeam = t;
  session.aiTeam = t === 0 ? 1 : 0;
  session.humanFaction = t === 0 ? 'allied' : 'soviet';
  session.aiFaction = t === 0 ? 'soviet' : 'allied';
  return t;
}

export function isHumanTeam(team) {
  return team === session.humanTeam;
}
