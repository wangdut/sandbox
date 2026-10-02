import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, GRASS, WATER, ORE, ROCK, CONCRETE, SAND, TREE,
         HILL, HILL_TOP, SANDBAG,
         TEAM_PLAYER, TEAM_ENEMY, COLOR_PLAYER, COLOR_PLAYER_DARK, COLOR_ENEMY, COLOR_ENEMY_DARK,
         COLOR_ALLIED, COLOR_ALLIED_DARK, COLOR_SOVIET, COLOR_SOVIET_DARK, TYPE_AIRCRAFT, TYPE_HELICOPTER, TYPE_AIRSHIP, TEAM_NEUTRAL } from './constants.js';
import { BUILDING_DEFS, DEFENSE_DEFS, UNIT_DEFS, SUPER_WEAPONS, FACTION_ALLIED, FACTION_SOVIET } from './definitions.js';
import { drawBuilding as drawBuildingSprite, drawUnit as drawUnitSprite, drawMemberLabel, memberLabelHeight, MEMBER_LABEL_FONT, drawSandbagWall } from './Sprites.js';

// 画布内文字字号：按用户反馈整体放大约 35%（气泡 10→13.5、飘字 12→16）
export const SPEECH_FONT = 13.5;
export const FLOAT_FONT = 16;

// 水纹动画的相位量化档数。原实现每格每帧程序化绘制（1 底色 + 3 波纹 + 2 次 sin），
// 预渲染为 64 张相位图后每格只需 1 次取模 + 1 次 drawImage。
// 64 档 / 2.6s 周期 ≈ 25 步/秒，缓慢水纹的跳变肉眼不可辨。
const WATER_PHASES = 64;
// 矿石晶体数上界（与 render 中 crystals 计算一致：1 + floor(oreAmt/100)，封顶 6）
const ORE_MAX_CRYSTALS = 6;

export class Renderer {
  constructor(canvas, minimapCanvas) {
    this.ctx = canvas.getContext('2d');
    this.minimapCtx = minimapCanvas.getContext('2d');
    this.canvas = canvas;
    this.minimapCanvas = minimapCanvas;
    this.tileCache = [];
    this.reliefCache = [];  // [type][variant*16 + 邻居掩码] → 山包/沙袋格（掩码保证山脊与沙袋墙跨格连续）
    this.waterCache = [];   // [phaseIdx] → 预渲染水格（含波纹）
    this.oreCache = [];     // [crystals][variant] → 预渲染晶体层（透明底，alpha 由 globalAlpha 控制）
    this.minimapTerrainCanvas = null;
    this.minimapTerrainDirty = true;
  }

  getSortedEntities(gameState) {
    // 单位每帧都在移动，y 序必须每帧重排，否则重叠绘制顺序错乱。
    // 这里刻意保留 slice()：实测「复用成员数组 + 手动复制」比 slice() 慢约 4%
    //（V8 的 slice 是紧凑数组的快速拷贝），且本项每帧仅约 6µs，不值得改复杂。
    return gameState.entities.slice().sort(function(a, b) {
      return (a.y + (a.isBuilding ? a.size : 1)) - (b.y + (b.isBuilding ? b.size : 1));
    });
  }

  getTileCanvas(type, tx, ty) {
    var variant = (tx * 7 + ty * 13) % 4;
    // 地形类型是 0~6 的枚举，用二维数组直接索引。
    // 原来每格每帧拼接 'type_variant' 字符串做 key，全图铺满时每帧产生数千次字符串分配
    var byType = this.tileCache[type];
    if (!byType) byType = this.tileCache[type] = [];
    var cached = byType[variant];
    if (cached) return cached;
    var tc = document.createElement('canvas');
    tc.width = TILE_SIZE; tc.height = TILE_SIZE;
    this.drawTileToCtx(tc.getContext('2d'), type, variant);
    byType[variant] = tc;
    return tc;
  }

  /**
   * 邻格位掩码：bit0~3 = 同族四邻（N=1 E=2 S=4 W=8），bit4~7 = 该侧是否为山顶（N=16 E=32 S=64 W=128）
   * 坡与顶算作同一个山体，这样山脊跨格时阴影与等高线能连起来；沙袋只认同族。
   */
  _reliefMask(map, tx, ty, type) {
    var at = function (x, y) {
      if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return -1;
      return map.terrain[y][x];
    };
    var same = function (x, y) {
      var t = at(x, y);
      if (type === SANDBAG) return t === SANDBAG;
      return t === HILL || t === HILL_TOP;
    };
    var fam = (same(tx, ty - 1) ? 1 : 0) | (same(tx + 1, ty) ? 2 : 0) |
              (same(tx, ty + 1) ? 4 : 0) | (same(tx - 1, ty) ? 8 : 0);
    if (type === SANDBAG) return fam;
    // 坡地需要知道"哪侧是更高的平顶"（画受光棱），平顶需要知道"哪侧不再是平顶"（画崖口）
    return fam | (at(tx, ty - 1) === HILL_TOP ? 16 : 0) | (at(tx + 1, ty) === HILL_TOP ? 32 : 0) |
               (at(tx, ty + 1) === HILL_TOP ? 64 : 0) | (at(tx - 1, ty) === HILL_TOP ? 128 : 0);
  }

  _getReliefCanvas(type, variant, mask) {
    var byType = this.reliefCache[type];
    if (!byType) byType = this.reliefCache[type] = [];
    var idx = variant * 256 + mask;
    var cached = byType[idx];
    if (cached) return cached;
    var tc = document.createElement('canvas');
    tc.width = TILE_SIZE; tc.height = TILE_SIZE;
    this._drawReliefTile(tc.getContext('2d'), type, variant, mask);
    byType[idx] = tc;
    return tc;
  }

  /** 山包 / 山顶 / 沙袋阵地格 */
  _drawReliefTile(g, type, variant, mask) {
    var S = TILE_SIZE, h = S / 2;
    var hasN = mask & 1, hasE = mask & 2, hasS = mask & 4, hasW = mask & 8;

    if (type === SANDBAG) {
      // 踩实的沙土地面 + 深浅沙纹
      var sc = ['#9c8551', '#a38b57', '#947e4b', '#a89462'];
      g.fillStyle = sc[variant]; g.fillRect(0, 0, S, S);
      g.fillStyle = 'rgba(70,55,28,0.22)';
      g.fillRect(3 + variant * 3, 12, 11, 2);
      g.fillRect(15 - (variant % 2) * 4, 22, 10, 2);
      g.fillStyle = 'rgba(228,205,150,0.16)';
      g.fillRect(4, 7 + variant, 8, 1);
      // 沙袋墙只砌在阵地外缘（内侧相邻仍是沙袋时不砌，否则阵地内部会被墙填满）
      // 墙根先压一道投影：没有接地阴影时整袋墙像是浮在沙地上的一块贴图。
      // dir 指向阵地内部，投影永远落在墙的内侧脚下。
      function wallH(y, dir) {
        g.fillStyle = 'rgba(44,35,16,0.30)';
        g.fillRect(0, dir > 0 ? y + 6.6 : y - 2.6, S, 2.6);
        drawSandbagWall(g, 0, S, y, 2);
      }
      function wallV(x, dir) {
        g.fillStyle = 'rgba(44,35,16,0.30)';
        g.fillRect(dir > 0 ? x + 6.6 : x - 2.6, 0, 2.6, S);
        drawSandbagWall(g, 0, S, x, 2);
      }
      if (!hasN) wallH(4, 1);
      if (!hasS) wallH(S - 3, -1);
      if (!hasW || !hasE) {
        g.save();
        g.translate(h, h); g.rotate(Math.PI / 2); g.translate(-h, -h);
        if (!hasE) wallV(4, 1);   // 旋转后这一条落在东侧
        if (!hasW) wallV(S - 3, -1);
        g.restore();
      }
      return;
    }

    var isTop = type === HILL_TOP;
    var flat = (mask & 15) === 15;
    // 抬升方向：同族邻居所在侧更高，没有同族的一侧是下坡
    var ux = (hasW ? 1 : 0) - (hasE ? 1 : 0);
    var uy = (hasN ? 1 : 0) - (hasS ? 1 : 0);
    if (!ux && !uy) uy = -1;

    // 单一底色：山体是一整块连续表面，不能再叠草地那种棋盘格明暗。
    // 平顶刻意偏暖（岩石地形是冷蓝灰），否则山头看起来像一块水泥地坪。
    g.fillStyle = isTop ? '#7b7461' : '#3d6a27';
    g.fillRect(0, 0, S, S);

    if (!flat) {
      // 坡面光照：上坡侧受光、下坡侧落影
      var grd = g.createLinearGradient(h - ux * h, h - uy * h, h + ux * h, h + uy * h);
      if (isTop) {
        grd.addColorStop(0, 'rgba(228,236,206,0.20)');
        grd.addColorStop(0.6, 'rgba(255,255,255,0.03)');
        grd.addColorStop(1, 'rgba(24,30,20,0.22)');
      } else {
        grd.addColorStop(0, 'rgba(198,226,152,0.17)');
        grd.addColorStop(0.55, 'rgba(255,255,255,0.02)');
        grd.addColorStop(1, 'rgba(8,24,4,0.34)');
      }
      g.fillStyle = grd; g.fillRect(0, 0, S, S);
      // 等高线：垂直于抬升方向的两道棱，暗棱下方配一条细高光才有凸起感
      var px = -uy, py = ux;
      for (var ci = 0; ci < 2; ci++) {
        var off = (ci - 0.5) * 11;
        var cx0 = h + ux * off, cy0 = h + uy * off;
        g.strokeStyle = isTop ? 'rgba(28,34,24,0.34)' : 'rgba(16,40,8,0.34)';
        g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(cx0 - px * 22, cy0 - py * 22); g.lineTo(cx0 + px * 22, cy0 + py * 22); g.stroke();
        g.strokeStyle = isTop ? 'rgba(232,240,214,0.16)' : 'rgba(184,216,140,0.20)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx0 - px * 22 + ux * 1.6, cy0 - py * 22 + uy * 1.6);
        g.lineTo(cx0 + px * 22 + ux * 1.6, cy0 + py * 22 + uy * 1.6);
        g.stroke();
      }
    }

    // 露头岩：顶面受光 + 侧面落影，位置随 variant 固定以保证同一格每帧一致
    var rockSide = isTop ? '#5b5545' : '#4a5240';
    var rockTop = isTop ? '#b0a892' : '#8d9680';
    var nRocks = isTop ? 3 : 2;
    for (var ri = 0; ri < nRocks; ri++) {
      var rx = 7 + ((ri * 11 + variant * 7) % 19);
      var ry = 8 + ((ri * 13 + variant * 5) % 17);
      var rw = (isTop ? 4.6 : 3.2) + ((ri + variant) % 2) * 1.2;
      var rh = rw * 0.6;
      g.fillStyle = rockSide;
      g.beginPath();
      g.moveTo(rx - rw, ry); g.lineTo(rx - rw * 0.35, ry - rh); g.lineTo(rx + rw * 0.8, ry - rh * 0.45);
      g.lineTo(rx + rw, ry + rh * 0.45); g.lineTo(rx - rw * 0.2, ry + rh);
      g.closePath(); g.fill();
      g.fillStyle = rockTop;
      g.beginPath();
      g.moveTo(rx - rw * 0.9, ry - rh * 0.18); g.lineTo(rx - rw * 0.3, ry - rh * 0.95);
      g.lineTo(rx + rw * 0.72, ry - rh * 0.45); g.lineTo(rx + rw * 0.08, ry - rh * 0.05);
      g.closePath(); g.fill();
    }
    if (!isTop) {
      g.strokeStyle = 'rgba(126,186,92,0.5)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(24 - variant * 3, 26); g.lineTo(25 - variant * 3, 21); g.stroke();
      g.beginPath(); g.moveTo(27 - variant * 3, 26); g.lineTo(28 - variant * 3, 22); g.stroke();
    } else {
      // 台面自身要有裂纹与碎石：中央格四周都是平顶、拿不到坡向光照，
      // 不补细节就会在山顶正中间留一块死灰的方斑。
      var kx = 4 + variant * 5, ky = 8 + (variant % 2) * 9;
      g.strokeStyle = 'rgba(44,42,32,0.42)'; g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(kx, ky); g.lineTo(kx + 7, ky + 3); g.lineTo(kx + 13, ky - 1);
      g.stroke();
      g.strokeStyle = 'rgba(216,209,183,0.22)'; g.lineWidth = 1;
      g.beginPath();
      g.moveTo(kx, ky + 1.4); g.lineTo(kx + 7, ky + 4.4); g.lineTo(kx + 13, ky + 0.4);
      g.stroke();
      for (var gi = 0; gi < 6; gi++) {
        var gx = 5 + ((gi * 9 + variant * 6) % 23);
        var gy = 5 + ((gi * 7 + variant * 11) % 23);
        g.fillStyle = 'rgba(84,80,66,0.5)';
        g.beginPath(); g.arc(gx, gy, 1.3 + (gi % 3) * 0.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(206,199,174,0.4)';
        g.fillRect(gx - 0.9, gy - 1.4, 1.5, 0.9);
      }
    }

    // 边缘处理：山脚接触影 / 坡面接入平顶的受光棱 / 平顶崖口
    function band(side, color, thick, inset) {
      g.fillStyle = color;
      if (side === 1) g.fillRect(0, inset, S, thick);
      else if (side === 4) g.fillRect(0, S - thick - inset, S, thick);
      else if (side === 8) g.fillRect(inset, 0, thick, S);
      else g.fillRect(S - thick - inset, 0, thick, S);
    }
    var sides = [1, 2, 4, 8], topBits = [16, 32, 64, 128];
    // 带内侧撒几颗落石：把笔直的崖线/山脚影打散，避免"混凝土边框"感
    function rubble(side, thick) {
      for (var ni = 0; ni < 3; ni++) {
        var np = 3 + ((variant * 9 + ni * 11 + side * 3) % 24);
        var rx = (side === 1 || side === 4) ? np : (side === 8 ? thick - 1 : S - thick + 1);
        var ry = (side === 1 || side === 4) ? (side === 1 ? thick - 1 : S - thick + 1) : np;
        g.fillStyle = rockSide;
        g.beginPath(); g.arc(rx, ry, 1.7 + (ni % 2) * 0.8, 0, Math.PI * 2); g.fill();
        g.fillStyle = rockTop;
        g.fillRect(rx - 1.1, ry - 1.7, 1.7, 1);
      }
    }
    for (var si = 0; si < 4; si++) {
      var sd = sides[si];
      if (isTop) {
        if (!(mask & topBits[si])) {          // 这一侧不再是平顶 → 崖口
          band(sd, 'rgba(22,27,17,0.7)', 4, 0);
          band(sd, 'rgba(214,226,188,0.42)', 1.5, 4);
          rubble(sd, 4);
        }
      } else {
        if (!(mask & sd)) { band(sd, 'rgba(15,36,9,0.5)', 4, 0); rubble(sd, 4); }  // 与草地接壤的山脚影
        else if (mask & topBits[si]) band(sd, 'rgba(208,230,158,0.16)', 3, 0);     // 坡顶接入平顶的棱
      }
    }
  }

  /**
   * 相位 = frameCount*0.04 + tx*0.7 + ty*0.5，逐格天然错相，量化档只按相位索引即可保留错相效果。
   * 第三条波纹原为独立相位（0.03 频率、只含 tx），现绑到主相位（×0.75 保持频率比）——
   * 装饰性水纹，同步与否肉眼不可辨。
   */
  _getWaterCanvas(phaseIdx) {
    var c = this.waterCache[phaseIdx];
    if (c) return c;
    c = document.createElement('canvas');
    c.width = TILE_SIZE; c.height = TILE_SIZE;
    var tctx = c.getContext('2d');
    var s = TILE_SIZE;
    var phase = phaseIdx / WATER_PHASES * Math.PI * 2;
    var woff = Math.sin(phase) * 2;
    tctx.fillStyle = '#1a5276'; tctx.fillRect(0, 0, s, s);
    tctx.fillStyle = 'rgba(52,152,219,0.3)';
    tctx.fillRect(0, 10 + woff, s, 3);
    tctx.fillRect(5, 22 - woff, s - 10, 3);
    tctx.fillStyle = 'rgba(120,200,255,0.18)';
    tctx.fillRect(Math.sin(phase * 0.75) * 3, 2, s - 8, 2);
    this.waterCache[phaseIdx] = c;
    return c;
  }

  /**
   * 预渲染矿石晶体层（透明底）。晶体布局按 variant（4 循环）固化——原实现用完整 tx/ty
   * 生成伪随机布局，但本来就是装饰性晶体，4 循环重复与原纹理变体的重复节奏一致，看不出差异。
   * 呼吸明暗（pulse）不改图、用渲染时的 globalAlpha 缩放实现，因此每种晶体数只需 4 张图。
   */
  _getOreCrystalCanvas(crystals, variant) {
    var byCount = this.oreCache[crystals];
    if (!byCount) byCount = this.oreCache[crystals] = [];
    var c = byCount[variant];
    if (c) return c;
    c = document.createElement('canvas');
    c.width = TILE_SIZE; c.height = TILE_SIZE;
    var tctx = c.getContext('2d');
    for (var ci = 0; ci < crystals; ci++) {
      var crx = 4 + ((ci * 7 + variant * 3) % 22);
      var cry = 4 + ((ci * 11 + variant * 5) % 22);
      tctx.fillStyle = 'rgb(241,196,15)';
      tctx.beginPath();
      tctx.moveTo(crx, cry - 5); tctx.lineTo(crx + 4, cry); tctx.lineTo(crx, cry + 5); tctx.lineTo(crx - 4, cry);
      tctx.closePath(); tctx.fill();
      tctx.fillStyle = 'rgba(255,220,50,0.65)';
      tctx.beginPath();
      tctx.moveTo(crx, cry - 2); tctx.lineTo(crx + 2, cry); tctx.lineTo(crx, cry + 2); tctx.lineTo(crx - 2, cry);
      tctx.closePath(); tctx.fill();
    }
    byCount[variant] = c;
    return c;
  }

  drawTileToCtx(tctx, type, variant) {
    var s = TILE_SIZE;
    if (type === GRASS) {
      var bc = ['#2d5a1e', '#3a6b2a', '#2a5520', '#326020'];
      tctx.fillStyle = bc[variant]; tctx.fillRect(0, 0, s, s);
      tctx.fillStyle = 'rgba(60,120,40,0.35)';
      if (variant % 3 === 0) { tctx.fillRect(14, 8, 2, 5); tctx.fillRect(15, 6, 2, 4); }
      if (variant % 2 === 0) {
        tctx.fillStyle = 'rgba(30,80,15,0.3)';
        tctx.beginPath(); tctx.arc(s - 14, s - 14, 3, 0, Math.PI * 2); tctx.fill();
      }
      tctx.fillStyle = 'rgba(0,0,0,0.05)';
      tctx.fillRect(0, s - 1, s, 1);
    } else if (type === SAND) {
      var sc = ['#b8960c', '#c9a21a', '#b5911a', '#c2a015'];
      tctx.fillStyle = sc[variant]; tctx.fillRect(0, 0, s, s);
      tctx.fillStyle = 'rgba(200,170,40,0.4)';
      for (var si = 0; si < 4; si++) tctx.fillRect(si * 7 + 2, si * 6 + 4, 3, 2);
    } else if (type === ROCK) {
      tctx.fillStyle = '#4a5568'; tctx.fillRect(0, 0, s, s);
      tctx.fillStyle = '#6b7a8d'; tctx.fillRect(3, 3, s - 6, s - 6);
      tctx.fillStyle = '#8a9ab0'; tctx.fillRect(7, 5, 8, 5); tctx.fillRect(17, 14, 9, 4);
      tctx.fillStyle = 'rgba(0,0,0,0.25)'; tctx.fillRect(s - 5, 3, 5, s - 3); tctx.fillRect(3, s - 5, s - 8, 5);
    } else if (type === CONCRETE) {
      tctx.fillStyle = '#3d3d3d'; tctx.fillRect(0, 0, s, s);
      tctx.fillStyle = '#484848'; tctx.fillRect(1, 1, s - 2, s - 2);
      tctx.strokeStyle = '#2a2a2a'; tctx.lineWidth = 0.5;
      tctx.strokeRect(0.5, 0.5, s - 1, s - 1);
      tctx.fillStyle = 'rgba(255,255,255,0.04)'; tctx.fillRect(1, 1, s / 2 - 1, s / 2 - 1);
    } else if (type === TREE) {
      tctx.fillStyle = '#2d5a1e'; tctx.fillRect(0, 0, s, s);
      tctx.fillStyle = '#5d4037';
      tctx.fillRect(s / 2 - 2, s - 12, 4, 8);
      tctx.fillStyle = '#1e4a10';
      tctx.beginPath(); tctx.arc(s / 2, s / 2 - 2, 9, 0, Math.PI * 2); tctx.fill();
      tctx.fillStyle = '#2d5e1e';
      tctx.beginPath(); tctx.arc(s / 2 - 3, s / 2 - 4, 6, 0, Math.PI * 2); tctx.fill();
      tctx.fillStyle = '#3d6e2e';
      tctx.beginPath(); tctx.arc(s / 2 + 3, s / 2 - 5, 5, 0, Math.PI * 2); tctx.fill();
    }
  }

  render(gameState, camera, frameCount, selectedUnits, selectedBuilding, placingBuilding, placingType, mouse, dragSelect, activeAction, superWeaponTargeting, gamePaused, viewWidth, viewHeight) {
    var ctx = this.ctx;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    var zoom = camera.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, viewWidth, viewHeight);
    ctx.clip();
    ctx.scale(zoom, zoom);
    ctx.translate(-camera.x / zoom, -camera.y / zoom);
    var startTX = Math.max(0, Math.floor(camera.x / zoom / TILE_SIZE));
    var startTY = Math.max(0, Math.floor(camera.y / zoom / TILE_SIZE));
    var endTX = Math.min(MAP_WIDTH, Math.ceil((camera.x / zoom + viewWidth / zoom) / TILE_SIZE) + 1);
    var endTY = Math.min(MAP_HEIGHT, Math.ceil((camera.y / zoom + viewHeight / zoom) / TILE_SIZE) + 1);
    // 视口剔除边界（世界坐标），一次算好给抛射物/爆炸/飘字复用。
    // 原来只有烟雾做了剔除，这三类屏幕外对象照样走完整绘制路径
    var cullL = camera.x / zoom, cullT = camera.y / zoom;
    var cullR = cullL + viewWidth / zoom, cullB = cullT + viewHeight / zoom;

    // Terrain with fog of war
    for (var ty = startTY; ty < endTY; ty++) {
      for (var tx = startTX; tx < endTX; tx++) {
        var sx = tx * TILE_SIZE;
        var sy = ty * TILE_SIZE;
        
        // 战争迷雾：未探索区域不渲染地形
        if (gameState.fogOfWar && !gameState.fogOfWar.isExplored(tx, ty)) {
          ctx.fillStyle = '#000000';
          ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
          continue;
        }
        
        var terrain = gameState.map.terrain[ty][tx];
        if (terrain === ORE) {
          // 矿石：不透明底色 + 预渲染晶体层（globalAlpha 实现呼吸脉冲）。
          // 原实现每格每帧画 6 个双层菱形（约 14 次 canvas 调用），现降为 1 fillRect + 1 drawImage
          ctx.fillStyle = '#2d5a1e'; ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
          var oreAmt = gameState.map.oreAmount[ty][tx];
          var crystals = Math.min(ORE_MAX_CRYSTALS, Math.floor(oreAmt / 100) + 1);
          var pulse = 0.85 + Math.sin(frameCount * 0.08 + tx + ty) * 0.15;
          ctx.globalAlpha = pulse;
          ctx.drawImage(this._getOreCrystalCanvas(crystals, (tx * 7 + ty * 13) % 4), sx, sy);
          ctx.globalAlpha = 1;
        } else if (terrain === WATER) {
          // 水面：按相位选预渲染帧。phase 含 tx/ty 项，逐格天然错相
          var wPhase = (frameCount * 0.04 + tx * 0.7 + ty * 0.5) % (Math.PI * 2);
          if (wPhase < 0) wPhase += Math.PI * 2;
          ctx.drawImage(this._getWaterCanvas(Math.min(WATER_PHASES - 1, Math.floor(wPhase / (Math.PI * 2) * WATER_PHASES))), sx, sy);
        } else if (terrain === HILL || terrain === HILL_TOP || terrain === SANDBAG) {
          // 山包/山顶/沙袋：邻格位掩码让山脊连绵、沙袋墙只在受敌侧留缺口
          ctx.drawImage(this._getReliefCanvas(terrain, (tx * 7 + ty * 13) % 4,
            this._reliefMask(gameState.map, tx, ty, terrain)), sx, sy);
        } else {
          ctx.drawImage(this.getTileCanvas(terrain, tx, ty), sx, sy);
        }
      }
    }

    // Entities sorted by y for proper overlap (cached)
    var sortedE = this.getSortedEntities(gameState);
    for (var ei = 0; ei < sortedE.length; ei++) {
      var e = sortedE[ei];
      var ex = e.x * TILE_SIZE;
      var ey2 = e.y * TILE_SIZE;
      var eS = e.size * TILE_SIZE;
      if (ex + eS < camera.x / zoom || ey2 + eS < camera.y / zoom || ex > camera.x / zoom + viewWidth / zoom || ey2 > camera.y / zoom + viewHeight / zoom) continue;
      
      // 战争迷雾：敌方单位在迷雾中不可见
      if (gameState.fogOfWar && e.team !== gameState.humanTeam) {
        var centerX = Math.floor(e.x + (e.isBuilding ? e.size / 2 : 0.5));
        var centerY = Math.floor(e.y + (e.isBuilding ? e.size / 2 : 0.5));
        if (!gameState.fogOfWar.isVisible(centerX, centerY)) continue;
      }
      if (e.dead) {
        ctx.globalAlpha = e.deathTimer / 45;
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(ex, ey2, eS, eS);
        ctx.globalAlpha = 1;
        continue;
      }
      // 根据阵营获取颜色
      var tc, td;
      if (e.faction === FACTION_ALLIED) {
        tc = COLOR_ALLIED;
        td = COLOR_ALLIED_DARK;
      } else if (e.faction === FACTION_SOVIET) {
        tc = COLOR_SOVIET;
        td = COLOR_SOVIET_DARK;
      } else if (e.team === TEAM_NEUTRAL) {
        tc = '#7f8c8d';
        td = '#46505c';
      } else {
        tc = e.team === TEAM_PLAYER ? COLOR_PLAYER : COLOR_ENEMY;
        td = e.team === TEAM_PLAYER ? COLOR_PLAYER_DARK : COLOR_ENEMY_DARK;
      }
      if (e.flashTimer > 0) ctx.globalAlpha = 0.5 + Math.sin(e.flashTimer * 2) * 0.5;
      if (e.isBuilding) this.drawBuilding(e, ex, ey2, eS, tc, td, gameState, frameCount);
      else this.drawUnit(e, ex, ey2, tc, td, frameCount);
      ctx.globalAlpha = 1;

      // 停放载具：加个"无人"标记，和成员开的车区分开
      if (e.isMount) {
        ctx.font = 'bold 12px "Microsoft YaHei", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeText('⚙ 载具', ex + eS / 2, ey2 - 10);
        ctx.fillStyle = 'rgba(241,196,15,.95)';
        ctx.fillText('⚙ 载具', ex + eS / 2, ey2 - 10);
        ctx.lineWidth = 1;
        ctx.textAlign = 'left';
      }
      // 乘驾中的成员：补金色光环 + 统一标签（名字在上、血条在下，位于载具上方）
      if (e.isMember && e.mountType) {
        ctx.strokeStyle = '#f1c40f';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(ex + eS / 2, ey2 + eS - 4, 12, 5, 0, 0, Math.PI * 2); ctx.stroke();
        drawMemberLabel(ctx, ex + eS / 2, ey2 - 6 - memberLabelHeight(MEMBER_LABEL_FONT), e.memberName || '', e.hp / e.maxHp, '#f1c40f', MEMBER_LABEL_FONT);
      }

      // Selection highlight
      if (e.selected) {
        ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(ex - 2, ey2 - 2, eS + 4, eS + 4);
        ctx.setLineDash([]);
        // Corner brackets
        var brSize = 5;
        ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ex - 2, ey2 - 2 + brSize); ctx.lineTo(ex - 2, ey2 - 2); ctx.lineTo(ex - 2 + brSize, ey2 - 2);
        ctx.moveTo(ex + eS + 2 - brSize, ey2 - 2); ctx.lineTo(ex + eS + 2, ey2 - 2); ctx.lineTo(ex + eS + 2, ey2 - 2 + brSize);
        ctx.moveTo(ex - 2, ey2 + eS + 2 - brSize); ctx.lineTo(ex - 2, ey2 + eS + 2); ctx.lineTo(ex - 2 + brSize, ey2 + eS + 2);
        ctx.moveTo(ex + eS + 2 - brSize, ey2 + eS + 2); ctx.lineTo(ex + eS + 2, ey2 + eS + 2); ctx.lineTo(ex + eS + 2, ey2 + eS + 2 - brSize);
        ctx.stroke();
      }
      // HP bar（成员的血条在统一标签里画，这里只处理其他单位/建筑）
      if (e.hp < e.maxHp && !e.dead && !e.isMember) {
        var bw = eS, bh = 4, bx2 = ex, by2 = ey2 - 7;
        ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(bx2, by2, bw, bh);
        var r = e.hp / e.maxHp;
        ctx.fillStyle = r > 0.6 ? '#2ecc71' : (r > 0.3 ? '#f39c12' : '#e74c3c');
        ctx.fillRect(bx2, by2, bw * r, bh);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx2, by2, bw, bh);
      }
      // Veterancy chevrons
      if (e.veterancy > 0) {
        ctx.fillStyle = e.veterancy >= 2 ? '#f1c40f' : '#bdc3c7';
        for (var v = 0; v < e.veterancy; v++) {
          ctx.beginPath();
          ctx.moveTo(ex + v * 5 + 2, ey2 + eS - 2);
          ctx.lineTo(ex + v * 5 + 5, ey2 + eS - 6);
          ctx.lineTo(ex + v * 5 + 8, ey2 + eS - 2);
          ctx.closePath(); ctx.fill();
        }
      }
      // 无敌（铁幕）状态：紫色脉冲描边
      if (e.invulnerable) {
        var ivPulse = 0.45 + Math.sin(frameCount * 0.2) * 0.3;
        ctx.strokeStyle = 'rgba(142,68,173,' + ivPulse + ')';
        ctx.lineWidth = 2;
        ctx.strokeRect(ex - 3, ey2 - 3, eS + 6, eS + 6);
      }
    }

    // Smoke particles
    for (var smi = 0; smi < gameState.smokeParticles.length; smi++) {
      var sm = gameState.smokeParticles[smi];
      var smx = sm.x, smy = sm.y;
      if (smx < camera.x / zoom - 20 || smy < camera.y / zoom - 20 || smx > camera.x / zoom + viewWidth / zoom + 20 || smy > camera.y / zoom + viewHeight / zoom + 20) continue;
      var alpha = sm.timer / sm.maxTimer * 0.4;
      ctx.fillStyle = 'rgba(80,80,80,' + alpha + ')';
      ctx.beginPath();
      ctx.arc(smx, smy, sm.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Projectiles
    for (var pi = 0; pi < gameState.projectiles.length; pi++) {
      var p = gameState.projectiles[pi];
      var px = p.x, py = p.y;
      // 剔除：子弹会画一条从当前位置指向目标的曳光轨迹，所以要用「线段包围盒」
      // 判断，不能只看弹体位置 —— 弹体在屏幕外、目标在屏幕内时轨迹仍可见。
      // 线段必包含于其两端点的包围盒内，故按包围盒判定不会误杀。
      var segMinX = px < p.targetX ? px : p.targetX, segMaxX = px < p.targetX ? p.targetX : px;
      var segMinY = py < p.targetY ? py : p.targetY, segMaxY = py < p.targetY ? p.targetY : py;
      if (segMaxX < cullL || segMinX > cullR || segMaxY < cullT || segMinY > cullB) continue;
      if (p.type === 'bullet') {
        ctx.fillStyle = '#ffe234';
        ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
        // Tracer trail
        ctx.strokeStyle = 'rgba(255,226,52,0.4)';
        ctx.lineWidth = 1.5;
        var dxT = p.targetX - p.x, dyT = p.targetY - p.y;
        var lT = Math.sqrt(dxT * dxT + dyT * dyT);
        if (lT > 0) {
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - dxT / lT * 6, py - dyT / lT * 6);
          ctx.stroke();
        }
      } else if (p.type === 'shell') {
        ctx.fillStyle = '#e67e22';
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f39c12';
        ctx.beginPath(); ctx.arc(px - 1, py - 1, 2, 0, Math.PI * 2); ctx.fill();
      } else if (p.type === 'rocket') {
        ctx.save();
        var rocketAngle = Math.atan2(p.targetY - p.y, p.targetX - p.x);
        ctx.translate(px, py); ctx.rotate(rocketAngle);
        ctx.fillStyle = '#e74c3c';
        ctx.fillRect(-5, -2, 10, 4);
        ctx.fillStyle = '#f1c40f';
        ctx.fillRect(-8, -1, 4, 2);
        ctx.fillStyle = 'rgba(255,180,0,0.7)';
        ctx.beginPath(); ctx.arc(-7, 0, 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else if (p.type === 'tesla') {
        ctx.strokeStyle = 'rgba(0,191,255,0.9)';
        ctx.lineWidth = 3;
        var segs = 5;
        ctx.beginPath();
        ctx.moveTo(px, py);
        var dxL = p.targetX - p.x, dyL = p.targetY - p.y;
        for (var li = 1; li <= segs; li++) {
          var lt = li / segs;
          var lx = p.x + dxL * lt + (Math.random() - 0.5) * 12;
          var ly = p.y + dyL * lt + (Math.random() - 0.5) * 12;
          ctx.lineTo(lx, ly);
        }
        ctx.stroke();
        ctx.fillStyle = 'rgba(100,220,255,0.85)';
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Explosions
    for (var xi = 0; xi < gameState.explosions.length; xi++) {
      var exp = gameState.explosions[xi];
      var expX = exp.x, expY = exp.y;
      // 剔除：爆炸是圆形，半径最大约为 size*1.2，留一倍余量避免边缘突然消失
      var cullM = exp.size * 2 + 32;
      if (expX + cullM < cullL || expX - cullM > cullR || expY + cullM < cullT || expY - cullM > cullB) continue;
      var prog = 1 - exp.timer / exp.maxTimer;
      var es2 = exp.size * (0.4 + prog * 0.8);
      if (exp.type === 'fire' || exp.type === 'big') {
        ctx.fillStyle = 'rgba(255,80,0,' + (1 - prog) + ')';
        ctx.beginPath(); ctx.arc(expX, expY, es2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,200,0,' + (0.85 - prog * 0.85) + ')';
        ctx.beginPath(); ctx.arc(expX, expY, es2 * 0.65, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,200,' + (0.6 - prog * 0.6) + ')';
        ctx.beginPath(); ctx.arc(expX, expY, es2 * 0.3, 0, Math.PI * 2); ctx.fill();
        if (exp.type === 'big') {
          for (var si2 = 0; si2 < 6; si2++) {
            var angle = si2 * Math.PI / 3 + prog * 2;
            var dist = es2 * (0.6 + prog * 0.4);
            var sx3 = expX + Math.cos(angle) * dist;
            var sy3 = expY + Math.sin(angle) * dist;
            ctx.fillStyle = 'rgba(120,70,30,' + (0.6 - prog * 0.6) + ')';
            ctx.beginPath(); ctx.arc(sx3, sy3, 4 + prog * 5, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else if (exp.type === 'electric') {
        ctx.strokeStyle = 'rgba(0,191,255,' + (1 - prog) + ')';
        ctx.lineWidth = 3 + prog * 2;
        ctx.beginPath(); ctx.arc(expX, expY, es2, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(93,173,226,' + (0.45 - prog * 0.45) + ')';
        ctx.beginPath(); ctx.arc(expX, expY, es2 * 0.5, 0, Math.PI * 2); ctx.fill();
        // Tesla branches
        ctx.strokeStyle = 'rgba(150,220,255,' + (0.8 - prog * 0.8) + ')';
        ctx.lineWidth = 2;
        for (var br = 0; br < 4; br++) {
          ctx.beginPath();
          ctx.moveTo(expX, expY);
          var ang = br * Math.PI / 2 + frameCount * 0.1;
          ctx.lineTo(expX + Math.cos(ang) * es2, expY + Math.sin(ang) * es2);
          ctx.stroke();
        }
      }
    }

    // Floating texts
    ctx.textAlign = 'center';
    ctx.font = 'bold ' + FLOAT_FONT + 'px Arial';
    for (var fi = 0; fi < gameState.floatingTexts.length; fi++) {
      var ft = gameState.floatingTexts[fi];
      var ftx = ft.x, fty = ft.y;
      // 剔除：16px 字体、居中绘制，170px 余量足够覆盖任意文本宽度
      if (ftx + 170 < cullL || ftx - 170 > cullR || fty + 170 < cullT || fty - 170 > cullB) continue;
      ctx.globalAlpha = ft.timer / 50;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(ft.text, ftx + 1, fty + 1);
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ftx, fty);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';

    // 成员喊话气泡：跟随单位，显示约 4 秒后淡出（沙盘社交的可视化）
    if (gameState.speechBubbles && gameState.speechBubbles.length > 0) {
      ctx.textAlign = 'center';
      ctx.font = 'bold ' + SPEECH_FONT + 'px "Microsoft YaHei", Arial, sans-serif';
      for (var si = 0; si < gameState.speechBubbles.length; si++) {
        var sp = gameState.speechBubbles[si];
        if (sp.x + 180 < cullL || sp.x - 180 > cullR || sp.y + 160 < cullT || sp.y - 160 > cullB) continue;
        // 自动折行：每行 11 个中文字符，最多 4 行（台词上限 40 字）
        var PER_LINE = 11, MAX_LINES = 4;
        var lines = [];
        for (var ci = 0; ci < sp.text.length && lines.length < MAX_LINES; ci += PER_LINE) {
          lines.push(sp.text.slice(ci, ci + PER_LINE));
        }
        if (sp.text.length > PER_LINE * MAX_LINES) {
          lines[MAX_LINES - 1] = lines[MAX_LINES - 1].slice(0, PER_LINE - 1) + '…';
        }
        var lineH = 18;
        var boxW = 0;
        for (var li = 0; li < lines.length; li++) boxW = Math.max(boxW, ctx.measureText(lines[li]).width);
        boxW += 14;
        var boxH = lines.length * lineH + 10;
        // 成员头顶有「名字+血条」标签，气泡需再上移，避免压住标签
        var lift = (sp.entity && sp.entity.isMember) ? memberLabelHeight(MEMBER_LABEL_FONT) + 8 : 0;
        var bx = sp.x - boxW / 2, by = sp.y - 30 - boxH - lift;
        var alpha = sp.timer > 40 ? 1 : sp.timer / 40;
        ctx.globalAlpha = alpha * 0.9;
        ctx.fillStyle = 'rgba(6, 6, 16, 0.92)';
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = sp.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
        // 指向单位的小三角
        ctx.beginPath();
        ctx.moveTo(sp.x - 5, by + boxH);
        ctx.lineTo(sp.x + 5, by + boxH);
        ctx.lineTo(sp.x, by + boxH + 6);
        ctx.closePath();
        ctx.fillStyle = 'rgba(6, 6, 16, 0.92)';
        ctx.fill();
        ctx.fillStyle = sp.color;
        for (var ti = 0; ti < lines.length; ti++) {
          ctx.fillText(lines[ti], sp.x, by + 17 + ti * lineH);
        }
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = 'left';
    }

    // 战争迷雾：在世界坐标系内一次 drawImage 覆盖未探索/无视野区域
    if (gameState.fogOfWar) {
      gameState.fogOfWar.render(ctx);
    }

    // 超级武器效果渲染（世界坐标系，跟随镜头与缩放）
    if (gameState.superWeaponManager) {
      gameState.superWeaponManager.render(ctx, frameCount);
    }

    // Building placement ghost
    if (placingBuilding && placingType && mouse.inCanvas) {
      var pd2 = BUILDING_DEFS[placingType] || DEFENSE_DEFS[placingType];
      if (pd2) {
        var pS = pd2.size * TILE_SIZE;
        var pgx = mouse.mapX * TILE_SIZE;
        var pgy = mouse.mapY * TILE_SIZE;
        var canPlace = gameState.map.isBuildable(mouse.mapX, mouse.mapY, pd2.size) &&
                       gameState.map.isNearBuilding(mouse.mapX, mouse.mapY, pd2.size, gameState.humanTeam);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = canPlace ? '#2ecc71' : '#e74c3c';
        ctx.fillRect(pgx, pgy, pS, pS);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = canPlace ? '#2ecc71' : '#e74c3c';
        ctx.lineWidth = 2;
        ctx.strokeRect(pgx, pgy, pS, pS);
        // Show range for defenses
        if (DEFENSE_DEFS[placingType] && pd2.range > 0) {
          ctx.strokeStyle = 'rgba(255,255,255,0.25)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.arc(pgx + pS / 2, pgy + pS / 2, pd2.range * TILE_SIZE, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // 超级武器瞄准预览
    if (superWeaponTargeting && mouse.inCanvas) {
      var swDef = SUPER_WEAPONS[superWeaponTargeting];
      var swRadius = swDef ? (swDef.radius || (superWeaponTargeting === 'ironCurtain' ? 3 : 2)) : 2;
      var swx = mouse.mapX * TILE_SIZE + TILE_SIZE / 2;
      var swy = mouse.mapY * TILE_SIZE + TILE_SIZE / 2;
      var swPulse = 0.5 + Math.sin(frameCount * 0.15) * 0.25;
      ctx.fillStyle = 'rgba(231,76,60,0.12)';
      ctx.beginPath(); ctx.arc(swx, swy, swRadius * TILE_SIZE, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(231,76,60,' + swPulse + ')';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.arc(swx, swy, swRadius * TILE_SIZE, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(231,76,60,0.9)';
      ctx.beginPath();
      ctx.moveTo(swx - 8, swy); ctx.lineTo(swx + 8, swy);
      ctx.moveTo(swx, swy - 8); ctx.lineTo(swx, swy + 8);
      ctx.stroke();
    }

    ctx.restore();

    // === Screen-space overlays (not affected by zoom) ===

    // Drag select rectangle
    if (dragSelect.active) {
      var drx = Math.min(dragSelect.startX, dragSelect.endX);
      var dry = Math.min(dragSelect.startY, dragSelect.endY);
      var drw = Math.abs(dragSelect.endX - dragSelect.startX);
      var drh = Math.abs(dragSelect.endY - dragSelect.startY);
      ctx.fillStyle = 'rgba(46,204,113,0.12)';
      ctx.fillRect(drx, dry, drw, drh);
      ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(drx, dry, drw, drh);
      ctx.setLineDash([]);
    }

    // Action-mode cursor overlay
    if (activeAction) {
      ctx.fillStyle = activeAction === 'repair' ? 'rgba(46,204,113,0.2)' : 'rgba(241,196,15,0.2)';
      ctx.fillRect(mouse.x - 12, mouse.y - 12, 24, 24);
      ctx.strokeStyle = activeAction === 'repair' ? '#2ecc71' : '#f1c40f';
      ctx.lineWidth = 2;
      ctx.strokeRect(mouse.x - 12, mouse.y - 12, 24, 24);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px Arial';
      ctx.fillText(activeAction === 'repair' ? '\u{1F527}' : '$', mouse.x - 5, mouse.y + 4);
    }

    // Game paused overlay
    if (gamePaused) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, 0, viewWidth, this.canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 36px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('\u6682\u505C', viewWidth / 2, this.canvas.height / 2);
      ctx.font = '14px Arial';
      ctx.fillStyle = '#aaa';
      ctx.fillText('\u6309 Space \u7EE7\u7EED', viewWidth / 2, this.canvas.height / 2 + 30);
      ctx.textAlign = 'left';
    }

    this.renderMinimap(gameState, camera, frameCount, viewWidth);
  }

  drawBuilding(e, ex, ey2, eS, tc, td, gameState, frameCount) {
    // 实现已外提到 Sprites.js（这两个方法不依赖 Renderer 实例状态）
    return drawBuildingSprite(this.ctx, e, ex, ey2, eS, tc, td, gameState, frameCount);
  }

  drawUnit(e, ex, ey2, tc, td, frameCount) {
    // 实现已外提到 Sprites.js
    return drawUnitSprite(this.ctx, e, ex, ey2, tc, td, frameCount);
  }

  renderMinimap(gameState, camera, frameCount, viewWidth) {
    var minimapCtx = this.minimapCtx;
    var minimapCanvas = this.minimapCanvas;
    var mw = minimapCanvas.width, mh = minimapCanvas.height;
    var sx = mw / MAP_WIDTH, sy = mh / MAP_HEIGHT;

    if (!this.minimapTerrainCanvas) {
      this.minimapTerrainCanvas = document.createElement('canvas');
      this.minimapTerrainCanvas.width = mw;
      this.minimapTerrainCanvas.height = mh;
      this.minimapTerrainDirty = true;
    }
    if (this.minimapTerrainDirty || frameCount % 120 === 0) {
      var tCtx = this.minimapTerrainCanvas.getContext('2d');
      tCtx.fillStyle = '#060610';
      tCtx.fillRect(0, 0, mw, mh);
      for (var my = 0; my < MAP_HEIGHT; my += 1) {
        for (var mx = 0; mx < MAP_WIDTH; mx += 1) {
          var t = gameState.map.terrain[my][mx];
          if (t === GRASS) tCtx.fillStyle = '#2d5a1e';
          else if (t === WATER) tCtx.fillStyle = '#1a5276';
          else if (t === ORE) tCtx.fillStyle = '#c9a800';
          else if (t === ROCK) tCtx.fillStyle = '#4a5568';
          else if (t === CONCRETE) tCtx.fillStyle = '#3d3d3d';
          else if (t === SAND) tCtx.fillStyle = '#9a7d0a';
          else if (t === TREE) tCtx.fillStyle = '#1e4a10';
          else if (t === HILL) tCtx.fillStyle = '#6b7d5a';
          else if (t === HILL_TOP) tCtx.fillStyle = '#93896f';
          else if (t === SANDBAG) tCtx.fillStyle = '#b59b6a';
          else continue;
          tCtx.fillRect(mx * sx, my * sy, sx + 1, sy + 1);
        }
      }
      this.minimapTerrainDirty = false;
    }

    minimapCtx.drawImage(this.minimapTerrainCanvas, 0, 0);

    // 战争迷雾覆盖小地图（未探索全黑 / 已探索半暗）
    if (gameState.fogOfWar) {
      gameState.fogOfWar.render(minimapCtx, mw, mh);
    }

    for (var i = 0; i < gameState.entities.length; i++) {
      var e = gameState.entities[i];
      if (e.dead) continue;
      
      // 战争迷雾：小地图上敌方单位只在有视野时显示
      if (gameState.fogOfWar && e.team !== gameState.humanTeam) {
        var eCenterX = Math.floor(e.x + (e.isBuilding ? e.size / 2 : 0.5));
        var eCenterY = Math.floor(e.y + (e.isBuilding ? e.size / 2 : 0.5));
        if (!gameState.fogOfWar.isVisible(eCenterX, eCenterY)) continue;
      }
      
      minimapCtx.fillStyle = e.team === TEAM_PLAYER ? '#4a9fd4' : (e.team === TEAM_NEUTRAL ? '#8a97a5' : '#e74c3c');
      var emx = (e.x + (e.isBuilding ? e.size / 2 : 0.5)) * sx;
      var emy = (e.y + (e.isBuilding ? e.size / 2 : 0.5)) * sy;
      var ds = e.isBuilding ? 3 : 2;
      minimapCtx.fillRect(emx - ds / 2, emy - ds / 2, ds, ds);
    }
    // Minimap alerts
    for (var ai = 0; ai < gameState.minimapAlerts.length; ai++) {
      var al = gameState.minimapAlerts[ai];
      var alpha = al.timer / al.maxTimer;
      var radius = (1 - alpha) * 15 + 3;
      minimapCtx.strokeStyle = al.color;
      minimapCtx.globalAlpha = alpha;
      minimapCtx.lineWidth = 2;
      minimapCtx.beginPath();
      minimapCtx.arc(al.x * sx, al.y * sy, radius, 0, Math.PI * 2);
      minimapCtx.stroke();
      minimapCtx.globalAlpha = 1;
    }
    // Viewport rect
    minimapCtx.strokeStyle = 'rgba(255,255,255,0.7)';
    minimapCtx.lineWidth = 1;
    var vpX = camera.x / camera.zoom / TILE_SIZE * sx;
    var vpY = camera.y / camera.zoom / TILE_SIZE * sy;
    var vpW = viewWidth / camera.zoom / TILE_SIZE * sx;
    var vpH = this.canvas.height / camera.zoom / TILE_SIZE * sy;
    minimapCtx.strokeRect(vpX, vpY, vpW, vpH);
  }
}
