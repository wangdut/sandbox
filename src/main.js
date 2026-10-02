import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, GRASS, WATER, ORE, SAND, CONCRETE, TREE, FPS } from './constants.js';
import { BUILDING_DEFS, DEFENSE_DEFS, UNIT_DEFS } from './definitions.js';
import { Entity } from './Entity.js';
import { GameState } from './GameState.js';
import { Renderer } from './Renderer.js';
import { UIManager } from './UI.js';
import { InputHandler } from './InputHandler.js';
import { SandboxAI } from './sandbox/SandboxAI.js';
import { buildSandboxScenario, findHQ } from './sandbox/scenario.js';
import { MemberSystem } from './sandbox/memberSystem.js';
import { MemberPanel } from './ui/MemberPanel.js';
import { BudgetPanel } from './ui/BudgetPanel.js';
import { ChatPanel } from './ui/ChatPanel.js';
import { loadConfig, saveConfig } from './agents/config.js';
import { AgentManager } from './agents/AgentManager.js';
import { CommandBus } from './core/commandBus.js';
import { session, setHumanTeam } from './core/session.js';
import { clampCameraToMap } from './core/camera.js';
import { MEMBERS } from './sandbox/memberDefs.js';
import { AudioManager, audioManager } from './AudioManager.js';
import { SaveManager } from './SaveManager.js';
import { setNotifier } from './Notifications.js';
import { PRISM_LINK_RANGE, GUARD_CHASE_RANGE, REPAIR_BAY_RANGE, REPAIR_BAY_HEAL,
         SPY_INFILTRATE_DIST, SPY_BLACKOUT_FRAMES, PRODUCER_BUILDINGS } from './GameTuning.js';
import { pickAttackTarget, countLinkedPrisms, performAttack, performBurstShot,
         updateProjectiles, updateExplosions, updateFloatingTexts, updateSmoke, updateSpeechBubbles } from './Combat.js';
import { updateUnitAI, updateHarvesterAI, moveUnit, updateSpyInfiltration } from './UnitAI.js';
import { updateBuildingAI, updateRepairBays, spawnProducedUnit, findProducingBuilding } from './Buildings.js';

// 拆分出去的模块通过该出口弹提示（见 Notifications.js）
setNotifier(notify);

let canvas, minimapCanvas, ctx, minimapCtx;
let gameState, renderer, ui, input, sandboxAI, saveManager, memberSystem, memberPanel;
let commandBus, agentManager, chatPanel, sandboxConfig, budgetPanel;
let camera = { x: 0, y: 0, zoom: 1 };
let selectedUnits = [], selectedBuilding = null;
let placingBuilding = false, placingType = null;
let gameStartTime = 0, difficulty = 'normal';
let frameCount = 0;
let gameRunning = false, gamePaused = false, gameSpeed = 1;
let activeAction = null;
let notifTimer = 0;

// 超武存活集合：每次建筑扫描前 clear 后复用，避免创建新对象。
// 用途是反向注销——建筑被拆后对应超武必须从管理器里移除。
const SW_ACTIVE_PLAYER = new Set();
const SW_ACTIVE_ENEMY = new Set();

function startGame(side) {
  // 上帝玩家可选阵营：'blue' / 'red'（默认蓝方）
  setHumanTeam(side === 'red' ? 1 : 0);
  difficulty = session.humanTeam === 0 ? '蓝方' : '红方';
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');
  minimapCanvas = document.getElementById('minimapCanvas');
  minimapCtx = minimapCanvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  minimapCanvas.width = 300;
  minimapCanvas.height = 200;
  Entity.counter = 0;
  gameState = new GameState();
  gameState.humanTeam = session.humanTeam;
  gameState._playExplosionSound = function() { audioManager.playExplosion(); };
  // 沙盘固定布景（替代基座的随机地图 + 采集开局）
  buildSandboxScenario(gameState, session.humanTeam);
  // 上帝视角：全图可见，便于观察 4 名成员的自主行为
  gameState.fogOfWar.enabled = false;
  // 开局把镜头对准"我方"指挥所
  const ownHq = findHQ(gameState, session.humanTeam);
  if (ownHq) {
    camera.x = (ownHq.x + 1.5) * TILE_SIZE * camera.zoom - (canvas.width - 300) / 2;
    camera.y = (ownHq.y + 1.5) * TILE_SIZE * camera.zoom - canvas.height / 2;
  }
  clampCamera();
  selectedUnits = [];
  selectedBuilding = null;
  placingBuilding = false;
  placingType = null;
  gameStartTime = Date.now();
  frameCount = 0;
  gameRunning = true;
  gamePaused = false;
  gameSpeed = 1;
  activeAction = null;
  notifTimer = 0;
  setGameSpeed(1);   // 同步速度滑动条与标签
  document.getElementById('startScreen').style.display = 'none';
  document.getElementById('gameOver').style.display = 'none';
  renderer = new Renderer(canvas, minimapCanvas);
  ui = new UIManager();
  ui.init({
    gameState: gameState,
    // 适配器：UI 侧按 (type, team) 调用，这里补上 gameState
    findProducingBuilding: function(type, team) { return findProducingBuilding(gameState, type, team); },
    startBuild: startBuild,
    playSelectSound: function() { audioManager.playSelect(); },
    playCancelSound: function() { audioManager.playCancel(); },
    findEntityById: findEntityById,
    onSelectGroup: selectGroup,
    onNotify: notify,
    onSuperWeaponClick: function(type) {
      if (!input) return;
      input._callbacks.superWeaponTargeting = type;
      notify('点击地图选择目标位置，右键取消', 'info');
      audioManager.playSelect();
    }
  });
  input = new InputHandler(canvas, minimapCanvas);
  input.setup(gameState, camera, {
    selectedUnits: selectedUnits,
    selectedBuilding: selectedBuilding,
    placingBuilding: placingBuilding,
    placingType: placingType,
    activeAction: activeAction,
    onRepair: repairBuilding,
    onSell: sellBuilding,
    onNotify: notify,
    onPlayBuildSound: function() { audioManager.playBuild(); },
    onPlayCancelSound: function() { audioManager.playCancel(); },
    onPlaySelectSound: function() { audioManager.playSelect(); },
    onHideHelp: function() { ui.hideHelp(); },
    onShowHelp: function() { ui.showHelp(); },
    onTogglePause: togglePause,
    onCommandStop: commandStop,
    onToggleWeapon: toggleSelectedWeapon,
    onSetGroup: setGroup,
    onSelectGroup: selectGroup,
    onCycleTab: function() {
      var tabs = ['buildings', 'units', 'defenses'];
      var idx = tabs.indexOf(ui.currentTab);
      ui.switchTab(tabs[(idx + 1) % tabs.length]);
    },
    onSaveGame: saveGame,
    onLoadGame: loadGame,
    superWeaponTargeting: null,
    onSuperWeaponFire: fireSuperWeapon
  });
  // 红方（电脑阵营）驱动：M1 为脚本兜底，M2 由 LLM 代理接管决策
  sandboxAI = new SandboxAI();
  sandboxAI.init({
    // 适配器：按 (unit) 调用，这里补上 gameState 与当前帧号
    updateUnitAI: function(unit) { return updateUnitAI(gameState, unit, frameCount); },
    notify: notify,
    playAlertSound: function() { audioManager.playAlert(); }
  });
  // 成员系统：阵亡重生、缓慢回血、武器切换
  memberSystem = new MemberSystem();
  memberSystem.init(gameState);
  memberPanel = new MemberPanel();
  memberPanel.init();
  budgetPanel = new BudgetPanel();
  budgetPanel.init();

  // ===== LLM 大脑层（M2）=====
  sandboxConfig = loadConfig();
  commandBus = new CommandBus();
  // 命令按成员 key 分发，避免本模块依赖成员名册
  commandBus.setMemberKeysResolver(function (team) {
    return MEMBERS.filter(function (m) { return m.team === team; }).map(function (m) { return m.key; });
  });
  agentManager = new AgentManager();
  agentManager.init({
    config: sandboxConfig,
    memberSystem: memberSystem,
    commandBus: commandBus,
    notify: notify,
    onChat: function (msg) {
      if (chatPanel) chatPanel.addMessage(msg);
    },
  });
  chatPanel = new ChatPanel();
  chatPanel.init({
    onSendCommand: sendGodCommand,
    onQuickCommand: sendQuickCommand,
  });
  if (agentManager.llmReady) {
    chatPanel.addSystem('【系统】成员大脑已接入（' + sandboxConfig.model + '）。输入命令并回车即可下达给己方成员。');
  } else {
    chatPanel.addSystem('【系统】尚未配置 API Key：成员将由脚本 AI 行动。点右下"⚙ API 配置"粘贴 Key 后刷新页面即可启用。');
  }

  saveManager = new SaveManager();
  wireSuperWeaponCallbacks(gameState.superWeaponManager);
  // 调试/测试钩子
  window.__game = gameState;
  window.__input = input;
  window.__ui = ui;
  window.__memberSystem = memberSystem;
  window.__agents = agentManager;
  window.__commandBus = commandBus;
  ui.renderGroupBar(gameState);
  ui.updateBuildList(gameState);
  // 开局自动选中己方两名成员，玩家可立即右键指挥
  memberSystem.liveMembers(gameState).forEach(function(u) {
    if (u.team === gameState.humanTeam) { u.selected = true; selectedUnits.push(u); }
  });
  gameLoop();
}

function wireSuperWeaponCallbacks(swm) {
  swm.onLaunch = function(type, team) {
    if (type === 'nuke') audioManager.playNukeSiren();
    else if (type === 'chrono') audioManager.playChrono();
    else if (type === 'ironCurtain') audioManager.playIronCurtain();
    else if (type === 'lightningStorm') audioManager.playAlert();
    if (team !== gameState.humanTeam) {
      var swNames = { nuke: '核弹攻击', lightningStorm: '闪电风暴', ironCurtain: '铁幕装置', chrono: '超时空传送' };
      notify('警报: 敌方使用了 ' + (swNames[type] || '超级武器') + '！', 'danger');
      audioManager.playAlert();
    }
  };
  swm.onChronoPending = function(team) {
    if (team === gameState.humanTeam && input) {
      input._callbacks.superWeaponTargeting = '__chronoDest';
      notify('选择传送目的地', 'info');
    }
  };
  swm.onChronoExpired = function(team) {
    if (team === gameState.humanTeam && input && input._callbacks.superWeaponTargeting === '__chronoDest') {
      input._callbacks.superWeaponTargeting = null;
      notify('传送超时取消', 'warn');
    }
  };
}

// 固定步长主循环用：把「帧」与真实时间对齐
const FRAME_MS = 1000 / FPS;
const MAX_STEPS_PER_RAF = 8;   // 单次 rAF 最多补多少帧，避免切后台回来一次性狂算
const CHAT_PANEL_HEIGHT = 152; // 底部命令栏高度：相机可视区与边缘滚动都要扣掉它
let lastFrameTime = 0;
let accumulator = 0;

function gameLoop(timestamp) {
  if (!gameRunning) return;
  // 120Hz/144Hz 屏幕上 rAF 每秒触发上百次，而引擎所有计时（冷却/射速/重生）都按
  // 60FPS 的「帧」计算。这里用累加器把更新固定成每秒 60 帧，渲染仍按屏幕刷新率走，
  // 否则高刷屏上游戏会整体加速一倍（冷却、token 消耗、阵亡节奏全都被压缩）。
  const now = typeof timestamp === 'number' ? timestamp : performance.now();
  if (!lastFrameTime) lastFrameTime = now;
  let dt = now - lastFrameTime;
  lastFrameTime = now;
  if (dt > 250) dt = 250;   // 长时间挂起（切标签页）不补算

  if (!gamePaused) {
    accumulator += dt * gameSpeed;
    let steps = 0;
    while (accumulator >= FRAME_MS && steps < MAX_STEPS_PER_RAF) {
      accumulator -= FRAME_MS;
      steps++;
      frameCount++;
      updateCamera();
      updateEntities();
      updateProjectiles(gameState);
      updateExplosions(gameState);
      updateFloatingTexts(gameState);
      updateSpeechBubbles(gameState);
      updateSmoke(gameState);
      updateMinimapAlerts();
      updateResources();
      updateEnemyAI();
      memberSystem.update(gameState, frameCount);
      agentManager.update(gameState, frameCount);
      if (frameCount % 6 === 0) updateHud();
      ui.updateNotification();
      checkGameOver();
      if (gameState.gameOver) break;
    }
    if (steps >= MAX_STEPS_PER_RAF) accumulator = 0;  // 落后太多就丢弃，防雪崩
  } else {
    accumulator = 0;
    updateCamera();
  }
  ui.updateUI(gameState, gameStartTime, input ? input._callbacks.selectedUnits : selectedUnits,
    input ? input._callbacks.selectedBuilding : selectedBuilding, frameCount);
  ui.updateSuperWeapons(gameState, input ? input._callbacks.superWeaponTargeting : null, frameCount);
  renderer.render(gameState, camera, frameCount,
    input ? input._callbacks.selectedUnits : selectedUnits,
    input ? input._callbacks.selectedBuilding : selectedBuilding,
    input ? input._callbacks.placingBuilding : placingBuilding,
    input ? input._callbacks.placingType : placingType,
    input ? input.mouse : { x: 0, y: 0, worldX: 0, worldY: 0, mapX: 0, mapY: 0, inCanvas: false },
    input ? input.dragSelect : { active: false, startX: 0, startY: 0, endX: 0, endY: 0 },
    input ? input._callbacks.activeAction : activeAction,
    input ? input._callbacks.superWeaponTargeting : null,
    gamePaused, canvas.width - 300, canvas.height);
  requestAnimationFrame(gameLoop);
}

function updateCamera() {
  var speed = 16;
  var keys = input ? input.keys : {};
  if (keys['ArrowLeft']) camera.x -= speed;
  if (keys['ArrowRight']) camera.x += speed;
  if (keys['ArrowUp']) camera.y -= speed;
  if (keys['ArrowDown']) camera.y += speed;
  // 边缘滚动的判定区要避开底部聊天栏与右侧栏，否则鼠标根本到不了那条边
  var edge = 26;
  var viewW = canvas.width - 300;
  var viewH = canvas.height - CHAT_PANEL_HEIGHT;
  var mouse = input ? input.mouse : { inCanvas: false, x: 0, y: 0 };
  if (mouse.inCanvas) {
    if (mouse.x > 0 && mouse.x < edge && mouse.y > 44 && mouse.y < viewH) camera.x -= 14;
    if (mouse.x > viewW - edge && mouse.x < viewW && mouse.y > 44 && mouse.y < viewH) camera.x += 14;
    if (mouse.y > 44 && mouse.y < 44 + edge && mouse.x > 0 && mouse.x < viewW) camera.y -= 14;
    if (mouse.y > viewH - edge && mouse.y < viewH && mouse.x > 0 && mouse.x < viewW) camera.y += 14;
  }
  clampCamera();
}

/** 相机夹取（含"地图比视口小则居中"），统一入口避免各处写不同的夹取逻辑 */
function clampCamera() {
  clampCameraToMap(camera, canvas.width - 300, canvas.height - CHAT_PANEL_HEIGHT);
}

function updateEntities() {
  // 空间网格每3帧重建一次即可，范围查询不需要每帧精确
  if (frameCount % 3 === 0) gameState.spatialDirty = true;
  gameState._listDirty = false;
  // 威胁网格：建筑增减后需要重算，30 帧（0.5 秒）一次足够
  if (frameCount % 30 === 0) gameState.rebuildDanger();
  // 重置本帧寻路预算：大量单位同帧重算路径时压缩单次迭代上限，平滑掉帧尖峰
  gameState.map.resetPathBudget();
  
  // 更新战争迷雾
  if (gameState.fogOfWar && frameCount % 5 === 0) {
    gameState.fogOfWar.update(gameState.entities);
  }
  
  // 更新超级武器
  if (gameState.superWeaponManager) {
    gameState.superWeaponManager.update();
  }
  for (var i = gameState.entities.length - 1; i >= 0; i--) {
    var e = gameState.entities[i];
    if (e.dead) {
      e.deathTimer--;
      if (e.deathTimer % 3 === 0 && e.deathTimer > 10) gameState.addSmoke(e.getCenterX(), e.getCenterY());
      if (e.deathTimer <= 0) gameState.entities.splice(i, 1);
      continue;
    }
    if (e.muzzleFlash > 0) e.muzzleFlash--;
    if (e.flashTimer > 0) e.flashTimer--;
    if (e.lastDamagedTimer > 0) e.lastDamagedTimer--;
    if (e.pathRecalcTimer > 0) e.pathRecalcTimer--;
    if (!e.dead && e.hp < e.maxHp * 0.4 && frameCount % 18 === 0) {
      gameState.addSmoke(e.getCenterX() + (Math.random() - 0.5) * 8, e.getCenterY() + (Math.random() - 0.5) * 8);
    }
    if (e.isBuilding) {
      updateBuildingAI(gameState, e);
    } else {
      if (e.fireCooldown > 0) e.fireCooldown--;
      if (e.team === gameState.humanTeam) updateUnitAI(gameState, e);
    }
  }
  updateRepairBays(gameState, frameCount);
}

function updateMinimapAlerts() {
  for (var i = gameState.minimapAlerts.length - 1; i >= 0; i--) {
    gameState.minimapAlerts[i].timer--;
    if (gameState.minimapAlerts[i].timer <= 0) gameState.minimapAlerts.splice(i, 1);
  }
}

function updateResources() {
  if (gameState.lowPowerAlertCooldown > 0) gameState.lowPowerAlertCooldown--;
  if (gameState.underAttackAlertCooldown > 0) gameState.underAttackAlertCooldown--;
  // 间谍渗透电厂造成的断电倒计时
  if (gameState.playerPowerBlackout > 0) gameState.playerPowerBlackout--;
  if (gameState.enemyPowerBlackout > 0) gameState.enemyPowerBlackout--;
  // 电力/单位数等统计无需每帧精确，降频扫描
  if (frameCount % 15 !== 0) return;
  var pp = 0, ppU = 0, ep = 0, epU = 0, uc = 0;
  // 复用的超武类型集合，避免每 15 帧新建对象
  SW_ACTIVE_PLAYER.clear();
  SW_ACTIVE_ENEMY.clear();
  for (var i = 0; i < gameState.entities.length; i++) {
    var e = gameState.entities[i];
    if (e.dead || !e.built) continue;
    if (e.isBuilding) {
      if (e.team === gameState.humanTeam) { pp += e.power || 0; ppU += e.powerUse || 0; }
      else { ep += e.power || 0; epU += e.powerUse || 0; }
      // 注册超级武器（建成即计时，覆盖建造/读档/占领三种来源）
      var bdef = BUILDING_DEFS[e.type];
      if (bdef && bdef.superWeapon) {
        gameState.superWeaponManager.addSuperWeapon(bdef.superWeapon, e.team);
        if (e.team === gameState.humanTeam) SW_ACTIVE_PLAYER.add(bdef.superWeapon);
        else SW_ACTIVE_ENEMY.add(bdef.superWeapon);
      }
    } else if (e.team === gameState.humanTeam) uc++;
  }
  // 以存活建筑为准反向注销：发射井被拆后核弹不能继续充能
  gameState.superWeaponManager.syncActive(SW_ACTIVE_PLAYER, SW_ACTIVE_ENEMY);
  // 间谍渗透电厂：发电量骤降至 20%，磁暴线圈这类耗电建筑会直接停摆
  if (gameState.playerPowerBlackout > 0) pp = Math.floor(pp * 0.2);
  if (gameState.enemyPowerBlackout > 0) ep = Math.floor(ep * 0.2);
  gameState.playerPower = pp;
  gameState.playerPowerUse = ppU;
  gameState.enemyPower = ep;
  gameState.enemyPowerUse = epU;
  gameState.playerUnitCount = uc;
  gameState.hasRadar = gameState.hasBuilding(gameState.humanTeam, 'radar');
  gameState.hasTechCenter = gameState.hasBuilding(gameState.humanTeam, 'alliedTech') || gameState.hasBuilding(gameState.humanTeam, 'sovietTech');
  if (gameState.playerPower < gameState.playerPowerUse && gameState.lowPowerAlertCooldown === 0) {
    notify('\u8b66\u544a: \u7535\u529b\u4e0d\u8db3\uff01', 'warn');
    audioManager.playAlert();
    gameState.lowPowerAlertCooldown = 600;
  }
}

/**
 * 上帝命令：打字输入 → 命令通道 → 己方成员各自调用 LLM 回应与决策
 */
function sendGodCommand(text) {
  if (!commandBus || !agentManager) return;
  const cmd = commandBus.sendCommand({ team: gameState.humanTeam, type: 'text', text: text });
  if (!cmd) return;
  chatPanel.addSystem('【你 → 蓝方】' + text);
  if (!agentManager.llmReady) {
    chatPanel.addSystem('（未配置 API Key：成员无法用 LLM 回应，仅按脚本 AI 行动。到 config.html 粘贴 Key 后刷新页面）');
  }
}

/**
 * 快捷命令：结构化指令直接执行，不消耗 token
 */
function sendQuickCommand(kind) {
  if (!commandBus || !agentManager) return;
  const LABELS = { allAttack: '总攻', retreat: '撤退', defend: '回防', regroup: '集合' };
  const label = LABELS[kind] || kind;
  commandBus.sendCommand({ team: gameState.humanTeam, type: 'quick', kind: kind, text: '【' + label + '】', queue: false });
  chatPanel.addSystem('【你 → 蓝方】' + label + '（快捷命令，不消耗 token）');
  const n = agentManager.applyQuickCommand(gameState, gameState.humanTeam, kind);
  if (n === 0) chatPanel.addSystem('（当前没有可用成员，可能在等待重生）');
}

/** HUD 统一刷新：指挥所血条、成员卡片、带宽预算、token 计数 */
function updateHud() {
  if (!gameState) return;
  // 顶部：双方指挥所血量（沙盘的胜负目标，必须一眼可见）
  const ownHq = findHQ(gameState, session.humanTeam);
  const aiHq = findHQ(gameState, session.aiTeam);
  setHqBar('hqBarBlue', 'hqHpBlue', ownHq, '己方指挥所');
  setHqBar('hqBarRed', 'hqHpRed', aiHq, '敌方指挥所');

  if (!agentManager) return;
  const s = agentManager.stats();
  if (memberPanel) memberPanel.update(gameState, memberSystem, s);
  if (budgetPanel) budgetPanel.update(s, sandboxConfig ? sandboxConfig.budget : null);
  if (chatPanel) {
    if (!s.llmReady) {
      chatPanel.setStats('脚本 AI 模式');
    } else {
      const cap = sandboxConfig && sandboxConfig.budget ? sandboxConfig.budget.maxTokensPerGame : 0;
      chatPanel.setStats('token ' + s.totalTokens + (cap > 0 ? '/' + cap : '') +
        ' · 调用 ' + s.totalCalls + ' · 失败 ' + s.totalErrors + (s.inFlight ? ' · 思考中…' : ''));
    }
  }
}

function setHqBar(barId, hpId, hq, label) {
  const bar = document.getElementById(barId);
  const hpEl = document.getElementById(hpId);
  if (!bar || !hpEl) return;
  const nameEl = document.getElementById(barId + 'Name');
  if (nameEl && label && nameEl.textContent !== label) nameEl.textContent = label;
  if (!hq) {
    if (bar.style.width !== '0%') { bar.style.width = '0%'; }
    if (hpEl.textContent !== '已失守') hpEl.textContent = '已失守';
    return;
  }
  const pct = Math.max(0, Math.round(hq.hp / hq.maxHp * 100));
  const width = pct + '%';
  if (bar.style.width !== width) bar.style.width = width;
  bar.style.background = pct > 60 ? '#2ecc71' : (pct > 30 ? '#f1c40f' : '#e74c3c');
  const txt = String(Math.ceil(hq.hp));
  if (hpEl.textContent !== txt) hpEl.textContent = txt;
}

function updateEnemyAI() {
  sandboxAI.update(gameState, difficulty, frameCount);
}

/**
 * 切换选中成员的武器（机枪 ↔ 火箭筒）
 */
function toggleSelectedWeapon() {
  var sel = input ? input._callbacks.selectedUnits : selectedUnits;
  var n = 0;
  sel.forEach(function(u) {
    if (u.isMember && memberSystem.toggleWeapon(u)) n++;
  });
  if (n > 0) {
    var first = sel.find(function(u) { return u.isMember; });
    notify('切换武器：' + first.name + ' → ' + (first.weaponMode === 'rocket' ? '火箭筒' : '机枪'), 'info');
  } else {
    notify('请先选中成员（金色光环单位）', 'warn');
  }
}

function startBuild(type, team) {
  var def = BUILDING_DEFS[type] || DEFENSE_DEFS[type] || UNIT_DEFS[type];
  if (!def) return;
  if (team === gameState.humanTeam && !gameState.canBuild(type, team)) {
    var reason = gameState.getBuildReason(type, team);
    notify(reason, 'warn');
    audioManager.playCancel();
    return;
  }
  if (!gameState.canBuild(type, team)) return;
  if (def.category === 'units') {
    var pb = findProducingBuilding(gameState, type, team);
    if (!pb) { notify('\u6ca1\u6709\u53ef\u7528\u7684\u751f\u4ea7\u5efa\u7b51', 'warn'); return; }
    if (pb.producing) {
      if (pb.productionQueue.length < 5) {
        if (team === gameState.humanTeam) gameState.playerCredits -= def.cost;
        else gameState.enemyCredits -= def.cost;
        pb.productionQueue.push(type);
        if (team === gameState.humanTeam) notify(def.name + ' \u5df2\u52a0\u5165\u961f\u5217 (' + pb.productionQueue.length + ')', 'info');
      } else if (team === gameState.humanTeam) notify('\u751f\u4ea7\u961f\u5217\u5df2\u6ee1', 'warn');
      return;
    }
    if (team === gameState.humanTeam) { gameState.playerCredits -= def.cost; pb.producing = type; pb.produceProgress = 0; notify('\u5f00\u59cb\u8bad\u7ec3 ' + def.name, 'info'); }
  } else if (team === gameState.humanTeam) {
    if (input) {
      input._callbacks.placingBuilding = true;
      input._callbacks.placingType = type;
    }
    placingBuilding = true;
    placingType = type;
    notify('\u70b9\u51fb\u5730\u56fe\u653e\u7f6e ' + def.name + '\uff0cESC \u53d6\u6d88', 'info');
  }
}

function toggleAction(action) {
  if (activeAction === action) { activeAction = null; }
  else activeAction = action;
  placingBuilding = false;
  placingType = null;
  if (input) {
    input._callbacks.activeAction = activeAction;
    input._callbacks.placingBuilding = false;
    input._callbacks.placingType = null;
  }
  document.getElementById('btnRepair').classList.toggle('active', activeAction === 'repair');
  document.getElementById('btnSell').classList.toggle('active', activeAction === 'sell');
}

function commandStop() {
  var sel = input ? input._callbacks.selectedUnits : selectedUnits;
  if (sel.length > 0) {
    sel.forEach(function(u) {
      u.path = [];
      u.pathIndex = 0;
      u.attackTarget = null;
      u.attackMoveTarget = null;
      u.guardPos = null;
      u.burstRemaining = 0;
      u.burstTarget = null;
    });
    notify('\u505c\u6b62\u547d\u4ee4', 'info');
  }
}

function fireSuperWeapon(type, mapX, mapY) {
  var swm = gameState.superWeaponManager;
  if (input) input._callbacks.superWeaponTargeting = null;
  if (type === '__chronoDest') {
    var pending = swm.getPendingChrono(gameState.humanTeam);
    if (pending) {
      swm.completeChronoShift(pending, mapX, mapY);
      notify('\u8d85\u65f6\u7a7a\u4f20\u9001\u5b8c\u6210', 'info');
    }
    return;
  }
  if (swm.useSuperWeapon(type, gameState.humanTeam, mapX, mapY)) {
    notify('\u8d85\u7ea7\u6b66\u5668\u5df2\u53d1\u52a8', 'info');
  } else {
    notify('\u76ee\u6807\u65e0\u6548\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9', 'warn');
    audioManager.playCancel();
  }
}

function sellBuilding(b) {
  var def = BUILDING_DEFS[b.type] || DEFENSE_DEFS[b.type];
  if (!def || b.type === 'base') { notify('\u8be5\u5efa\u7b51\u65e0\u6cd5\u51fa\u552e', 'warn'); return; }
  var refund = Math.floor(def.cost * 0.5 * (b.hp / b.maxHp));
  gameState.playerCredits += refund;
  notify('\u51fa\u552e ' + b.name + ' \u56de\u6536 $' + refund, 'info');
  gameState.addFloatingText(b.getCenterX(), b.getCenterY() - 10, '+$' + refund, '#f1c40f');
  gameState.addExplosion(b.getCenterX(), b.getCenterY(), 30, 'big');
  gameState.removeEntity(b);
  audioManager.playBuild();
}

function repairBuilding(b) {
  if (b.hp >= b.maxHp) { notify('\u8be5\u5efa\u7b51\u65e0\u9700\u4fee\u7406', 'info'); return; }
  var def = BUILDING_DEFS[b.type] || DEFENSE_DEFS[b.type];
  if (!def) return;
  var damage = b.maxHp - b.hp;
  var cost = Math.ceil(def.cost * damage / b.maxHp * 0.6);
  if (gameState.playerCredits < cost) { notify('\u8d44\u91d1\u4e0d\u8db3\uff0c\u9700\u8981 $' + cost, 'warn'); return; }
  gameState.playerCredits -= cost;
  b.hp = b.maxHp;
  gameState.addFloatingText(b.getCenterX(), b.getCenterY() - 10, '\u4fee\u590d\uff01', '#2ecc71');
  notify(b.name + ' \u5df2\u4fee\u590d (\u82b1\u8d39 $' + cost + ')', 'info');
  audioManager.playBuild();
}

function togglePause() {
  gamePaused = !gamePaused;
  var btn = document.getElementById('pauseBtn');
  btn.textContent = gamePaused ? '\u7ee7\u7eed' : '\u6682\u505c';
  btn.classList.toggle('paused', gamePaused);
  if (gamePaused) notify('\u6e38\u620f\u5df2\u6682\u505c', 'info');
}

/**
 * 设置游戏速度：0 = 暂停，其余按倍率推进（滑动条 0–4×）
 */
function setGameSpeed(v) {
  const val = Number(v);
  gameSpeed = Number.isFinite(val) ? Math.max(0, Math.min(4, val)) : 1;
  const label = document.getElementById('speedLabel');
  if (label) label.textContent = gameSpeed === 0 ? '暂停' : gameSpeed.toFixed(2).replace(/0$/, '') + '×';
  const slider = document.getElementById('speedSlider');
  if (slider && Number(slider.value) !== gameSpeed) slider.value = String(gameSpeed);
  // 速度为 0 时也要把暂停按钮状态同步，避免出现"没暂停但不动"的困惑
  if (gameSpeed === 0 && !gamePaused) {
    gamePaused = true;
    const btn = document.getElementById('pauseBtn');
    if (btn) { btn.textContent = '继续'; btn.classList.add('paused'); }
  }
}

/**
 * 追加本局 token 额度（默认 +5 万）并立刻解除超限降级
 * —— 激战正酣时被降级最扫兴，所以要能一键续上
 */
function addTokenBudget(amount) {
  if (!sandboxConfig || !agentManager) return;
  const step = amount || 50000;
  const newCap = (sandboxConfig.budget.maxTokensPerGame || 0) + step;
  sandboxConfig.budget.maxTokensPerGame = newCap;
  saveConfig(sandboxConfig);            // 持久化，刷新后不回到旧额度
  const resumed = agentManager.setBudgetCap(newCap);
  const wan = Math.round(step / 10000);
  notify('已追加 ' + wan + ' 万 token 额度（本局上限 ' + Math.round(newCap / 10000) + ' 万）' +
    (resumed ? '，成员恢复思考' : ''), 'info');
  if (chatPanel) {
    chatPanel.addSystem('【系统】额度 +' + wan + ' 万 → 本局上限 ' + Math.round(newCap / 10000) + ' 万' +
      (resumed ? '，成员已恢复 LLM 决策' : ''));
  }
  updateHud();
}

/** 结束本局：停止推进并弹出结算（保留战报，方便回看本局消耗） */
function endGame() {
  if (!gameState || !gameRunning) return;
  gameState.winner = -1;
  gameState.gameOver = true;
  if (agentManager) agentManager.abortGame();
  notify('本局已结束', 'info');
}

/** 重新开始：整页重载（最稳的复位方式，配置与额度都会按最新值重读） */
function restartGame() {
  location.reload();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function(err) {
      notify('\u5168\u5c4f\u5931\u8d25: ' + err.message, 'warn');
    });
  } else {
    document.exitFullscreen();
  }
}

function showHelp() { ui.showHelp(); }
function hideHelp() { ui.hideHelp(); }

function notify(text, kind) {
  ui.notify(text, kind);
}

function checkGameOver() {
  var stillRunning = ui.checkGameOver(gameState, gameStartTime, difficulty, gameRunning);
  if (!stillRunning) gameRunning = false;
}

function findEntityById(id) {
  for (var i = 0; i < gameState.entities.length; i++) if (gameState.entities[i].id === id) return gameState.entities[i];
  return null;
}

function setGroup(n) {
  var sel = input ? input._callbacks.selectedUnits : selectedUnits;
  if (sel.length === 0) return;
  gameState.controlGroups[n] = sel.map(function(u) { return u.id; });
  notify('\u7f16\u961f ' + n + ' \u5df2\u8bbe\u7f6e (' + sel.length + '\u4e2a\u5355\u4f4d)', 'info');
  ui.renderGroupBar(gameState);
}

function selectGroup(n) {
  var ids = gameState.controlGroups[n];
  if (!ids || ids.length === 0) return;
  var sel = input ? input._callbacks.selectedUnits : selectedUnits;
  sel.forEach(function(u) { u.selected = false; });
  sel.length = 0;
  var sb = input ? input._callbacks.selectedBuilding : selectedBuilding;
  if (sb) { sb.selected = false; if (input) input._callbacks.selectedBuilding = null; else selectedBuilding = null; }
  ids.forEach(function(id) {
    var e = findEntityById(id);
    if (e && !e.dead && !e.isBuilding) { e.selected = true; sel.push(e); }
  });
  var now = Date.now();
  var lastNumberKey = input ? input.lastNumberKey : 0;
  var lastNumberTime = input ? input.lastNumberTime : 0;
  if (lastNumberKey === n && now - lastNumberTime < 400) {
    if (sel.length > 0) {
      var cx = sel.reduce(function(s, u) { return s + u.x; }, 0) / sel.length;
      var cy = sel.reduce(function(s, u) { return s + u.y; }, 0) / sel.length;
      camera.x = cx * TILE_SIZE * camera.zoom - (canvas.width - 300) / 2;
      camera.y = cy * TILE_SIZE * camera.zoom - canvas.height / 2;
      camera.x = Math.max(0, Math.min(MAP_WIDTH * TILE_SIZE * camera.zoom - (canvas.width - 300), camera.x));
      camera.y = Math.max(0, Math.min(MAP_HEIGHT * TILE_SIZE * camera.zoom - canvas.height, camera.y));
    }
  }
  if (input) { input.lastNumberKey = n; input.lastNumberTime = now; }
  audioManager.playSelect();
}

function saveGame() {
  if (!gameState || !gameRunning) { notify('\u65e0\u6cd5\u5b58\u6863\uff1a\u6e38\u620f\u672a\u8fd0\u884c', 'warn'); return; }
  var ok = saveManager.save(gameState, camera, difficulty, frameCount, sandboxAI);
  if (ok) { notify('\u6e38\u620f\u5df2\u5b58\u6863', 'info'); audioManager.playBuild(); }
  else notify('\u5b58\u6863\u5931\u8d25', 'danger');
}

function loadGame() {
  var result = saveManager.load(null, canvas, minimapCanvas);
  if (!result) { notify('\u6ca1\u6709\u5b58\u6863\u6216\u5b58\u6863\u635f\u574f', 'warn'); return; }
  gameState = result.gameState;
  gameState._playExplosionSound = function() { audioManager.playExplosion(); };
  // 读档后同样保持上帝视角，并重建成员槽位（实体 id 已变）
  gameState.fogOfWar.enabled = false;
  memberSystem.init(gameState);
  memberPanel._sig = '';
  wireSuperWeaponCallbacks(gameState.superWeaponManager);
  gameState.superWeaponManager._statusCount = 0;
  for (var ssi = 0; ssi < gameState.entities.length; ssi++) {
    var sse = gameState.entities[ssi];
    if (sse.ironCurtain > 0 || sse.chronoStun > 0) gameState.superWeaponManager._statusCount++;
  }
  window.__game = gameState;
  if (ui._callbacks) ui._callbacks.gameState = gameState;
  ui._lastUI = {}; // 重置 DOM 缓存，确保读档后全量刷新一次
  camera = result.camera;
  // 关键：读档构造了全新的 GameState / camera，必须让输入层重新绑定，
  // 否则所有鼠标操作仍作用在读档前的旧世界上
  if (input) input.rebind(gameState, camera);
  difficulty = result.difficulty;
  frameCount = result.frameCount;
  var aiState = result.enemyAIState;
  if (aiState) {
    sandboxAI.attackWave = aiState.attackWave || 0;
    sandboxAI.aiTimer = aiState.aiTimer || 0;
    sandboxAI.buildQueue = aiState.buildQueue || [];
    sandboxAI.attackTimer = aiState.attackTimer || 0;
    sandboxAI.scoutTimer = aiState.scoutTimer || 0;
  }
  gameStartTime = result.gameStartTime;
  selectedUnits.length = 0;
  selectedBuilding = null;
  // 存档会还原 selected 标记，但选中列表已被清空，需同步清理，否则残留绿色选中框
  for (var cli = 0; cli < gameState.entities.length; cli++) gameState.entities[cli].selected = false;
  placingBuilding = false;
  placingType = null;
  gameRunning = true;
  gamePaused = false;
  gameSpeed = 1;
  activeAction = null;
  if (input) {
    input.pendingAttackMove = false;
    input._callbacks.selectedUnits = selectedUnits;
    input._callbacks.selectedBuilding = selectedBuilding;
    input._callbacks.placingBuilding = placingBuilding;
    input._callbacks.placingType = placingType;
    input._callbacks.activeAction = activeAction;
    input._callbacks.superWeaponTargeting = null;
  }
  document.getElementById('startScreen').style.display = 'none';
  document.getElementById('gameOver').style.display = 'none';
  ui.renderGroupBar(gameState);
  ui.updateBuildList(gameState);
  notify('\u6e38\u620f\u5df2\u8bfb\u6863', 'info');
  audioManager.playBuild();
}

window.startGame = startGame;
window.togglePause = togglePause;
window.setGameSpeed = setGameSpeed;
window.addTokenBudget = addTokenBudget;
window.endGame = endGame;
window.restartGame = restartGame;
window.toggleFullscreen = toggleFullscreen;
window.showHelp = showHelp;
window.hideHelp = hideHelp;
window.toggleAction = toggleAction;
window.commandStop = commandStop;
window.switchTab = function(tab) { ui.switchTab(tab); };
window.saveGame = saveGame;
window.loadGame = loadGame;
