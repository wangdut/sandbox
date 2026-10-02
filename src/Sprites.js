// 单位与建筑的精灵绘制
//
// 从 Renderer.js 外提出来的两个巨型方法（合计约 640 行）——它们本质上不依赖
// Renderer 实例状态（原本各只有一处 this.ctx），依赖早已全部通过参数传递，
// 因此改成显式接收 ctx 即可，绘制逻辑一行未改。
// Renderer 里保留同名薄封装，render() 的调用点不受影响。
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, GRASS, WATER, ORE, ROCK, CONCRETE, SAND, TREE,
         TEAM_PLAYER, TEAM_ENEMY, COLOR_PLAYER, COLOR_PLAYER_DARK, COLOR_ENEMY, COLOR_ENEMY_DARK,
         COLOR_ALLIED, COLOR_ALLIED_DARK, COLOR_SOVIET, COLOR_SOVIET_DARK, TYPE_AIRCRAFT, TYPE_HELICOPTER, TYPE_AIRSHIP } from './constants.js';
import { BUILDING_DEFS, DEFENSE_DEFS, UNIT_DEFS, SUPER_WEAPONS, FACTION_ALLIED, FACTION_SOVIET } from './definitions.js';
import { FPS } from './constants.js';

// 沙盘中实际出现的建筑：走 C3 精细重绘路径（离屏预渲染 + 矢量细节）
const HD_BUILDINGS = { base: 1, pillbox: 1, turret: 1, aaNest: 1, highrise: 1 };

export function drawBuilding(ctx, e, ex, ey2, eS, tc, td, gameState, frameCount) {
  if (!HD_BUILDINGS[e.type]) {
    drawBuildingLegacy(ctx, e, ex, ey2, eS, tc, td, gameState, frameCount);
    return;
  }
  if (!e.built) ctx.globalAlpha = (ctx.globalAlpha || 1) * (0.35 + e.buildProgress / 100 * 0.65);
  hdDrawBuilding(ctx, e, ex, ey2, eS, tc, td, frameCount);
  if (!e.built) ctx.globalAlpha = 1;

  // Build progress
  if (!e.built) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(ex, ey2, eS, eS);
    ctx.fillStyle = '#f1c40f';
    ctx.fillRect(ex + 2, ey2 + eS - 7, (eS - 4) * (e.buildProgress / 100), 5);
    ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1;
    ctx.strokeRect(ex + 2, ey2 + eS - 7, eS - 4, 5);
    ctx.font = '10px Arial'; ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(Math.floor(e.buildProgress) + '%', ex + eS / 2, ey2 + eS / 2 + 4);
    ctx.textAlign = 'left';
  }

  // Production progress
  if (e.producing) {
    var pb = e.produceProgress / 100;
    ctx.fillStyle = 'rgba(46,204,113,0.9)';
    ctx.fillRect(ex + 2, ey2 - 7, (eS - 4) * pb, 5);
    ctx.strokeStyle = 'rgba(46,204,113,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ex + 2, ey2 - 7, eS - 4, 5);
    if (e.productionQueue.length > 0) {
      ctx.fillStyle = '#f1c40f';
      ctx.font = 'bold 10px Arial';
      ctx.fillText('+' + e.productionQueue.length, ex + eS - 12, ey2 - 9);
    }
  }
}

function drawBuildingLegacy(ctx, e, ex, ey2, eS, tc, td, gameState, frameCount) {
  if (!e.built) ctx.globalAlpha = (ctx.globalAlpha || 1) * (0.35 + e.buildProgress / 100 * 0.65);

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(ex + 3, ey2 + 3, eS, eS);
  ctx.fillStyle = td; ctx.fillRect(ex, ey2, eS, eS);
  ctx.fillStyle = tc; ctx.fillRect(ex + 2, ey2 + 2, eS - 4, eS - 4);

  switch (e.type) {
    case 'base':
      ctx.fillStyle = '#5d6d7e';
      ctx.fillRect(ex + eS * 0.12, ey2 + eS * 0.12, eS * 0.76, eS * 0.76);
      ctx.fillStyle = tc;
      ctx.fillRect(ex + eS * 0.22, ey2 + eS * 0.22, eS * 0.56, eS * 0.56);
      ctx.fillStyle = '#aaa'; ctx.fillRect(ex + eS * 0.15, ey2 + 8, 2, eS * 0.45);
      ctx.fillStyle = '#ccc'; ctx.fillRect(ex + eS * 0.13, ey2 + 8, 6, 2);
      var fy = ey2 + 10 + Math.sin(frameCount * 0.08) * 3;
      ctx.fillStyle = tc; ctx.fillRect(ex + eS - 14, fy, 12, 8);
      ctx.fillStyle = '#fff'; ctx.fillRect(ex + eS - 14, fy, 12, 2);
      ctx.fillStyle = '#888'; ctx.fillRect(ex + eS - 15, ey2 + 5, 2, eS * 0.55);
      // Door
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(ex + eS * 0.4, ey2 + eS * 0.6, eS * 0.2, eS * 0.25);
      break;
    case 'powerPlant':
      ctx.fillStyle = '#f1c40f';
      ctx.fillRect(ex + eS * 0.18, ey2 + eS * 0.35, eS * 0.64, eS * 0.52);
      ctx.fillStyle = '#555';
      ctx.fillRect(ex + eS * 0.28, ey2 + 5, 7, eS * 0.38);
      ctx.fillRect(ex + eS * 0.6, ey2 + 5, 7, eS * 0.38);
      if (e.built) {
        var sr = 5 + Math.sin(frameCount * 0.07) * 2;
        ctx.fillStyle = 'rgba(241,196,15,0.4)';
        ctx.beginPath(); ctx.arc(ex + eS * 0.315, ey2 + 4, sr, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ex + eS * 0.635, ey2 + 4, sr, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'refinery':
      ctx.fillStyle = '#e67e22';
      ctx.fillRect(ex + 4, ey2 + 4, eS - 8, eS - 8);
      ctx.fillStyle = '#d35400';
      ctx.fillRect(ex + eS * 0.55, ey2 + eS * 0.08, eS * 0.35, eS * 0.45);
      ctx.fillStyle = '#f39c12';
      ctx.beginPath(); ctx.arc(ex + eS * 0.33, ey2 + eS * 0.55, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#555';
      ctx.fillRect(ex + eS * 0.1, ey2 + eS * 0.7, eS * 0.8, 5);
      break;
    case 'barracks':
      ctx.fillStyle = '#27ae60';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#145a32';
      ctx.fillRect(ex + eS * 0.08, ey2 + eS * 0.08, eS * 0.84, eS * 0.25);
      ctx.fillStyle = '#1e8449';
      ctx.fillRect(ex + eS * 0.08, ey2 + eS * 0.55, eS * 0.22, eS * 0.35);
      ctx.fillRect(ex + eS * 0.38, ey2 + eS * 0.55, eS * 0.22, eS * 0.35);
      ctx.fillStyle = '#aaa';
      ctx.fillRect(ex + eS * 0.25, ey2 + eS * 0.55, eS * 0.12, eS * 0.3);
      break;
    case 'warFactory':
      ctx.fillStyle = '#5b2c6f';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#6c3483';
      ctx.fillRect(ex + eS * 0.04, ey2 + eS * 0.5, eS * 0.92, eS * 0.44);
      ctx.fillStyle = '#333';
      ctx.fillRect(ex + eS * 0.08, ey2 + eS * 0.55, eS * 0.35, eS * 0.38);
      ctx.fillStyle = '#999';
      ctx.fillRect(ex + eS * 0.65, ey2 + eS * 0.08, 5, eS * 0.45);
      ctx.fillRect(ex + eS * 0.5, ey2 + eS * 0.08, eS * 0.3, 4);
      ctx.fillStyle = '#555';
      ctx.fillRect(ex + eS * 0.1, ey2 + 8, 6, 18);
      ctx.fillRect(ex + eS * 0.22, ey2 + 5, 6, 22);
      break;
    case 'radar':
      ctx.fillStyle = '#1a252f';
      ctx.fillRect(ex + 4, ey2 + 4, eS - 8, eS - 8);
      ctx.fillStyle = tc;
      ctx.fillRect(ex + eS * 0.18, ey2 + eS * 0.35, eS * 0.64, eS * 0.45);
      if (e.built) {
        ctx.save();
        ctx.translate(ex + eS * 0.5, ey2 + eS * 0.4);
        ctx.rotate(frameCount * 0.04);
        ctx.fillStyle = '#5dade2';
        ctx.fillRect(-14, -2, 28, 4);
        ctx.fillRect(-2, -14, 4, 28);
        ctx.fillStyle = 'rgba(93,173,226,0.4)';
        ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 0.5); ctx.lineTo(0, 0); ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#333';
        ctx.beginPath(); ctx.arc(ex + eS * 0.5, ey2 + eS * 0.4, 4, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'alliedTech':
    case 'sovietTech': {
      var techBase = e.type === 'alliedTech' ? '#0e6655' : '#641e16';
      var techGlow = e.type === 'alliedTech' ? '#1abc9c' : '#e74c3c';
      ctx.fillStyle = techBase;
      ctx.fillRect(ex + 4, ey2 + 4, eS - 8, eS - 8);
      ctx.fillStyle = techGlow;
      ctx.fillRect(ex + eS * 0.12, ey2 + eS * 0.12, eS * 0.76, eS * 0.28);
      for (var di = 0; di < 3; di++) {
        ctx.fillStyle = techGlow === '#1abc9c' ? 'rgba(26,188,156,0.7)' : 'rgba(231,76,60,0.7)';
        ctx.beginPath();
        ctx.arc(ex + eS * (0.25 + di * 0.25), ey2 + eS * 0.65, 6 + Math.sin(frameCount * 0.08 + di) * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (e.built && frameCount % 15 < 7) {
        ctx.fillStyle = techGlow === '#1abc9c' ? 'rgba(26,188,156,0.2)' : 'rgba(231,76,60,0.2)';
        ctx.beginPath(); ctx.arc(ex + eS * 0.5, ey2 + eS * 0.5, eS * 0.55, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'orePurifier':
      ctx.fillStyle = '#7d6608';
      ctx.fillRect(ex + 4, ey2 + 4, eS - 8, eS - 8);
      ctx.fillStyle = '#b7950b';
      ctx.fillRect(ex + eS * 0.15, ey2 + eS * 0.15, eS * 0.7, eS * 0.7);
      // 漏斗与金流
      ctx.fillStyle = '#f1c40f';
      ctx.beginPath();
      ctx.moveTo(ex + eS * 0.3, ey2 + eS * 0.2);
      ctx.lineTo(ex + eS * 0.7, ey2 + eS * 0.2);
      ctx.lineTo(ex + eS * 0.55, ey2 + eS * 0.5);
      ctx.lineTo(ex + eS * 0.55, ey2 + eS * 0.7);
      ctx.lineTo(ex + eS * 0.45, ey2 + eS * 0.7);
      ctx.lineTo(ex + eS * 0.45, ey2 + eS * 0.5);
      ctx.closePath(); ctx.fill();
      if (e.built && frameCount % 30 < 15) {
        ctx.fillStyle = 'rgba(241,196,15,0.35)';
        ctx.fillRect(ex + eS * 0.42, ey2 + eS * 0.72, eS * 0.16, eS * 0.14);
      }
      break;
    case 'nukeSilo':
      ctx.fillStyle = '#4a1518';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#2c0d0f';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, eS * 0.36, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#7f8c8d'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, eS * 0.36, 0, Math.PI * 2); ctx.stroke();
      // 辐射标志
      ctx.fillStyle = '#f1c40f';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, eS * 0.2, 0.5, 1.6); ctx.lineTo(ex + eS / 2, ey2 + eS / 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, eS * 0.2, 2.6, 3.7); ctx.lineTo(ex + eS / 2, ey2 + eS / 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, eS * 0.2, 4.7, 5.8); ctx.lineTo(ex + eS / 2, ey2 + eS / 2); ctx.fill();
      if (e.built) {
        var siloGlow = 0.3 + Math.sin(frameCount * 0.06) * 0.2;
        ctx.fillStyle = 'rgba(231,76,60,' + siloGlow + ')';
        ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, eS * 0.46, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'ironCurtain':
      ctx.fillStyle = '#4a235a';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#8e44ad';
      ctx.fillRect(ex + eS / 2 - 5, ey2 + eS * 0.3, 10, eS * 0.45);
      ctx.fillStyle = '#d7bde2';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS * 0.25, 6, 0, Math.PI * 2); ctx.fill();
      if (e.built && frameCount % 20 < 10) {
        ctx.strokeStyle = 'rgba(142,68,173,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, eS * 0.42, frameCount * 0.05, frameCount * 0.05 + 2); ctx.stroke();
      }
      break;
    case 'weatherControl':
      ctx.fillStyle = '#4a3b8f';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#9b59b6';
      ctx.fillRect(ex + eS * 0.15, ey2 + eS * 0.45, eS * 0.7, eS * 0.35);
      // 云朵
      ctx.fillStyle = '#d2b4de';
      ctx.beginPath(); ctx.arc(ex + eS * 0.35, ey2 + eS * 0.3, eS * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + eS * 0.55, ey2 + eS * 0.25, eS * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + eS * 0.68, ey2 + eS * 0.32, eS * 0.11, 0, Math.PI * 2); ctx.fill();
      if (e.built && frameCount % 25 < 6) {
        ctx.strokeStyle = '#f4ecf7'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ex + eS * 0.5, ey2 + eS * 0.4);
        ctx.lineTo(ex + eS * 0.45, ey2 + eS * 0.6);
        ctx.lineTo(ex + eS * 0.55, ey2 + eS * 0.58);
        ctx.lineTo(ex + eS * 0.48, ey2 + eS * 0.8);
        ctx.stroke();
      }
      break;
    case 'chronosphere':
      ctx.fillStyle = '#0b3c5d';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#154360';
      ctx.fillRect(ex + eS * 0.2, ey2 + eS * 0.5, eS * 0.6, eS * 0.3);
      ctx.save();
      ctx.translate(ex + eS / 2, ey2 + eS * 0.35);
      ctx.rotate(frameCount * 0.06);
      ctx.strokeStyle = '#00bfff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, eS * 0.26, 0, Math.PI * 1.4); ctx.stroke();
      ctx.rotate(Math.PI);
      ctx.beginPath(); ctx.arc(0, 0, eS * 0.26, 0, Math.PI * 1.4); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#aef0ff';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS * 0.35, 3 + Math.sin(frameCount * 0.1) * 1.5, 0, Math.PI * 2); ctx.fill();
      break;
    case 'repairBay':
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(ex + 4, ey2 + 4, eS - 8, eS - 8);
      ctx.fillStyle = '#566573';
      ctx.fillRect(ex + eS * 0.15, ey2 + eS * 0.15, eS * 0.7, eS * 0.7);
      // Wrench icon
      ctx.fillStyle = '#f1c40f';
      ctx.fillRect(ex + eS * 0.4, ey2 + eS * 0.3, eS * 0.2, eS * 0.4);
      ctx.fillRect(ex + eS * 0.3, ey2 + eS * 0.32, eS * 0.4, eS * 0.08);
      ctx.fillStyle = '#888';
      // Floor markings
      ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(ex + eS * 0.1, ey2 + eS * 0.7, eS * 0.8, eS * 0.18);
      ctx.setLineDash([]);
      break;
    case 'wall':
      ctx.fillStyle = '#7f8c8d';
      ctx.fillRect(ex + 1, ey2 + 1, eS - 2, eS - 2);
      ctx.fillStyle = '#566573';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      // Stones
      ctx.fillStyle = '#95a5a6';
      ctx.fillRect(ex + 4, ey2 + 4, eS / 2 - 5, eS / 2 - 5);
      ctx.fillRect(ex + eS / 2 + 1, ey2 + 4, eS / 2 - 5, eS / 2 - 5);
      ctx.fillRect(ex + 4, ey2 + eS / 2 + 1, eS / 2 - 5, eS / 2 - 5);
      ctx.fillRect(ex + eS / 2 + 1, ey2 + eS / 2 + 1, eS / 2 - 5, eS / 2 - 5);
      break;
    case 'pillbox':
      ctx.fillStyle = td;
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = tc;
      ctx.fillRect(ex + 7, ey2 + 7, eS - 14, eS - 14);
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.fillRect(ex + eS / 2 - 1, ey2 + 5, 3, eS / 2 - 5);
      break;
    case 'turret':
      ctx.fillStyle = td;
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = tc;
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, 13, 0, Math.PI * 2); ctx.fill();
      // Use cached turret angle from update phase
      var turretAngle = e.renderTurretAngle || 0;
      ctx.save();
      ctx.translate(ex + eS / 2, ey2 + eS / 2);
      ctx.rotate(turretAngle);
      ctx.fillStyle = '#222';
      ctx.fillRect(0, -3, 18, 6);
      ctx.restore();
      ctx.fillStyle = '#555';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, 6, 0, Math.PI * 2); ctx.fill();
      break;
    case 'tesla':
      // 磁暴线圈 - 苏联
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#8e44ad';
      ctx.fillRect(ex + eS / 2 - 4, ey2 + 4, 8, eS / 2 - 3);
      ctx.fillStyle = '#00bfff';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + 8, 8, 0, Math.PI * 2); ctx.fill();
      if (e.built && e.fireCooldown > e.fireRate - 8) {
        ctx.strokeStyle = 'rgba(0,191,255,0.9)';
        ctx.lineWidth = 2;
        for (var li = 0; li < 4; li++) {
          ctx.beginPath(); ctx.moveTo(ex + eS / 2, ey2 + 6);
          var lx2 = ex + eS / 2 + (Math.random() - 0.5) * 25;
          var ly2 = ey2 + 6 - Math.random() * 20;
          ctx.lineTo(lx2, ly2); ctx.stroke();
        }
      }
      break;
    case 'prismTower':
      // 光棱塔 - 盟军
      ctx.fillStyle = '#34495e';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#9b59b6';
      ctx.beginPath();
      ctx.moveTo(ex + eS / 2, ey2 + 4);
      ctx.lineTo(ex + eS - 6, ey2 + eS - 6);
      ctx.lineTo(ex + 6, ey2 + eS - 6);
      ctx.fill();
      ctx.fillStyle = '#e91e63';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + 10, 6, 0, Math.PI * 2); ctx.fill();
      // 充能效果
      if (e.built && e.fireCooldown > e.fireRate - 10) {
        ctx.strokeStyle = 'rgba(233,30,99,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ex + eS / 2, ey2 + 10);
        ctx.lineTo(ex + eS / 2 + (Math.random() - 0.5) * 30, ey2 + 10 - Math.random() * 25);
        ctx.stroke();
      }
      break;
    case 'patriot':
      // 爱国者导弹 - 盟军防空
      ctx.fillStyle = '#34495e';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#3498db';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, 10, 0, Math.PI * 2); ctx.fill();
      var aaAngle = e.renderTurretAngle || 0;
      ctx.save();
      ctx.translate(ex + eS / 2, ey2 + eS / 2);
      ctx.rotate(aaAngle);
      ctx.fillStyle = '#ecf0f1';
      ctx.fillRect(0, -2, 14, 4);
      ctx.restore();
      break;
    case 'flakCannon':
      // 高射炮 - 苏联防空
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(ex + 3, ey2 + 3, eS - 6, eS - 6);
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.arc(ex + eS / 2, ey2 + eS / 2, 11, 0, Math.PI * 2); ctx.fill();
      var flakAngle = e.renderTurretAngle || 0;
      ctx.save();
      ctx.translate(ex + eS / 2, ey2 + eS / 2);
      ctx.rotate(flakAngle);
      ctx.fillStyle = '#222';
      ctx.fillRect(0, -4, 12, 3);
      ctx.fillRect(0, 1, 12, 3);
      ctx.restore();
      break;
    case 'highrise': {
      // 中立高楼：向上拔高，营造城市天际线（可摧毁的掩体）
      ctx.fillStyle = '#3c4657';
      ctx.fillRect(ex + 6, ey2 - 34, eS - 12, eS + 28);
      ctx.fillStyle = '#26303f';
      ctx.fillRect(ex + 6, ey2 - 34, eS - 12, 5);
      ctx.fillStyle = 'rgba(150,200,235,0.5)';
      for (var wy = -30; wy < eS - 4; wy += 11) {
        for (var wx = 12; wx < eS - 16; wx += 11) {
          ctx.fillRect(ex + wx, ey2 + wy, 5, 6);
        }
      }
      break;
    }
  }

  // Build progress
  if (!e.built) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(ex, ey2, eS, eS);
    ctx.fillStyle = '#f1c40f';
    ctx.fillRect(ex + 2, ey2 + eS - 7, (eS - 4) * (e.buildProgress / 100), 5);
    ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1;
    ctx.strokeRect(ex + 2, ey2 + eS - 7, eS - 4, 5);
    ctx.font = '10px Arial'; ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(Math.floor(e.buildProgress) + '%', ex + eS / 2, ey2 + eS / 2 + 4);
    ctx.textAlign = 'left';
  }

  // Production progress
  if (e.producing) {
    var pb = e.produceProgress / 100;
    ctx.fillStyle = 'rgba(46,204,113,0.9)';
    ctx.fillRect(ex + 2, ey2 - 7, (eS - 4) * pb, 5);
    ctx.strokeStyle = 'rgba(46,204,113,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ex + 2, ey2 - 7, eS - 4, 5);
    // Queue indicator
    if (e.productionQueue.length > 0) {
      ctx.fillStyle = '#f1c40f';
      ctx.font = 'bold 10px Arial';
      ctx.fillText('+' + e.productionQueue.length, ex + eS - 12, ey2 - 9);
    }
  }
}

export const MEMBER_LABEL_FONT = 13;   // 沙盘内成员名字字号（较旧版 9px 放大约 44%，配合 C3 的 +35% 目标）
const MEMBER_LABEL_GAP = 4;            // 名字行与血条之间的垂直间隔
const MEMBER_LABEL_BAR_H = 4;          // 血条高度

/** 成员标签（名字行 + 血条）的总高度，供上层（气泡等）计算避让 */
export function memberLabelHeight(fontPx) {
  return (fontPx || MEMBER_LABEL_FONT) + MEMBER_LABEL_GAP + MEMBER_LABEL_BAR_H;
}

/**
 * 统一的成员标签：名字在上、血条在下，垂直分布绝不重叠
 * @param topY 标签块顶边（名字基线 = topY + fontPx）
 * @returns 标签块总高度
 */
export function drawMemberLabel(ctx, cx, topY, name, hpFrac, color, fontPx) {
  const fp = fontPx || MEMBER_LABEL_FONT;
  ctx.font = 'bold ' + fp + 'px "Microsoft YaHei", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, cx, topY + fp);
  ctx.fillStyle = color || '#f1c40f';
  ctx.fillText(name, cx, topY + fp);
  const bw = 26, bh = MEMBER_LABEL_BAR_H, bx = cx - bw / 2, by = topY + fp + MEMBER_LABEL_GAP;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(bx, by, bw, bh);
  const r = Math.max(0, Math.min(1, hpFrac));
  ctx.fillStyle = r > 0.6 ? '#2ecc71' : (r > 0.3 ? '#f39c12' : '#e74c3c');
  ctx.fillRect(bx, by, bw * r, bh);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  ctx.textAlign = 'left';
  return memberLabelHeight(fp);
}

const HD_MOUNTS = { tank: 1, apc: 1, gunship: 1, bomber: 1 };

export function drawUnit(ctx, e, ex, ey2, tc, td, frameCount) {
  var kind = e.mountType || e.type;
  if (e.type2 === 'infantry' || HD_MOUNTS[kind]) {
    hdDrawUnit(ctx, e, ex, ey2, tc, td, frameCount, kind);
    return;
  }
  drawUnitLegacy(ctx, e, ex, ey2, tc, td, frameCount);
}

function drawUnitLegacy(ctx, e, ex, ey2, tc, td, frameCount) {
  var ux = ex + TILE_SIZE / 2, uy = ey2 + TILE_SIZE / 2;
  
  // 空军单位绘制阴影在地面
  if (e.isAirUnit) {
    var shadowY = uy + 15 + Math.sin(frameCount * 0.1) * 3;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(ux, shadowY, 12, 6, 0, 0, Math.PI * 2); ctx.fill();
    // 空军单位在更高位置绘制
    uy -= 15 + Math.sin(frameCount * 0.1) * 5;
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(ux, uy + 8, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
  }

  if (e.type2 === 'infantry') {
    // 虚拟成员：金色光环 + 名字 + 武器标识，便于在混战中一眼识别
    if (e.isMember) {
      var isRocket = e.weaponMode === 'rocket';
      var mlo = Math.sin(e.animFrame * Math.PI / 2) * 3;
      ctx.strokeStyle = '#f1c40f';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(ux, uy + 7, 9, 4.5, 0, 0, Math.PI * 2); ctx.stroke();
      // 身体与头部（沿用阵营色）
      ctx.fillStyle = tc;
      ctx.fillRect(ux - 4.5, uy - 8, 9, 11);
      ctx.fillStyle = '#c8a87a';
      ctx.beginPath(); ctx.arc(ux, uy - 12, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = td;
      ctx.beginPath(); ctx.arc(ux, uy - 13, 5, Math.PI, 0); ctx.fill();
      // 腿部
      ctx.fillRect(ux - 3, uy + 3, 3, 6 + mlo);
      ctx.fillRect(ux, uy + 3, 3, 6 - mlo);
      // 武器
      if (isRocket) {
        ctx.fillStyle = '#888'; ctx.fillRect(ux + 4, uy - 6, 10, 3);
        ctx.fillStyle = '#c0392b'; ctx.fillRect(ux + 12, uy - 8, 3, 7);
      } else {
        ctx.fillStyle = '#333'; ctx.fillRect(ux + 4, uy - 3, 10, 2.5);
      }
      // 名字 + 血条统一标签：上下分布，头部上方，绝不与精灵或气泡重叠
      drawMemberLabel(ctx, ux, uy - 20 - memberLabelHeight(MEMBER_LABEL_FONT), e.memberName || '', e.hp / e.maxHp, '#f1c40f', MEMBER_LABEL_FONT);
      return;
    }
    var lo = Math.sin(e.animFrame * Math.PI / 2) * 3;
    ctx.fillStyle = tc;
    ctx.fillRect(ux - 4, uy - 7, 8, 10);
    ctx.fillStyle = '#c8a87a';
    ctx.beginPath(); ctx.arc(ux, uy - 11, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = td;
    ctx.beginPath(); ctx.arc(ux, uy - 12, 5, Math.PI, 0); ctx.fill();
    ctx.fillStyle = td;
    ctx.fillRect(ux - 3, uy + 3, 3, 6 + lo);
    ctx.fillRect(ux, uy + 3, 3, 6 - lo);
    if (e.type === 'rocket') {
      ctx.fillStyle = '#888'; ctx.fillRect(ux + 4, uy - 5, 9, 3);
      ctx.fillStyle = '#c0392b'; ctx.fillRect(ux + 11, uy - 7, 3, 7);
    } else if (e.type === 'engineer') {
      ctx.fillStyle = '#f39c12'; ctx.fillRect(ux + 4, uy - 2, 9, 5);
      ctx.fillStyle = '#ccc'; ctx.fillRect(ux + 11, uy - 4, 3, 3);
      // Hard hat
      ctx.fillStyle = '#f1c40f';
      ctx.beginPath(); ctx.arc(ux, uy - 13, 4, Math.PI, 0); ctx.fill();
    } else {
      ctx.fillStyle = '#333'; ctx.fillRect(ux + 4, uy - 3, 9, 2.5);
    }
  } else if (e.type2 === 'vehicle' || e.type2 === 'harvester') {
    if (e.type === 'arty') {
      ctx.fillStyle = '#222'; ctx.fillRect(ux - 11, uy + 1, 22, 7);
      ctx.fillStyle = td; ctx.fillRect(ux - 9, uy - 5, 18, 8);
      ctx.fillStyle = tc; ctx.fillRect(ux - 6, uy - 7, 12, 5);
      ctx.fillStyle = '#222';
      ctx.save();
      ctx.translate(ux, uy - 3);
      ctx.rotate(e.turretDir - 0.3);
      ctx.fillRect(0, -2, 20, 4);
      ctx.restore();
    } else if (e.type2 === 'harvester') {
      ctx.fillStyle = '#333'; ctx.fillRect(ux - 11, uy + 1, 22, 7);
      ctx.fillStyle = td; ctx.fillRect(ux - 11, uy - 5, 22, 8);
      ctx.fillStyle = tc; ctx.fillRect(ux - 9, uy - 7, 18, 5);
      ctx.fillStyle = '#f1c40f'; ctx.fillRect(ux - 15, uy - 4, 6, 9);
      ctx.fillStyle = '#e67e22'; ctx.fillRect(ux - 16, uy - 2, 4, 5);
      if (e.ore > 0) {
        var oh = Math.min(7, (e.ore / e.capacity) * 7);
        ctx.fillStyle = '#f1c40f';
        ctx.fillRect(ux - 14, uy + 8 - oh, 2, oh);
      }
    } else if (e.type === 'grizzly') {
      // 灰熊坦克 - 盟军主战坦克
      var ts = 12;
      ctx.fillStyle = '#222';
      ctx.fillRect(ux - ts, uy + 2, ts * 2, 6);
      ctx.fillStyle = tc;
      ctx.fillRect(ux - ts + 1, uy - 3, ts * 2 - 2, 7);
      ctx.fillStyle = '#ecf0f1';
      ctx.beginPath(); ctx.arc(ux, uy, 7, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(ux, uy);
      ctx.rotate(e.turretDir);
      ctx.fillStyle = '#34495e';
      ctx.fillRect(0, -2, ts + 6, 4);
      ctx.restore();
    } else if (e.type === 'rhino') {
      // 犀牛坦克 - 苏联主战坦克
      var ts = 13;
      ctx.fillStyle = '#222';
      ctx.fillRect(ux - ts, uy + 2, ts * 2, 7);
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(ux - ts + 1, uy - 4, ts * 2 - 2, 8);
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.arc(ux, uy - 1, 8, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(ux, uy - 1);
      ctx.rotate(e.turretDir);
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(0, -2.5, ts + 5, 5);
      ctx.restore();
    } else if (e.type === 'apocalypse') {
      // 天启坦克 - 苏联终极坦克
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(ux - 16, uy + 3, 32, 8);
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(ux - 14, uy - 5, 28, 10);
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.arc(ux, uy - 1, 10, 0, Math.PI * 2); ctx.fill();
      // 双炮管
      ctx.save();
      ctx.translate(ux, uy - 3);
      ctx.rotate(e.turretDir);
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(0, -4, 16, 3);
      ctx.fillRect(0, 1, 16, 3);
      ctx.restore();
    } else if (e.type === 'prism') {
      // 光棱坦克
      ctx.fillStyle = '#222';
      ctx.fillRect(ux - 10, uy + 2, 20, 6);
      ctx.fillStyle = '#9b59b6';
      ctx.fillRect(ux - 9, uy - 3, 18, 7);
      ctx.save();
      ctx.translate(ux, uy);
      ctx.rotate(e.turretDir);
      // 光棱发射器
      ctx.fillStyle = '#e91e63';
      ctx.fillRect(0, -3, 14, 6);
      ctx.fillStyle = '#f8bbd9';
      ctx.fillRect(8, -1.5, 4, 3);
      ctx.restore();
    } else if (e.type === 'v3') {
      // V3火箭车
      ctx.fillStyle = '#222';
      ctx.fillRect(ux - 11, uy + 2, 22, 6);
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(ux - 10, uy - 3, 20, 7);
      ctx.save();
      ctx.translate(ux, uy - 2);
      ctx.rotate(e.turretDir - 0.5);
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(0, -2, 18, 4);
      // 火箭
      ctx.fillStyle = '#e74c3c';
      ctx.fillRect(14, -1.5, 8, 3);
      ctx.restore();
    } else if (e.type === 'ifv') {
      // 多功能步兵车
      ctx.fillStyle = '#222';
      ctx.fillRect(ux - 9, uy + 2, 18, 5);
      ctx.fillStyle = tc;
      ctx.fillRect(ux - 8, uy - 3, 16, 6);
      ctx.save();
      ctx.translate(ux, uy);
      ctx.rotate(e.turretDir);
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(0, -1.5, 10, 3);
      ctx.restore();
    } else if (e.type === 'flakTrack') {
      // 防空履带车
      ctx.fillStyle = '#222';
      ctx.fillRect(ux - 10, uy + 2, 20, 6);
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(ux - 9, uy - 3, 18, 7);
      ctx.save();
      ctx.translate(ux, uy);
      ctx.rotate(e.turretDir);
      ctx.fillStyle = '#8e44ad';
      ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(0, -2, 10, 4);
      ctx.restore();
    } else if (e.type === 'mirage') {
      // 幻影坦克 - 伪装成树
      if (e.stealthActive && e.team !== TEAM_PLAYER) {
        // 伪装成树
        ctx.fillStyle = '#2d5016';
        ctx.beginPath();
        ctx.moveTo(ux, uy - 15);
        ctx.lineTo(ux + 8, uy + 5);
        ctx.lineTo(ux - 8, uy + 5);
        ctx.fill();
        ctx.fillStyle = '#5d4037';
        ctx.fillRect(ux - 2, uy + 5, 4, 6);
      } else {
        ctx.fillStyle = '#27ae60';
        ctx.fillRect(ux - 10, uy + 2, 20, 6);
        ctx.save();
        ctx.translate(ux, uy);
        ctx.rotate(e.turretDir);
        ctx.fillStyle = '#2ecc71';
        ctx.fillRect(0, -2, 14, 4);
        ctx.restore();
      }
    } else if (e.type === 'warMiner') {
      // 苏联武装采矿车
      ctx.fillStyle = '#333';
      ctx.fillRect(ux - 12, uy + 2, 24, 7);
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(ux - 12, uy - 4, 24, 8);
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.arc(ux, uy - 1, 7, 0, Math.PI * 2); ctx.fill();
      // 机枪
      ctx.save();
      ctx.translate(ux + 8, uy - 2);
      ctx.rotate(e.turretDir);
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(0, -1, 8, 2);
      ctx.restore();
      if (e.ore > 0) {
        var oh = Math.min(7, (e.ore / e.capacity) * 7);
        ctx.fillStyle = '#f1c40f';
        ctx.fillRect(ux - 10, uy + 7 - oh, 3, oh);
      }
    } else if (e.type === 'tank') {
      // 主战坦克（可乘驾载具）
      ctx.fillStyle = '#222';
      ctx.fillRect(ux - 13, uy + 3, 26, 7);
      ctx.fillStyle = '#5d6d7e';
      ctx.fillRect(ux - 13, uy - 3, 26, 8);
      ctx.fillStyle = '#2c3e50';
      ctx.beginPath(); ctx.arc(ux, uy - 1, 7, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(ux, uy - 1);
      ctx.rotate(e.turretDir);
      ctx.fillStyle = '#1a252f';
      ctx.fillRect(0, -2, 17, 4);
      ctx.restore();
    } else if (e.type === 'apc') {
      // 装甲车（可乘驾载具）
      ctx.fillStyle = '#333';
      ctx.fillRect(ux - 11, uy + 3, 22, 6);
      ctx.fillStyle = '#7f8c8d';
      ctx.fillRect(ux - 11, uy - 4, 22, 8);
      ctx.fillStyle = '#95a5a6';
      ctx.fillRect(ux - 9, uy - 7, 18, 4);
      ctx.save();
      ctx.translate(ux, uy - 3);
      ctx.rotate(e.turretDir);
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(0, -1.5, 10, 3);
      ctx.restore();
    }
  } else if (e.isAirUnit) {
    // 空军单位渲染
    if (e.type2 === TYPE_AIRCRAFT) {
      // 战机
      ctx.fillStyle = tc;
      ctx.beginPath();
      ctx.moveTo(ux + 12, uy);
      ctx.lineTo(ux - 8, uy - 8);
      ctx.lineTo(ux - 5, uy);
      ctx.lineTo(ux - 8, uy + 8);
      ctx.fill();
      // 机翼
      ctx.fillStyle = td;
      ctx.beginPath();
      ctx.moveTo(ux, uy);
      ctx.lineTo(ux - 5, uy - 12);
      ctx.lineTo(ux + 3, uy);
      ctx.lineTo(ux - 5, uy + 12);
      ctx.fill();
    } else if (e.type2 === TYPE_HELICOPTER) {
      // 直升机
      ctx.fillStyle = tc;
      ctx.fillRect(ux - 10, uy - 4, 20, 8);
      // 旋翼
      ctx.fillStyle = '#333';
      var rotorOffset = Math.sin(frameCount * 0.5) * 2;
      ctx.fillRect(ux - 12, uy - 6 + rotorOffset, 24, 2);
      // 尾翼
      ctx.fillStyle = td;
      ctx.fillRect(ux - 14, uy - 2, 6, 4);
    } else if (e.type2 === TYPE_AIRSHIP) {
      // 基洛夫空艇
      ctx.fillStyle = '#c0392b';
      ctx.beginPath();
      ctx.ellipse(ux, uy, 20, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      // 吊舱
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(ux - 8, uy + 8, 16, 8);
      // 螺旋桨
      ctx.fillStyle = '#333';
      var propOffset = Math.sin(frameCount * 0.3) * 3;
      ctx.fillRect(ux - 15, uy - 12 + propOffset, 30, 2);
    }
  }

  // Muzzle flash
  if (e.muzzleFlash > 0) {
    var mdir = e.turretDir;
    var mfDist = (e.type2 === 'vehicle') ? 16 : 12;
    var mfx = ux + Math.cos(mdir) * mfDist;
    var mfy = uy + Math.sin(mdir) * mfDist;
    ctx.fillStyle = 'rgba(255,220,50,0.95)';
    ctx.beginPath(); ctx.arc(mfx, mfy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(mfx, mfy, 3, 0, Math.PI * 2); ctx.fill();
  }

  // Movement waypoint indicator
  if (e.selected && e.path.length > 0 && e.pathIndex < e.path.length) {
    var lastWP = e.path[e.path.length - 1];
    var wpX = (lastWP.x + 0.5) * TILE_SIZE;
    var wpY = (lastWP.y + 0.5) * TILE_SIZE;
    ctx.strokeStyle = 'rgba(46,204,113,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ux, uy);
    ctx.lineTo(wpX, wpY);
    ctx.stroke();
    ctx.setLineDash([]);
    // X marker
    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(wpX - 4, wpY - 4); ctx.lineTo(wpX + 4, wpY + 4);
    ctx.moveTo(wpX + 4, wpY - 4); ctx.lineTo(wpX - 4, wpY + 4);
    ctx.stroke();
  }
}

// ==================== C3 精细建模：离屏预渲染 + 矢量细节 ====================
// 每帧重建上百个渐变对象既慢又抖，因此把「静态部分」（车体、炮塔、建筑立面）预渲染成
// 2× 超采样位图（相机最大 zoom=2.0，正好 1:1 像素，放大不糊），只把会动的部分
//（旋翼、雷达碟、旗帜、炮塔后座、炮口焰、闪灯）实时叠画。

const SS = 2;
const _cache = new Map();
const UBOX = 56;   // 单位精灵盒（世界像素，局部原点=单位中心）
const TBOX = 64;   // 炮塔精灵盒（要装得下炮管）
const SBOX = 46;   // 步兵精灵盒

function _sprite(key, w, h, paint) {
  var cv = _cache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * SS));
  cv.height = Math.max(1, Math.round(h * SS));
  var g = cv.getContext('2d');
  g.scale(SS, SS);
  paint(g);
  _cache.set(key, cv);
  return cv;
}

function _unitSprite(key, box, paint) {
  return _sprite(key, box, box, function (g) { g.translate(box / 2, box / 2); paint(g); });
}

function _blit(ctx, cv, box, cx, cy, angle) {
  if (angle) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle);
    ctx.drawImage(cv, -box / 2, -box / 2, box, box);
    ctx.restore();
  } else {
    ctx.drawImage(cv, cx - box / 2, cy - box / 2, box, box);
  }
}

// ---------- 颜色工具 ----------
function _rgb(hex) { var n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function _hex(r, g, b) {
  function h(v) { var s = Math.max(0, Math.min(255, Math.round(v))).toString(16); return s.length < 2 ? '0' + s : s; }
  return '#' + h(r) + h(g) + h(b);
}
/** amt>0 向白提亮，amt<0 向黑压暗 */
function _sh(hex, amt) {
  if (!hex || hex.charAt(0) !== '#') return hex;
  var c = _rgb(hex), t = amt > 0 ? 255 : 0, k = Math.min(1, Math.abs(amt));
  return _hex(c[0] + (t - c[0]) * k, c[1] + (t - c[1]) * k, c[2] + (t - c[2]) * k);
}

// ---------- 矢量小工具 ----------
function _lg(g, x0, y0, x1, y1, c0, c1) {
  var gr = g.createLinearGradient(x0, y0, x1, y1);
  gr.addColorStop(0, c0); gr.addColorStop(1, c1); return gr;
}
function _rr(g, x, y, w, h, r) {
  var k = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + k, y);
  g.arcTo(x + w, y, x + w, y + h, k);
  g.arcTo(x + w, y + h, x, y + h, k);
  g.arcTo(x, y + h, x, y, k);
  g.arcTo(x, y, x + w, y, k);
  g.closePath();
}
/** 金属板：竖向渐变 + 深色描边 + 顶边高光 */
function _plate(g, x, y, w, h, r, top, bot, lw) {
  _rr(g, x, y, w, h, r);
  g.fillStyle = _lg(g, x, y, x, y + h, top, bot);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = lw || 1; g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x + r + 1, y + 1); g.lineTo(x + w - r - 1, y + 1); g.stroke();
}
function _dot(g, x, y, r, fill, stroke) {
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill; g.fill();
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
}
function _line(g, x0, y0, x1, y1, color, lw) {
  g.strokeStyle = color; g.lineWidth = lw || 1;
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
}
function _poly(g, pts, fill, stroke) {
  g.beginPath(); g.moveTo(pts[0], pts[1]);
  for (var i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
}
/** 铆钉：左上高光 + 右下阴影 */
function _rivet(g, x, y) {
  g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(x - 0.6, y - 0.6, 1.3, 1.3);
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(x, y, 1.1, 1.1);
}
/** 沙袋墙：一排交错椭圆（导出的原因：地形格「沙袋阵地」也复用同一套画法，见 Renderer） */
export function drawSandbagWall(g, x0, x1, y, rows) {
  for (var r = 0; r < rows; r++) {
    var yy = y + r * 3.4, off = (r % 2) * 3;
    for (var x = x0 + off; x < x1 - 2; x += 6.2) {
      g.beginPath(); g.ellipse(x + 3, yy, 3.4, 2, 0, 0, Math.PI * 2);
      g.fillStyle = r % 2 ? '#7d7355' : '#8a7f5f'; g.fill();
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 0.8; g.stroke();
    }
  }
}
/** 窗格：litSeed 决定哪些窗亮灯（同一建筑每次绘制一致） */
function _windows(g, x, y, cols, rows, cw, ch, gx, gy, litSeed) {
  for (var j = 0; j < rows; j++) {
    for (var i = 0; i < cols; i++) {
      var wx = x + i * (cw + gx), wy = y + j * (ch + gy);
      var lit = ((i * 73 + j * 151 + litSeed * 37) % 11) < 3;
      g.fillStyle = lit ? 'rgba(255,214,130,.88)' : 'rgba(96,132,164,.5)';
      g.fillRect(wx, wy, cw, ch);
      g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(wx, wy, cw, 1);
    }
  }
}

// ---------- 步兵 / 成员 ----------
function _paintSoldier(g, tc, td, weapon, hero) {
  var skin = '#d9a06b';
  // 腿与军靴
  g.fillStyle = _sh(td, -0.28);
  _rr(g, -4.2, 1, 3.6, 8.4, 1.4); g.fill();
  _rr(g, 0.7, 1, 3.6, 8.4, 1.4); g.fill();
  g.fillStyle = '#191920';
  _rr(g, -4.9, 8.6, 4.7, 3, 1.2); g.fill();
  _rr(g, 0.5, 8.6, 4.7, 3, 1.2); g.fill();
  // 躯干 + 战术背心
  _plate(g, -5.2, -6.6, 10.4, 12.6, 2.6, _sh(tc, 0.22), _sh(td, -0.18), 1);
  g.fillStyle = _sh(td, -0.42);
  _rr(g, -4.4, -5.2, 8.8, 8.8, 1.8); g.fill();
  g.fillStyle = _sh(td, -0.62);
  _rr(g, -3.7, -1.8, 3.1, 3.8, 0.9); g.fill();
  _rr(g, 0.7, -1.8, 3.1, 3.8, 0.9); g.fill();
  _line(g, -5.2, 2.9, 5.2, 2.9, 'rgba(0,0,0,.45)', 1.6);
  // 双臂
  g.fillStyle = _sh(tc, -0.06);
  _rr(g, -6.7, -5.6, 2.9, 6.2, 1.3); g.fill();
  _rr(g, 3.9, -5.6, 2.9, 5.4, 1.3); g.fill();
  // 颈、头、面部阴影
  g.fillStyle = _sh(skin, -0.3); g.fillRect(-1.4, -9, 2.8, 2.8);
  _dot(g, 0, -11.2, 3.5, skin, 'rgba(0,0,0,.35)');
  g.fillStyle = 'rgba(0,0,0,.22)';
  g.beginPath(); g.arc(0, -11.2, 3.5, -0.7, 1.5); g.fill();
  // 头盔：盔沿 + 渐变盔体 + 织物带
  g.fillStyle = _sh(td, -0.4); _rr(g, -5.3, -12.6, 10.6, 2.1, 1); g.fill();
  g.beginPath(); g.arc(0, -11.8, 5.1, Math.PI, 0);
  g.fillStyle = _lg(g, 0, -17, 0, -11.8, _sh(tc, 0.32), _sh(td, -0.08)); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1; g.stroke();
  _line(g, -4.7, -12.9, 4.7, -12.9, _sh(td, -0.5), 1.4);
  if (hero) {
    // 成员标识：金色贝雷带 + 肩章 + 头顶天线球（混战中一眼可辨）
    g.beginPath(); g.arc(0, -12.4, 5.1, Math.PI * 1.06, Math.PI * 1.94);
    g.fillStyle = '#f1c40f'; g.fill();
    _dot(g, -5.5, -4.8, 1.5, '#f1c40f', 'rgba(0,0,0,.5)');
    _line(g, 3.2, -15.8, 4.7, -19.6, 'rgba(241,196,15,.85)', 1);
    _dot(g, 4.9, -20.4, 1.6, '#f1c40f', 'rgba(0,0,0,.5)');
  }
  // 武器（一律指向 +X，与枪口朝向一致）
  if (weapon === 'rocket') {
    _plate(g, -3.2, -9, 20.4, 4.4, 2.1, '#7b8189', '#3a3f47', 1);
    g.fillStyle = '#262a31'; g.fillRect(3.6, -8.6, 3.4, 3.6);
    _poly(g, [16.6, -9.8, 23.4, -6.8, 16.6, -3.8], '#c0392b', 'rgba(0,0,0,.55)');
    g.fillStyle = '#4a5057'; g.fillRect(-5.8, -9.6, 3, 5.6);
    g.fillStyle = '#12161b'; g.fillRect(7.6, -11.4, 4.2, 2.5);
    _line(g, -1.5, -4.6, 1.5, -7.4, _sh(tc, -0.2), 2.2);
  } else {
    g.fillStyle = '#6b4a2b'; _rr(g, -3.8, -5.4, 4.8, 3.2, 1); g.fill();
    _plate(g, 0.6, -5.8, 8.8, 2.9, 0.9, '#3d424a', '#191c21', 1);
    g.fillStyle = '#22262c'; g.fillRect(9.2, -5.2, 8.6, 1.6);
    g.fillStyle = '#0f1114'; g.fillRect(17.4, -5.8, 2.4, 2.8);
    g.strokeStyle = '#2a2e35'; g.lineWidth = 1.1;
    g.beginPath(); g.moveTo(3.4, -6.4); g.lineTo(3.4, -8); g.lineTo(7.6, -8); g.lineTo(7.6, -6.4); g.stroke();
    g.fillStyle = '#2f343b'; _rr(g, 4.4, -3, 3.1, 4.6, 1); g.fill();
    _line(g, 12.2, -4.6, 10.6, -0.4, 'rgba(40,44,50,.9)', 1);
    _line(g, 12.2, -4.6, 14, -0.4, 'rgba(40,44,50,.9)', 1);
    _line(g, -1.6, -4.4, 3.4, -5.4, _sh(tc, -0.2), 2.2);
  }
}

// ---------- 载具 ----------
function _paintTankHull(g, tc, td) {
  [-8.6, 8.6].forEach(function (oy) {
    var top = oy - 3.5, h = 7;
    _rr(g, -14.6, top, 29.2, h, 2.6);
    g.fillStyle = _lg(g, 0, top, 0, top + h, '#2f333a', '#0f1115'); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1; g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    for (var x = -13; x <= 13.1; x += 2.6) { g.beginPath(); g.moveTo(x, top + 0.7); g.lineTo(x, top + h - 0.7); g.stroke(); }
    _dot(g, -12.4, oy, 2.3, '#40454d', 'rgba(0,0,0,.5)');
    _dot(g, 12.4, oy, 2.3, '#40454d', 'rgba(0,0,0,.5)');
    for (var i = -2; i <= 2; i++) _dot(g, i * 4.9, oy, 1.8, '#4c525b', 'rgba(0,0,0,.45)');
  });
  _plate(g, -13.2, -6.8, 26.4, 13.6, 2.4, _sh(tc, 0.24), _sh(td, -0.18), 1.2);
  _poly(g, [8.4, -6.8, 13.4, -4.2, 13.4, 4.2, 8.4, 6.8], _lg(g, 8.4, 0, 13.4, 0, _sh(tc, 0.38), _sh(tc, 0.02)), 'rgba(0,0,0,.45)');
  g.fillStyle = _sh(td, -0.4); g.fillRect(-13.2, -9.6, 26.4, 1.6); g.fillRect(-13.2, 8, 26.4, 1.6);
  _plate(g, -7.6, -3.5, 6.6, 7, 1.2, _sh(tc, 0.06), _sh(td, -0.3), 1);
  g.fillStyle = 'rgba(0,0,0,.35)';
  for (var k = 0; k < 3; k++) g.fillRect(-12.4, -2.6 + k * 2.3, 3.2, 1.3);
  _plate(g, -11.8, -6.4, 5.8, 3, 0.8, _sh(td, 0.06), _sh(td, -0.44), 1);
  g.fillStyle = tc; g.fillRect(1.8, -6.4, 2.4, 12.8);
  g.fillStyle = 'rgba(255,255,255,.7)'; g.fillRect(2.4, -2.2, 1.2, 4.4);
  _dot(g, 12.2, -3.6, 1.2, '#f7e08a', 'rgba(0,0,0,.5)');
  _dot(g, 12.2, 3.6, 1.2, '#f7e08a', 'rgba(0,0,0,.5)');
  _line(g, -9.8, -5.4, -11.8, -13, 'rgba(18,20,24,.9)', 1);
  _dot(g, -12, -13.6, 1, '#2a2e34', null);
  _rivet(g, -13, -6.6); _rivet(g, 12.6, -6.6); _rivet(g, -13, 6.4); _rivet(g, 12.6, 6.4);
}

function _paintTankTurret(g, tc, td) {
  _plate(g, -13, -6.4, 6.4, 12.8, 1.6, _sh(td, -0.05), _sh(td, -0.45), 1);
  _poly(g, [-9, -8.2, 6.6, -8.8, 10.8, -5, 10.8, 5, 6.6, 8.8, -9, 8.2],
    _lg(g, 0, -8.8, 0, 8.8, _sh(tc, 0.34), _sh(td, -0.12)), 'rgba(0,0,0,.6)');
  _plate(g, 9, -4.8, 4.4, 9.6, 1.4, _sh(tc, 0.1), _sh(td, -0.3), 1);
  g.fillStyle = _lg(g, 0, -2.2, 0, 2.2, '#5c626b', '#1d2126');
  g.fillRect(12.8, -2.2, 14.4, 4.4);
  g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(12.8, -2.2, 14.4, 1);
  g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1; g.strokeRect(12.8, -2.2, 14.4, 4.4);
  _plate(g, 17.8, -3.2, 4.4, 6.4, 1.3, _sh(tc, 0.05), _sh(td, -0.4), 1);
  g.fillStyle = '#13161a'; g.fillRect(25.6, -3, 2.8, 6);
  _dot(g, -3.8, -4.4, 3.3, _sh(tc, 0.14), 'rgba(0,0,0,.55)');
  g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1;
  g.beginPath(); g.arc(-3.8, -4.4, 1.8, 0, Math.PI * 2); g.stroke();
  _plate(g, -1.6, 2.6, 5.2, 4.6, 1, _sh(td, 0.06), _sh(td, -0.4), 1);
  g.fillStyle = '#0d1015'; g.fillRect(6.6, -1.5, 2.2, 3);
  for (var i = 0; i < 3; i++) { g.fillStyle = '#2b3037'; g.fillRect(-6.6 + i * 2.3, -10.2, 1.7, 2.1); }
  g.fillStyle = tc; g.fillRect(-9, -1.7, 3.4, 3.4);
  g.fillStyle = 'rgba(255,255,255,.8)'; g.fillRect(-8.1, -0.8, 1.7, 1.7);
}

function _paintApcHull(g, tc, td) {
  // 轮式底盘：每侧 4 只独立负重轮（轮胎 + 亮色轮辋 + 轮毂 + 轮拱），比履带明显轻一圈
  [-7.6, 7.6].forEach(function (oy) {
    for (var i = 0; i < 4; i++) {
      var x = -9.9 + i * 6.6;
      g.beginPath(); g.arc(x, oy - (oy < 0 ? 1.2 : -1.2), 5.2, 0, Math.PI);
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1.6; g.stroke();
      _dot(g, x, oy, 4.1, '#1a1e24', 'rgba(0,0,0,.65)');
      _dot(g, x, oy, 2.5, '#5a616a', 'rgba(0,0,0,.5)');
      _dot(g, x, oy, 0.9, '#98a1ab', null);
    }
  });
  // 箱体车体：比坦克更窄更高（俯视看更长），棱角分明
  _plate(g, -13.4, -6.2, 26.8, 12.4, 1.6, _sh(tc, 0.2), _sh(td, -0.14), 1.2);
  _poly(g, [9.2, -6.2, 13.9, -3.2, 13.9, 3.2, 9.2, 6.2], _lg(g, 9.2, 0, 13.9, 0, _sh(tc, 0.38), _sh(tc, 0.04)), 'rgba(0,0,0,.45)');
  // 后部载员舱：帆布顶（与金属车体反差最大的识别点）+ 舱门缝
  g.fillStyle = _sh(td, -0.3); _rr(g, -12.6, -4.6, 11.4, 9.2, 1.4); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.stroke();
  g.fillStyle = 'rgba(255,255,255,.07)';
  for (var b = 0; b < 4; b++) g.fillRect(-12.2 + b * 2.9, -4.6, 1.3, 9.2);
  _line(g, -1.2, -6.2, -1.2, 6.2, 'rgba(0,0,0,.5)', 1.2);
  // 侧裙板 + 射击孔
  g.fillStyle = _sh(td, -0.38); g.fillRect(-12.4, -7.4, 24.4, 1.3); g.fillRect(-12.4, 6.1, 24.4, 1.3);
  for (var j = 0; j < 2; j++) {
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(0.6 + j * 4.2, -5.9, 3.2, 1.4);
    g.fillRect(0.6 + j * 4.2, 4.5, 3.2, 1.4);
  }
  // 驾驶舱顶盖、挡风玻璃、排气与天线
  _plate(g, 1.4, -3.4, 6.4, 6.8, 1.1, _sh(tc, 0.06), _sh(td, -0.32), 1);
  g.fillStyle = _lg(g, 10, 0, 13.7, 0, 'rgba(160,210,240,.8)', 'rgba(40,70,95,.92)');
  _rr(g, 10.6, -3.8, 2.6, 7.6, 0.8); g.fill();
  _dot(g, 12.9, -5, 1.1, '#f7e08a', 'rgba(0,0,0,.5)');
  _dot(g, 12.9, 5, 1.1, '#f7e08a', 'rgba(0,0,0,.5)');
  g.fillStyle = '#3a4047'; g.fillRect(-14.6, -2.6, 2.2, 5.2);
  _line(g, -10.4, -5.4, -12.2, -13, 'rgba(18,20,24,.9)', 1);
  g.fillStyle = tc; g.fillRect(-4.6, -6.2, 1.8, 12.4);
  _rivet(g, -12.8, -6); _rivet(g, -12.8, 5.6); _rivet(g, 8.4, -6); _rivet(g, 8.4, 5.6);
}

function _paintApcTurret(g, tc, td) {
  _dot(g, 0, 0, 5.6, _lg(g, 0, -5.6, 0, 5.6, _sh(tc, 0.3), _sh(td, -0.1)), 'rgba(0,0,0,.6)');
  _dot(g, -1.8, -1.8, 1.9, _sh(td, -0.25), 'rgba(0,0,0,.5)');
  g.fillStyle = _lg(g, 0, -1.6, 0, 1.6, '#4c525b', '#1b1f25');
  g.fillRect(4.4, -1.6, 12.6, 3.2);
  g.fillStyle = '#12141a'; g.fillRect(16, -2.2, 2.2, 4.4);
}

function _paintGunship(g, tc, td) {
  g.fillStyle = _lg(g, 0, -2.4, 0, 2.4, _sh(tc, 0.1), _sh(td, -0.2));
  _rr(g, -23, -2.4, 14, 4.8, 1.8); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1; g.stroke();
  _poly(g, [-22, -2, -25.5, -10, -21, -10, -18, -2], _sh(tc, -0.08), 'rgba(0,0,0,.5)');
  g.fillStyle = _sh(td, 0.02); _rr(g, -24, -8, 5, 16, 1.6); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.5)'; g.stroke();
  [-1, 1].forEach(function (s) {
    var y0 = s < 0 ? -13.4 : 6.4;
    g.fillStyle = _sh(td, 0.04); _rr(g, -6.5, y0, 11.5, 7, 1.8); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1; g.stroke();
    var py = s < 0 ? -11.6 : 8.6;
    _plate(g, -5.5, py - 2.4, 12.5, 4.8, 2.2, _sh(tc, 0.06), _sh(td, -0.4), 1);
    for (var i = 0; i < 3; i++) _dot(g, 6, py - 1.4 + i * 1.4, 0.9, '#0d0f13', null);
  });
  g.beginPath();
  g.moveTo(15.5, 0); g.quadraticCurveTo(12, -8, 1, -8.6); g.lineTo(-12, -6.8);
  g.quadraticCurveTo(-17, -3, -16, 0); g.quadraticCurveTo(-17, 3, -12, 6.8);
  g.lineTo(1, 8.6); g.quadraticCurveTo(12, 8, 15.5, 0); g.closePath();
  g.fillStyle = _lg(g, 0, -8.6, 0, 8.6, _sh(tc, 0.34), _sh(td, -0.22)); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.2; g.stroke();
  g.beginPath(); g.moveTo(14, -0.4); g.quadraticCurveTo(11.4, -5.6, 4.6, -5.8);
  g.lineTo(4.6, 5.8); g.quadraticCurveTo(11.4, 5.6, 14, 0.4); g.closePath();
  g.fillStyle = _lg(g, 4, 0, 14, 0, 'rgba(165,220,250,.85)', 'rgba(28,58,84,.92)'); g.fill();
  _plate(g, -6.5, -4.8, 9.5, 9.6, 2.2, _sh(td, 0.1), _sh(td, -0.42), 1);
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(-8, -2.8, 2, 5.6);
  _dot(g, 9.4, 5, 2.7, '#2b3037', 'rgba(0,0,0,.55)');
  g.fillStyle = '#15171b'; g.fillRect(10.6, 4.2, 6, 1.6);
  _dot(g, -1.5, 0, 2.6, tc, 'rgba(255,255,255,.45)');
}

function _paintBomber(g, tc, td) {
  _poly(g, [4, -3.2, -6, -19.5, -11.5, -19.5, -3.4, -3.6, -3.4, 3.6, -11.5, 19.5, -6, 19.5, 4, 3.2],
    _lg(g, 0, -19.5, 0, 19.5, _sh(tc, 0.24), _sh(td, -0.26)), 'rgba(0,0,0,.55)');
  [-1, 1].forEach(function (s) {
    var y = s * 10;
    _plate(g, -4.5, y - 2.8, 13.5, 5.6, 2.6, _sh(tc, 0.1), _sh(td, -0.35), 1);
    g.fillStyle = 'rgba(0,0,0,.62)';
    g.beginPath(); g.arc(8.6, y, 2.2, 0, Math.PI * 2); g.fill();
  });
  g.beginPath();
  g.moveTo(17.5, 0); g.quadraticCurveTo(14.5, -4.8, 4, -5.4); g.lineTo(-13.5, -3.8);
  g.quadraticCurveTo(-17.5, 0, -13.5, 3.8); g.lineTo(4, 5.4); g.quadraticCurveTo(14.5, 4.8, 17.5, 0);
  g.closePath();
  g.fillStyle = _lg(g, 0, -5.4, 0, 5.4, _sh(tc, 0.36), _sh(td, -0.18)); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.2; g.stroke();
  g.fillStyle = '#0b0d11'; g.fillRect(-6.5, -2.8, 13, 5.6);
  g.fillStyle = '#c9a227'; g.fillRect(-5, -1.8, 10, 1.4); g.fillRect(-5, 0.4, 10, 1.4);
  g.fillStyle = _sh(td, -0.35); g.fillRect(-7.4, -3.6, 2.4, 7.2); g.fillRect(6, -3.6, 2.4, 7.2);
  g.beginPath(); g.moveTo(16, -0.4); g.quadraticCurveTo(13, -4.2, 8, -4.4);
  g.lineTo(8, 4.4); g.quadraticCurveTo(13, 4.2, 16, 0.4); g.closePath();
  g.fillStyle = _lg(g, 8, 0, 16, 0, 'rgba(175,225,255,.9)', 'rgba(28,58,84,.95)'); g.fill();
  _poly(g, [-12.5, -1.2, -20, -10, -16, -10, -9.5, -1.6], _sh(tc, -0.06), 'rgba(0,0,0,.5)');
  g.fillStyle = _sh(td, 0.06); _rr(g, -20.5, -3, 7.5, 6, 1.4); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1; g.stroke();
  _dot(g, -8.5, -14.5, 2.4, tc, 'rgba(255,255,255,.45)');
  _dot(g, -8.5, 14.5, 2.4, tc, 'rgba(255,255,255,.45)');
}

// ---------- 实时动画件 ----------
function _muzzle(ctx, x, y, r, ang) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  var gr = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  gr.addColorStop(0, 'rgba(255,255,235,0.95)');
  gr.addColorStop(0.45, 'rgba(255,205,70,0.8)');
  gr.addColorStop(1, 'rgba(255,140,0,0)');
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,242,190,0.9)';
  ctx.beginPath(); ctx.moveTo(0, -r * 0.34); ctx.lineTo(r * 1.6, 0); ctx.lineTo(0, r * 0.34); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function _rotor(ctx, x, y, r, ang, blades) {
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = 'rgba(180,190,205,.13)';
  ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(ang);
  ctx.strokeStyle = 'rgba(22,24,28,.8)'; ctx.lineWidth = 1.7;
  for (var i = 0; i < blades; i++) {
    ctx.rotate(Math.PI * 2 / blades);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r, 0); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = '#2b3037'; ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
}

function _waypoint(ctx, e, ux, uy) {
  if (!e.selected || !e.path || e.path.length === 0) return;
  var wp = e.path[e.path.length - 1];
  var wx = (wp.x + 0.5) * TILE_SIZE, wy = (wp.y + 0.5) * TILE_SIZE;
  ctx.strokeStyle = 'rgba(46,204,113,0.5)'; ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(wx, wy); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(wx - 4, wy - 4); ctx.lineTo(wx + 4, wy + 4);
  ctx.moveTo(wx + 4, wy - 4); ctx.lineTo(wx - 4, wy + 4);
  ctx.stroke();
}

// ---------- 单位入口 ----------
function hdDrawUnit(ctx, e, ex, ey2, tc, td, frameCount, kind) {
  var ux = ex + TILE_SIZE / 2, uy = ey2 + TILE_SIZE / 2;
  var air = !!e.isAirUnit;
  if (air) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(ux, ey2 + TILE_SIZE / 2 + 16, 13, 5.5, 0, 0, Math.PI * 2); ctx.fill();
    uy -= 15 + Math.sin(frameCount * 0.1) * 4;
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.beginPath(); ctx.ellipse(ux, uy + 10, 11, 4.2, 0, 0, Math.PI * 2); ctx.fill();
  }

  var col = tc + td, flash = e.muzzleFlash > 0, ang = e.turretDir || 0;

  if (e.type2 === 'infantry') {
    var hero = !!e.isMember;
    var weapon = e.weaponMode || 'mg';
    var cv = _unitSprite('s|' + kind + col + weapon + hero, SBOX, function (g) {
      _paintSoldier(g, tc, td, weapon, hero);
    });
    var bob = Math.sin((e.animFrame || 0) * Math.PI / 2) * 1.1;
    _blit(ctx, cv, SBOX, ux, uy + bob, 0);
    if (hero) {
      drawMemberLabel(ctx, ux, uy - 26 - memberLabelHeight(MEMBER_LABEL_FONT), e.memberName || '', e.hp / e.maxHp, '#f1c40f', MEMBER_LABEL_FONT);
    }
    if (flash) _muzzle(ctx, ux + Math.cos(ang) * 21, uy - 5 + Math.sin(ang) * 4, 6, ang);
    _waypoint(ctx, e, ux, uy);
    return;
  }

  var hullKey = 'h|' + kind + col, turKey = 't|' + kind + col;
  var face = (e.direction || 0);
  if (kind === 'tank') {
    var hull = _unitSprite(hullKey, UBOX, function (g) { _paintTankHull(g, tc, td); });
    var tur = _unitSprite(turKey, TBOX, function (g) { _paintTankTurret(g, tc, td); });
    _blit(ctx, hull, UBOX, ux, uy, face);
    var rec = flash ? 2.6 : 0;
    var px = ux - Math.cos(ang) * rec, py = uy - 1 - Math.sin(ang) * rec;
    _blit(ctx, tur, TBOX, px, py, ang);
    if (flash) _muzzle(ctx, ux + Math.cos(ang) * 28 - 0, uy - 1 + Math.sin(ang) * 28, 8, ang);
  } else if (kind === 'apc') {
    var ahull = _unitSprite(hullKey, UBOX, function (g) { _paintApcHull(g, tc, td); });
    var atur = _unitSprite(turKey, TBOX, function (g) { _paintApcTurret(g, tc, td); });
    _blit(ctx, ahull, UBOX, ux, uy, face);
    _blit(ctx, atur, TBOX, ux - 4, uy, ang);
    if (flash) _muzzle(ctx, ux - 4 + Math.cos(ang) * 17, uy + Math.sin(ang) * 17, 6, ang);
  } else if (kind === 'gunship') {
    var gh = _unitSprite(hullKey, UBOX, function (g) { _paintGunship(g, tc, td); });
    _blit(ctx, gh, UBOX, ux, uy, face);
    _rotor(ctx, ux, uy - 3, 24, frameCount * 0.55, 4);
    _rotor(ctx, ux - Math.cos(face) * 23, uy - Math.sin(face) * 23 - 5, 7, -frameCount * 0.9, 2);
    if (flash) _muzzle(ctx, ux + Math.cos(ang) * 18, uy + 4 + Math.sin(ang) * 10, 7, ang);
  } else if (kind === 'bomber') {
    var bh = _unitSprite(hullKey, UBOX, function (g) { _paintBomber(g, tc, td); });
    _blit(ctx, bh, UBOX, ux, uy, face);
    if (flash) _muzzle(ctx, ux + Math.cos(ang) * 20, uy + Math.sin(ang) * 20, 8, ang);
  }
  _waypoint(ctx, e, ux, uy);
}

// ---------- 建筑 ----------
function _paintBase(g, tc, td, S) {
  // 混凝土台基 + 分缝
  _plate(g, -3, 2, S + 6, S - 2, 3, '#5c626b', '#2c3138', 1.2);
  g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 1;
  for (var i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo(-3, 2 + (S - 2) * i / 4); g.lineTo(S + 3, 2 + (S - 2) * i / 4); g.stroke();
    g.beginPath(); g.moveTo(-3 + (S + 6) * i / 4, 2); g.lineTo(-3 + (S + 6) * i / 4, S); g.stroke();
  }
  // 主楼
  var mx = S * 0.08, my = S * 0.3, mw = S * 0.84, mh = S * 0.6;
  _plate(g, mx, my, mw, mh, 2, _sh(tc, 0.26), _sh(td, -0.24), 1.4);
  g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(mx, my + mh * 0.52, mw, 2);
  _windows(g, mx + 6, my + 7, 4, 2, 8, 7, 6, 6, 3);
  // 侧翼
  _plate(g, mx, my + mh - 6, mw * 0.34, 10, 2, _sh(tc, 0.1), _sh(td, -0.34), 1);
  // 指挥塔
  var tx = S * 0.56, ty = S * 0.02, tw = S * 0.3, th = S * 0.34;
  _plate(g, tx, ty, tw, th + 6, 2, _sh(tc, 0.34), _sh(td, -0.1), 1.4);
  _windows(g, tx + 4, ty + 6, 2, 3, 7, 6, 5, 5, 5);
  g.fillStyle = _sh(td, -0.45); g.fillRect(tx - 2, ty - 3, tw + 4, 4);
  _line(g, tx + tw * 0.5, ty - 3, tx + tw * 0.5, ty - 16, 'rgba(30,34,40,.9)', 1.4);
  _dot(g, tx + tw * 0.5, ty - 17, 1.6, '#e74c3c', 'rgba(0,0,0,.4)');
  // 大门 + 警示条 + 阵营门楣
  var dx = S * 0.36, dy = my + mh - 14;
  g.fillStyle = '#141419'; _rr(g, dx, dy, S * 0.18, 14, 1.5); g.fill();
  g.fillStyle = tc; g.fillRect(dx - 2, dy - 4, S * 0.18 + 4, 4);
  for (var s = 0; s < 4; s++) { g.fillStyle = s % 2 ? '#f1c40f' : '#1c1c22'; g.fillRect(dx - 4 + s * 4, dy + 13, 3.4, 3); }
  // 沙袋环 + 拒马
  drawSandbagWall(g, S * 0.04, S * 0.34, S - 6, 2);
  drawSandbagWall(g, S * 0.6, S * 0.98, S - 6, 2);
  // 阵营徽标
  _dot(g, S * 0.2, my + mh * 0.26, 5.5, tc, 'rgba(255,255,255,.5)');
  g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(S * 0.2 - 1.4, my + mh * 0.26 - 3.4, 2.8, 6.8);
  g.fillRect(S * 0.2 - 3.4, my + mh * 0.26 - 1.4, 6.8, 2.8);
}

function _paintPillbox(g, tc, td, S) {
  _plate(g, 2, 8, S - 4, S - 12, 5, '#767c85', '#31363d', 1.3);
  g.beginPath(); g.moveTo(4, S - 4); g.quadraticCurveTo(S / 2, S + 4, S - 4, S - 4); g.closePath();
  g.fillStyle = _lg(g, 0, S - 12, 0, S + 2, '#6d737c', '#2b3037'); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1.2; g.stroke();
  g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(4, S * 0.52); g.lineTo(S - 4, S * 0.52); g.stroke();
  g.fillStyle = '#0d0f13'; _rr(g, S * 0.3, S * 0.56, S * 0.4, 7, 2); g.fill();
  g.fillStyle = '#22262c'; g.fillRect(S * 0.44, S * 0.6, 3.2, 9); g.fillRect(S * 0.52, S * 0.6, 3.2, 9);
  drawSandbagWall(g, 2, S - 10, S - 4, 1);
  g.fillStyle = '#3a4047'; g.fillRect(S * 0.16, 4, 4, 8);
  g.fillStyle = '#2b3037'; g.fillRect(S * 0.14, 2, 8, 3);
  _plate(g, S * 0.6, 6, 14, 9, 1.6, _sh(td, 0.05), _sh(td, -0.4), 1);
  g.fillStyle = tc; g.fillRect(S * 0.2, 12, S * 0.6, 3);
  _rivet(g, 6, 12); _rivet(g, S - 8, 12);
}

function _paintTurretPad(g, tc, td, S) {
  _poly(g, [S * 0.18, 4, S * 0.82, 4, S - 3, S * 0.3, S - 3, S * 0.74, S * 0.82, S - 3, S * 0.18, S - 3, 3, S * 0.74, 3, S * 0.3],
    _lg(g, 0, 4, 0, S, '#757b84', '#2f343b'), 'rgba(0,0,0,.6)');
  g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1;
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.28, 0, Math.PI * 2); g.stroke();
  drawSandbagWall(g, 4, S - 12, S - 5, 1);
  for (var i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#f1c40f' : '#1c1c22'; g.fillRect(S * 0.28 + i * 5, 6, 4.2, 3); }
  g.fillStyle = tc; g.fillRect(S * 0.5 - 8, S * 0.5 - 1, 16, 2);
}

function _paintAaNest(g, tc, td, S) {
  _plate(g, 3, 6, S - 6, S - 10, 3, '#6a7079', '#2a2f36', 1.2);
  g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1;
  for (var i = 1; i < 3; i++) { g.beginPath(); g.moveTo(3, 6 + (S - 10) * i / 3); g.lineTo(S - 3, 6 + (S - 10) * i / 3); g.stroke(); }
  _rivet(g, 7, 10); _rivet(g, S - 9, 10); _rivet(g, 7, S - 8); _rivet(g, S - 9, S - 8);
  drawSandbagWall(g, 1, S - 9, S - 4, 2);
  _plate(g, S * 0.62, S * 0.16, 14, 10, 1.6, '#7a6a45', '#3b3324', 1);
  g.strokeStyle = 'rgba(0,0,0,.5)'; g.beginPath(); g.moveTo(S * 0.62 + 7, S * 0.16); g.lineTo(S * 0.62 + 7, S * 0.16 + 10); g.stroke();
  g.fillStyle = tc; g.fillRect(S * 0.14, S * 0.2, 10, 2.6);
}

function _paintHighrise(g, tc, td, S) {
  var top = -62, h = S + 62 - 4;
  // 楼体：左亮右暗的 2.5D 立面
  g.fillStyle = _lg(g, 0, top, 0, top + h, '#5b6577', '#242a35');
  g.fillRect(6, top, S - 12, h);
  g.fillStyle = 'rgba(255,255,255,.1)'; g.fillRect(6, top, 4, h);
  g.fillStyle = 'rgba(0,0,0,.32)'; g.fillRect(S - 14, top, 8, h);
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.2; g.strokeRect(6, top, S - 12, h);
  // 竖向壁柱
  g.fillStyle = 'rgba(0,0,0,.18)';
  for (var c = 0; c < 4; c++) g.fillRect(6 + (S - 12) * (c + 1) / 5 - 1, top, 2, h);
  // 窗格（顶部 8 层亮灯）
  _windows(g, 11, top + 8, 4, 8, 8, 9, 5, 6, 2);
  // 底层大堂
  g.fillStyle = 'rgba(255,220,150,.5)'; g.fillRect(10, S - 14, S - 20, 10);
  g.fillStyle = '#15181e'; g.fillRect(S / 2 - 6, S - 12, 12, 8);
  g.fillStyle = _sh(tc, 0.1); g.fillRect(8, S - 17, S - 16, 3);
  // 屋顶：女儿墙 + 水箱 + 空调机组
  g.fillStyle = '#39404c'; g.fillRect(4, top - 4, S - 8, 5);
  g.fillStyle = '#2a303a'; g.fillRect(S * 0.16, top - 16, 16, 13);
  g.fillStyle = '#454e5c'; g.fillRect(S * 0.16, top - 16, 16, 3);
  g.fillStyle = '#333a45'; g.fillRect(S * 0.6, top - 10, 13, 7);
  g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1; g.strokeRect(S * 0.6, top - 10, 13, 7);
  _line(g, S * 0.5, top - 4, S * 0.5, top - 26, 'rgba(28,32,40,.95)', 1.6);
  // 侧挂消防梯
  g.strokeStyle = 'rgba(20,24,30,.75)'; g.lineWidth = 1.2;
  for (var f = 0; f < 6; f++) {
    var fy = top + 16 + f * 15;
    g.beginPath(); g.moveTo(S - 13, fy); g.lineTo(S - 6, fy); g.stroke();
    g.beginPath(); g.moveTo(S - 9.5, fy); g.lineTo(S - 9.5, fy + 15); g.stroke();
  }
}

function _paintBuilding(g, type, tc, td, S) {
  if (type === 'base') _paintBase(g, tc, td, S);
  else if (type === 'pillbox') _paintPillbox(g, tc, td, S);
  else if (type === 'turret') _paintTurretPad(g, tc, td, S);
  else if (type === 'aaNest') _paintAaNest(g, tc, td, S);
  else _paintHighrise(g, tc, td, S);
}

const BLD_PAD = {
  base: { l: 8, t: 44, b: 8 },
  pillbox: { l: 6, t: 14, b: 8 },
  turret: { l: 6, t: 12, b: 8 },
  aaNest: { l: 6, t: 12, b: 8 },
  highrise: { l: 10, t: 92, b: 8 },
};

function _damageFx(ctx, x, y, w, h, frac) {
  if (frac > 0.6) return;
  var n = frac < 0.3 ? 5 : 3;
  ctx.fillStyle = 'rgba(20,18,16,' + (0.5 - frac * 0.5).toFixed(2) + ')';
  for (var i = 0; i < n; i++) {
    var px = x + ((i * 37 + 13) % 100) / 100 * w;
    var py = y + ((i * 61 + 29) % 100) / 100 * h;
    ctx.beginPath(); ctx.ellipse(px, py, w * 0.11, h * 0.09, i, 0, Math.PI * 2); ctx.fill();
  }
}

function hdDrawBuilding(ctx, e, ex, ey2, eS, tc, td, frameCount) {
  var pad = BLD_PAD[e.type] || { l: 6, t: 16, b: 6 };
  var cw = eS + pad.l * 2, ch = eS + pad.t + pad.b;
  var cv = _sprite('b|' + e.type + '|' + tc + td + '|' + eS, cw, ch, function (g) {
    g.translate(pad.l, pad.t);
    _paintBuilding(g, e.type, tc, td, eS);
  });
  ctx.drawImage(cv, ex - pad.l, ey2 - pad.t, cw, ch);
  _damageFx(ctx, ex, ey2, eS, eS, e.hp / e.maxHp);

  var ang = e.renderTurretAngle || 0;
  var cx = ex + eS / 2, cy = ey2 + eS / 2;
  if (e.type === 'base') {
    // 旋转雷达碟（左翼顶）+ 阵营旗（右上飘动）
    var rx = ex + eS * 0.2, ry = ey2 + eS * 0.2;
    ctx.save(); ctx.translate(rx, ry);
    ctx.fillStyle = '#8d949d'; ctx.fillRect(-1.4, 0, 2.8, 9);
    ctx.rotate(frameCount * 0.02);
    ctx.beginPath(); ctx.ellipse(0, -3, 9, 4.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = _lg(ctx, -9, -8, 9, 2, '#c9d1da', '#6c737c'); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, -3, 4.4, 2.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fill();
    ctx.restore();
    var fx = ex + eS * 0.9, fy = ey2 - 30;
    _line(ctx, fx, fy, fx, fy + 16, 'rgba(210,215,222,.9)', 1.6);
    var wv = Math.sin(frameCount * 0.09) * 2;
    _poly(ctx, [fx, fy + 1, fx + 13, fy + 3 + wv, fx + 12, fy + 8 + wv, fx, fy + 8], tc, 'rgba(0,0,0,.4)');
  } else if (e.type === 'turret') {
    var rec = e.fireCooldown > e.fireRate - 4 ? 2.4 : 0;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.translate(-rec, 0);
    _dot(ctx, 0, 0, 11, _lg(ctx, 0, -11, 0, 11, _sh(tc, 0.3), _sh(td, -0.2)), 'rgba(0,0,0,.6)');
    ctx.fillStyle = _lg(ctx, 0, -2.6, 0, 2.6, '#5c626b', '#1d2126');
    ctx.fillRect(6, -2.6, 17, 5.2);
    ctx.fillStyle = '#13161a'; ctx.fillRect(21.5, -3.4, 3, 6.8);
    _dot(ctx, -3, -3, 2.6, _sh(td, -0.2), 'rgba(0,0,0,.5)');
    ctx.restore();
    if (e.muzzleFlash > 0) _muzzle(ctx, cx + Math.cos(ang) * 26, cy + Math.sin(ang) * 26, 8, ang);
  } else if (e.type === 'aaNest') {
    ctx.save(); ctx.translate(cx, cy + 1); ctx.rotate(ang);
    _dot(ctx, 0, 0, 6.5, _lg(ctx, 0, -6.5, 0, 6.5, '#71798a', '#2c313a'), 'rgba(0,0,0,.6)');
    ctx.fillStyle = 'rgba(190,200,215,.55)';
    _rr(ctx, 2, -8, 9, 16, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = _lg(ctx, 0, -1.9, 0, 1.9, '#5d636c', '#191d22');
    ctx.fillRect(8, -3.4, 16, 2.8); ctx.fillRect(8, 0.6, 16, 2.8);
    ctx.fillStyle = '#12151a'; ctx.fillRect(22.5, -3.8, 2.6, 3.4); ctx.fillRect(22.5, 0.4, 2.6, 3.4);
    _dot(ctx, -5, 3.6, 3.4, '#3d434c', 'rgba(0,0,0,.5)');
    ctx.restore();
    if (e.muzzleFlash > 0) _muzzle(ctx, cx + Math.cos(ang) * 26, cy + Math.sin(ang) * 26 - 2, 7, ang);
  } else if (e.type === 'highrise') {
    if (frameCount % 90 < 45) {
      ctx.fillStyle = '#ff5b4a';
      ctx.beginPath(); ctx.arc(ex + eS * 0.5, ey2 - 78, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,91,74,.25)';
      ctx.beginPath(); ctx.arc(ex + eS * 0.5, ey2 - 78, 5.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}

/** 缓存占用（字节）：调试用，DevTools 里 window.__sprites 亦可核对 */
export function spriteCacheStats() {
  var bytes = 0;
  _cache.forEach(function (cv) { bytes += cv.width * cv.height * 4; });
  return { count: _cache.size, bytes: bytes };
}
