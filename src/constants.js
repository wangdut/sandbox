export const TILE_SIZE = 32;
// 沙盘尺度：64×64 的中型战场，双基地对角相望，镜头可自由拖动（不会再看到黑边）
export const MAP_WIDTH = 64;
export const MAP_HEIGHT = 64;
// 每秒帧数。冷却/建造/生产计时一律按帧存放（timer++），
// 所以凡是「秒」的定义都必须 × FPS 换算，否则会差 60 倍。
export const FPS = 60;
// HILL/HILL_TOP：山包的坡与顶（步兵可登顶获得射程/伤害加成，车辆爬不上）
// SANDBAG：沙袋阵地（步兵可进入，受击按比例减伤）
export const GRASS = 0, WATER = 1, ORE = 2, ROCK = 3, CONCRETE = 4, SAND = 5, TREE = 6,
  HILL = 7, HILL_TOP = 8, SANDBAG = 9;
export const TEAM_PLAYER = 0, TEAM_ENEMY = 1;
export const TEAM_NEUTRAL = 2; // 中立建筑（高楼）：挡路又挡弹的掩体，AI 不主动攻击，仅接受玩家下令拆除

// 阵营颜色
export const COLOR_ALLIED = '#4a9fd4', COLOR_ALLIED_DARK = '#1a5276';
export const COLOR_SOVIET = '#c0392b', COLOR_SOVIET_DARK = '#7b241c';
export const COLOR_PLAYER = '#4a9fd4', COLOR_PLAYER_DARK = '#1a5276';
export const COLOR_ENEMY = '#c0392c', COLOR_ENEMY_DARK = '#922b21';

// 阵营定义（内部键沿用基座的 allied/soviet，对外显示为蓝方/红方）
export const FACTION_ALLIED = 'allied';
export const FACTION_SOVIET = 'soviet';

// 队伍显示名：0=蓝方（上帝玩家），1=红方（电脑）
export const TEAM_NAMES = ['蓝方', '红方'];

export const SPATIAL_CELL = 8;

// 单位类型
export const TYPE_INFANTRY = 'infantry';
export const TYPE_VEHICLE = 'vehicle';
export const TYPE_AIRCRAFT = 'aircraft';
export const TYPE_HELICOPTER = 'helicopter';
export const TYPE_AIRSHIP = 'airship';
export const TYPE_NAVAL = 'naval';
export const TYPE_HARVESTER = 'harvester';
