import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, GRASS, WATER, ORE, ROCK, CONCRETE, SAND, TREE,
         HILL, HILL_TOP, SANDBAG,
         TEAM_PLAYER, TEAM_ENEMY, COLOR_PLAYER, COLOR_PLAYER_DARK, COLOR_ENEMY, COLOR_ENEMY_DARK,
         COLOR_ALLIED, COLOR_ALLIED_DARK, COLOR_SOVIET, COLOR_SOVIET_DARK, TYPE_AIRCRAFT, TYPE_HELICOPTER, TYPE_AIRSHIP, TEAM_NEUTRAL } from './constants.js';
import { BUILDING_DEFS, DEFENSE_DEFS, UNIT_DEFS, SUPER_WEAPONS, FACTION_ALLIED, FACTION_SOVIET } from './definitions.js';
import { drawBuilding as drawBuildingSprite, drawUnit as drawUnitSprite, drawMemberLabel, memberLabelHeight, MEMBER_LABEL_FONT, drawSandbagWall } from './Sprites.js';
import { layout } from './core/layout.js';

// 画布内文字字号：按用户反馈整体放大约 35%（气泡 10→13.5、飘字 12→16）
export const SPEECH_FONT = 13.5;
export const FLOAT_FONT = 16;

// 水纹动画的相位量化档数。原实现每格每帧程序化绘制（1 底色 + 3 波纹 + 2 次 sin），
// 预渲染为 64 张相位图后每格只需 1 次取模 + 1 次 drawImage。
// 64 档 / 2.6s 周期 ≈ 25 步/秒，缓慢水纹的跳变肉眼不可辨。
const WATER_PHASES = 64;
// 矿石晶体数上界（与 render 中 crystals 计算一致：1 + floor(oreAmt/100)，封顶 6）
const ORE_MAX_CRYSTALS = 6;

// ---- 起伏层（山包 / 沙袋阵地）烘焙参数 ----
const DX4 = [0, 1, 0, -1], DY4 = [-1, 0, 1, 0];   // 上北下南：side 0=N 1=E 2=S 3=W
// 光从左上方来；HILL_RELIEF 把「每格高差」放大成像素斜率，越大山体越"鼓"
const LX = -0.52, LY = -0.66, LZ = 0.54, HILL_RELIEF = 30;
// 高程→地表色：山脚草绿 → 半坡草石混色 → 山顶裸岩（偏暖，避免冷灰像水泥地坪）
const RELIEF_RAMP = [
  [0.00, 56, 104, 34], [0.30, 78, 125, 44], [0.56, 118, 138, 70],
  [0.78, 142, 136, 112], [1.00, 178, 172, 147],
];

function smooth01(a, b, v) {
  var t = (v - a) / (b - a);
  if (t <= 0) return 0; if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** 高程场双线性采样：坐标以「格中心为整数」计，越界按 0（平地）处理 */
function sampleElevation(E, gx, gy) {
  var x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  var at = function (x, y) {
    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return 0;
    var v = E[y][x];
    return v > 0 ? v : 0;
  };
  return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
         at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
}

const _reliefOut = [0, 0, 0];
/** 按归一化高程取坡面色（复用同一个数组，逐像素调用不产生垃圾） */
function reliefColor(t) {
  if (t < 0) t = 0; if (t > 1) t = 1;
  var i = 1;
  while (i < RELIEF_RAMP.length - 1 && t > RELIEF_RAMP[i][0]) i++;
  var a = RELIEF_RAMP[i - 1], b = RELIEF_RAMP[i];
  var k = (t - a[0]) / (b[0] - a[0] || 1);
  _reliefOut[0] = a[1] + (b[1] - a[1]) * k;
  _reliefOut[1] = a[2] + (b[2] - a[2]) * k;
  _reliefOut[2] = a[3] + (b[3] - a[3]) * k;
  return _reliefOut;
}

/** 落石：受光顶面 + 背光侧面 + 接地投影，山体的尺度感靠这几块石头撑 */
function drawBoulder(g, x, y, r) {
  g.fillStyle = 'rgba(18,26,12,0.28)';
  g.beginPath(); g.ellipse(x + r * 0.35, y + r * 0.55, r * 1.05, r * 0.45, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#5d5a4a';
  g.beginPath();
  g.moveTo(x - r, y + r * 0.3); g.lineTo(x - r * 0.4, y - r * 0.9); g.lineTo(x + r * 0.9, y - r * 0.3);
  g.lineTo(x + r, y + r * 0.5); g.lineTo(x - r * 0.2, y + r * 0.7);
  g.closePath(); g.fill();
  g.fillStyle = '#a9a48d';
  g.beginPath();
  g.moveTo(x - r * 0.85, y + r * 0.05); g.lineTo(x - r * 0.3, y - r * 0.85); g.lineTo(x + r * 0.8, y - r * 0.35);
  g.lineTo(x + r * 0.1, y - r * 0.05);
  g.closePath(); g.fill();
}

/** 草丛：三两片向光弯折的叶，用来打散山脚那条笔直的交界线 */
function drawTuft(g, x, y, h) {
  g.strokeStyle = 'rgba(126,186,92,0.72)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x - 1.6, y - h); g.stroke();
  g.beginPath(); g.moveTo(x + 1.4, y); g.lineTo(x + 2.6, y - h * 0.8); g.stroke();
  g.strokeStyle = 'rgba(78,132,52,0.7)';
  g.beginPath(); g.moveTo(x - 0.6, y); g.lineTo(x - 3.4, y - h * 0.6); g.stroke();
}

export class Renderer {
  constructor(canvas, minimapCanvas) {
    this.ctx = canvas.getContext('2d');
    this.minimapCtx = minimapCanvas.getContext('2d');
    this.canvas = canvas;
    this.minimapCanvas = minimapCanvas;
    this.tileCache = [];
    this._reliefLayer = null;   // 山包/沙袋整幅烘焙层（按 map 引用失效）
    this._reliefMap = null;
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

  // ==================== 起伏层：山包与沙袋阵地整体烘焙 ====================
  // 逐格贴图会把山体切成一格格的方块：等高线变成一圈圈嵌套矩形、山顶像一块水泥地坪。
  // 这里按「高程场」一次性烘焙整幅地形——连续光照、柔和山脚、平滑等高线；
  // 沙袋则沿阵地外缘连续砌墙，接缝与阵地内部重复的墙也随之消失。

  /** 高程场：非坡面格为 0，坡面格按到山脚的步数抬升，山顶再抬 2 档形成台地落差 */
  _buildElevation(map) {
    var E = [], q = [];
    for (var y = 0; y < MAP_HEIGHT; y++) {
      E[y] = new Float32Array(MAP_WIDTH);
      for (var x = 0; x < MAP_WIDTH; x++) {
        var t = map.terrain[y][x];
        if (t === HILL || t === HILL_TOP) E[y][x] = -1;
        else q.push(x, y);
      }
    }
    for (var head = 0; head < q.length; head += 2) {
      var cx = q[head], cy = q[head + 1], h = E[cy][cx];
      for (var d = 0; d < 4; d++) {
        var nx = cx + DX4[d], ny = cy + DY4[d];
        if (nx < 0 || ny < 0 || nx >= MAP_WIDTH || ny >= MAP_HEIGHT) continue;
        if (E[ny][nx] !== -1) continue;
        E[ny][nx] = h + 1;
        q.push(nx, ny);
      }
    }
    for (var yy = 0; yy < MAP_HEIGHT; yy++) {
      for (var xx = 0; xx < MAP_WIDTH; xx++) {
        if (map.terrain[yy][xx] === HILL_TOP && E[yy][xx] > 0) E[yy][xx] += 2;
      }
    }
    return E;
  }

  /** 连通区域：相邻同族格并成一座山 / 一处阵地——缺口与细节要按整块地形决定，不能逐格决定 */
  _reliefRegions(map) {
    var fam = function (x, y) {
      if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return null;
      var t = map.terrain[y][x];
      return t === HILL || t === HILL_TOP ? 'hill' : t === SANDBAG ? 'bag' : null;
    };
    var seen = [], out = [];
    for (var y = 0; y < MAP_HEIGHT; y++) seen[y] = new Uint8Array(MAP_WIDTH);
    for (var ty = 0; ty < MAP_HEIGHT; ty++) {
      for (var tx = 0; tx < MAP_WIDTH; tx++) {
        var kind = fam(tx, ty);
        if (!kind || seen[ty][tx]) continue;
        var tiles = [[tx, ty]], stack = [[tx, ty]];
        seen[ty][tx] = 1;
        var box = { x0: tx, y0: ty, x1: tx, y1: ty };
        while (stack.length) {
          var p = stack.pop();
          for (var d = 0; d < 4; d++) {
            var nx = p[0] + DX4[d], ny = p[1] + DY4[d];
            if (nx < 0 || ny < 0 || nx >= MAP_WIDTH || ny >= MAP_HEIGHT) continue;
            if (seen[ny][nx] || fam(nx, ny) !== kind) continue;
            seen[ny][nx] = 1; stack.push([nx, ny]); tiles.push([nx, ny]);
            if (nx < box.x0) box.x0 = nx;
            if (ny < box.y0) box.y0 = ny;
            if (nx > box.x1) box.x1 = nx;
            if (ny > box.y1) box.y1 = ny;
          }
        }
        out.push({ kind: kind, tiles: tiles, box: box, seed: out.length * 31 + 7 });
      }
    }
    return out;
  }

  /** 取（或重建）整幅起伏层：新开一局 / 读档换 map 对象后按引用自动失效 */
  _getReliefLayer(gameState) {
    if (this._reliefLayer && this._reliefMap === gameState.map) return this._reliefLayer;
    var map = gameState.map;
    var regions = this._reliefRegions(map);
    this._reliefMap = map;
    if (!regions.length) { this._reliefLayer = null; return null; }
    var cv = document.createElement('canvas');
    cv.width = MAP_WIDTH * TILE_SIZE; cv.height = MAP_HEIGHT * TILE_SIZE;
    var g = cv.getContext('2d');
    var hills = [], bags = [];
    regions.forEach(function (r) { (r.kind === 'hill' ? hills : bags).push(r); });
    if (hills.length) this._bakeHills(g, map, hills);
    if (bags.length) this._bakeSandbags(g, map, bags);
    this._reliefLayer = cv;
    return cv;
  }

  /** 坡面：高程场细采样后逐像素着色（外溢一格画山脚投影），再用矢量补崖口、落石与草丛 */
  _bakeHills(g, map, regions) {
    var E = this._buildElevation(map);
    var SS = 4, CELL = TILE_SIZE / SS;
    var W = MAP_WIDTH * SS, H = MAP_HEIGHT * SS;
    var F = new Float32Array(W * H);
    for (var cy = 0; cy < H; cy++) {
      var gy = cy / SS - 0.5;
      for (var cx = 0; cx < W; cx++) F[cy * W + cx] = sampleElevation(E, cx / SS - 0.5, gy);
    }
    var inSet = [], apron = {};
    for (var y0 = 0; y0 < MAP_HEIGHT; y0++) inSet[y0] = new Uint8Array(MAP_WIDTH);
    regions.forEach(function (r) { r.tiles.forEach(function (p) { inSet[p[1]][p[0]] = 1; }); });
    var tiles = [];
    regions.forEach(function (r) {
      r.tiles.forEach(function (p) {
        tiles.push(p);
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var ax = p[0] + dx, ay = p[1] + dy;
            if (ax < 0 || ay < 0 || ax >= MAP_WIDTH || ay >= MAP_HEIGHT || inSet[ay][ax]) continue;
            apron[ax + ',' + ay] = 1;
          }
        }
      });
    });
    Object.keys(apron).forEach(function (k) { var a = k.split(','); tiles.push([+a[0], +a[1]]); });

    var img = g.createImageData(TILE_SIZE, TILE_SIZE);
    var d = img.data;
    for (var ti = 0; ti < tiles.length; ti++) {
      var ox = tiles[ti][0] * TILE_SIZE, oy = tiles[ti][1] * TILE_SIZE;
      for (var j = 0; j < TILE_SIZE; j++) {
        for (var i = 0; i < TILE_SIZE; i++) {
          var o = (j * TILE_SIZE + i) * 4;
          var px = ox + i, py = oy + j;
          var cxi = (px / CELL) | 0, cyi = (py / CELL) | 0;
          if (cxi > W - 1) cxi = W - 1;
          if (cyi > H - 1) cyi = H - 1;
          var idx = cyi * W + cxi;
          var e = F[idx];
          if (e <= 0.02) { d[o + 3] = 0; continue; }
          var el = cxi > 0 ? F[idx - 1] : e, er = cxi < W - 1 ? F[idx + 1] : e;
          var eu = cyi > 0 ? F[idx - W] : e, ed = cyi < H - 1 ? F[idx + W] : e;
          var sx = (er - el) / (2 * CELL) * HILL_RELIEF, sy = (ed - eu) / (2 * CELL) * HILL_RELIEF;
          var inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
          var diff = (-sx * LX - sy * LY + LZ) * inv;
          if (diff < 0) diff = 0;
          var sh = 0.54 + 0.92 * diff;
          var dq = e - (e | 0) - 0.5;
          sh *= 1 - 0.10 * Math.exp(-dq * dq * 42);                        // 等高线：半格处一道暗棱
          sh *= 1 + ((((px * 73856093) ^ (py * 19349663)) >>> 9) & 255) / 255 * 0.06 - 0.03;  // 砂砾噪点
          var a = smooth01(0.30, 0.55, e);
          if (a <= 0.02) {                                                  // 山脚外侧的接地投影
            d[o] = 12; d[o + 1] = 26; d[o + 2] = 9;
            d[o + 3] = 255 * 0.30 * (1 - smooth01(0.02, 0.32, e));
            continue;
          }
          var col = reliefColor(e / 4.2);
          d[o] = Math.min(255, col[0] * sh);
          d[o + 1] = Math.min(255, col[1] * sh);
          d[o + 2] = Math.min(255, col[2] * sh);
          d[o + 3] = 255 * a;
        }
      }
      g.putImageData(img, ox, oy);
    }

    // 台地崖口：平顶与坡地交界压一道暗线、上方补一条受光棱，山头的体积全靠这一圈
    var isTop = function (x, y) {
      return x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT && map.terrain[y][x] === HILL_TOP;
    };
    var isHill = function (x, y) {
      return x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT &&
        (map.terrain[y][x] === HILL || map.terrain[y][x] === HILL_TOP);
    };
    regions.forEach(function (r) {
      g.lineWidth = 1.6;
      r.tiles.forEach(function (p) {
        var x = p[0] * TILE_SIZE, y = p[1] * TILE_SIZE;
        if (isTop(p[0], p[1])) {
          for (var s = 0; s < 4; s++) {
            if (isTop(p[0] + DX4[s], p[1] + DY4[s])) continue;
            var horiz = s === 0 || s === 2;
            var wy = horiz ? y + (s === 0 ? 1 : TILE_SIZE - 1) : y + 1;
            var wx = horiz ? x + 1 : x + (s === 3 ? 1 : TILE_SIZE - 1);
            g.strokeStyle = 'rgba(20,28,14,0.62)';
            g.beginPath();
            if (horiz) { g.moveTo(x, wy); g.lineTo(x + TILE_SIZE, wy); }
            else { g.moveTo(wx, y); g.lineTo(wx, y + TILE_SIZE); }
            g.stroke();
            g.strokeStyle = 'rgba(228,234,198,0.34)';
            g.beginPath();
            if (horiz) { g.moveTo(x, wy - (s === 0 ? 1.6 : -1.6)); g.lineTo(x + TILE_SIZE, wy - (s === 0 ? 1.6 : -1.6)); }
            else { g.moveTo(wx - (s === 3 ? 1.6 : -1.6), y); g.lineTo(wx - (s === 3 ? 1.6 : -1.6), y + TILE_SIZE); }
            g.stroke();
          }
        }
        // 山脚草丛：只在与草地接壤的那条边上补几簇，把笔直的格边打散
        if (!isTop(p[0], p[1])) {
          for (var s2 = 0; s2 < 4; s2++) {
            if (isHill(p[0] + DX4[s2], p[1] + DY4[s2])) continue;
            for (var k = 0; k < 3; k++) {
              var along = ((p[0] * 13 + p[1] * 7 + k * 11 + r.seed) % 27) + 2;
              var tx2 = s2 === 0 ? x + along : s2 === 2 ? x + along : s2 === 3 ? x + 3 : x + TILE_SIZE - 3;
              var ty2 = s2 === 0 ? y + 2 : s2 === 2 ? y + TILE_SIZE - 1 : s2 === 3 ? y + along : y + along;
              drawTuft(g, tx2, ty2, 4 + (k % 2) * 2);
            }
          }
        }
      });
      // 落石与碎石：位置按区域序号固定，保证同一座山每帧一致
      var box = r.box, span = function (n, m) { return ((n % m) + m) % m; };
      for (var b = 0; b < 6; b++) {
        var bx = box.x0 + span(r.seed + b * 37, box.x1 - box.x0 + 1);
        var by = box.y0 + span(r.seed + b * 53, box.y1 - box.y0 + 1);
        if (!isHill(bx, by)) continue;
        drawBoulder(g, bx * TILE_SIZE + 8 + span(b * 13 + r.seed, 17),
          by * TILE_SIZE + 12 + span(b * 19 + r.seed, 13), isTop(bx, by) ? 4.4 : 3.2);
      }
    });
  }

  /** 沙袋阵地：踩实的沙土地面 + 沿外缘连续砌的袋墙 + 长边中段留射击缺口 */
  _bakeSandbags(g, map, regions) {
    var S = TILE_SIZE;
    regions.forEach(function (r) {
      var box = r.box;
      var inBag = {};
      r.tiles.forEach(function (p) { inBag[p[0] + ',' + p[1]] = 1; });
      // 地面用整块区域的渐变，而不是每格一个色——否则阵地内部会显出棋盘格
      var grd = g.createLinearGradient(box.x0 * S, box.y0 * S,
        box.x0 * S + (box.x1 - box.x0 + 1) * S * 0.4, box.y0 * S + (box.y1 - box.y0 + 1) * S);
      grd.addColorStop(0, '#ab9765'); grd.addColorStop(0.55, '#9c8551'); grd.addColorStop(1, '#8b7549');
      r.tiles.forEach(function (p) {
        var x = p[0] * S, y = p[1] * S;
        g.fillStyle = grd; g.fillRect(x, y, S, S);
        for (var n = 0; n < 6; n++) {
          var hx = x + ((n * 13 + p[0] * 7 + p[1] * 5 + r.seed) % 29) + 1;
          var hy = y + ((n * 17 + p[1] * 11 + p[0] * 3) % 29) + 1;
          g.fillStyle = n % 2 ? 'rgba(70,55,28,0.20)' : 'rgba(233,213,166,0.16)';
          g.fillRect(hx, hy, 2, 1);
        }
      });
      // 外缘：同一条直线上的相邻边并成连续段，整段一次砌墙，接缝与拐角自然连上
      var segs = {};
      r.tiles.forEach(function (p) {
        for (var s = 0; s < 4; s++) {
          if (inBag[(p[0] + DX4[s]) + ',' + (p[1] + DY4[s])]) continue;
          var horiz = s === 0 || s === 2;
          var across = horiz ? p[1] * S + (s === 0 ? 4 : S - 11) : p[0] * S + (s === 3 ? 4 : S - 11);
          var key = s + ':' + across;
          var a = (horiz ? p[0] : p[1]) * S;
          (segs[key] || (segs[key] = [])).push([a, a + S]);
        }
      });
      Object.keys(segs).forEach(function (key) {
        var side = +key.charAt(0), across = +key.split(':')[1];
        var list = segs[key].sort(function (a, b) { return a[0] - b[0]; });
        var runs = [];
        list.forEach(function (sg) {
          var last = runs[runs.length - 1];
          if (last && last[1] === sg[0]) last[1] = sg[1];
          else runs.push([sg[0], sg[1]]);
        });
        runs.forEach(function (run) {
          var len = run[1] - run[0];
          var parts = len >= 4 * S ? [[run[0], run[0] + len * 0.40], [run[0] + len * 0.62, run[1]]] : [run];
          parts.forEach(function (pt) {
            if (pt[1] - pt[0] < 5) return;
            if (side === 0 || side === 2) {
              g.fillStyle = 'rgba(44,35,16,0.30)';
              g.fillRect(pt[0], side === 0 ? across + 6.6 : across - 2.4, pt[1] - pt[0], 2.6);
              drawSandbagWall(g, pt[0], pt[1], across, 2);
            } else {
              g.save();
              g.translate(across + 6, 0);
              g.rotate(Math.PI / 2);
              g.fillStyle = 'rgba(44,35,16,0.30)';
              g.fillRect(pt[0], side === 3 ? -2.6 : 8.6, pt[1] - pt[0], 2.6);
              drawSandbagWall(g, pt[0], pt[1], 0, 2);
              g.restore();
            }
          });
        });
      });
      // 蹲位投影：让阵地看起来真的有人在用，而不只是一块沙色贴图
      r.tiles.forEach(function (p, i) {
        if ((i + r.seed) % 3) return;
        g.fillStyle = 'rgba(58,45,20,0.16)';
        g.beginPath();
        g.ellipse(p[0] * S + 16, p[1] * S + 19, 8, 4.2, 0, 0, Math.PI * 2);
        g.fill();
      });
    });
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

  render(gameState, camera, frameCount, selectedUnits, selectedBuilding, placingBuilding, placingType, mouse, activeAction, superWeaponTargeting, gamePaused, viewWidth, viewHeight) {
    var ctx = this.ctx;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    var zoom = camera.zoom;
    ctx.save();
    ctx.translate(layout.chatWidth, 0);   // 地图右移一个左侧聊天栏宽度（聊天栏与右侧栏之间才是可视区）
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
          // 山包/山顶/沙袋只铺草地底：真正的起伏与袋墙由整幅烘焙层在循环后一次覆盖绘制
          ctx.drawImage(this.getTileCanvas(GRASS, tx, ty), sx, sy);
        } else {
          ctx.drawImage(this.getTileCanvas(terrain, tx, ty), sx, sy);
        }
      }
    }

    // 起伏层（山包 / 沙袋阵地）：连续高程着色 + 柔和山脚，覆盖在草地底上
    var relief = this._getReliefLayer(gameState);
    if (relief) {
      var rsx = startTX * TILE_SIZE, rsy = startTY * TILE_SIZE;
      var rw = (endTX - startTX) * TILE_SIZE, rh = (endTY - startTY) * TILE_SIZE;
      ctx.drawImage(relief, rsx, rsy, rw, rh, rsx, rsy, rw, rh);
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

    // 地图坐标标尺 + 鼠标格坐标提示：让玩家随时读出格子坐标，方便报点指挥
    this._renderCoordinateRulers(ctx, camera, mouse, viewWidth, viewHeight);

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
      ctx.fillRect(layout.chatWidth, 0, viewWidth, this.canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 36px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('\u6682\u505C', layout.chatWidth + viewWidth / 2, this.canvas.height / 2);
      ctx.font = '14px Arial';
      ctx.fillStyle = '#aaa';
      ctx.fillText('\u6309 Space \u7EE7\u7EED', layout.chatWidth + viewWidth / 2, this.canvas.height / 2 + 30);
      ctx.textAlign = 'left';
    }

    this.renderMinimap(gameState, camera, frameCount, viewWidth);
  }

  /**
   * 地图坐标标尺：屏幕固定的顶部横轴 + 左侧纵轴，刻度随镜头滚动换值。
   * 配合鼠标所在格坐标提示，玩家可以随时报出"x,y"格子坐标指挥队员——
   * 队员收到坐标命令会走到对应位置，即使目标不在其视野内。
   */
  _renderCoordinateRulers(ctx, camera, mouse, viewWidth, viewHeight) {
    var RULER_W = 30, RULER_H = 22;                 // 左竖条宽 / 顶横条高（像素）
    var ts = TILE_SIZE * camera.zoom;               // 缩放后每格像素
    var step = ts >= 26 ? 1 : (ts >= 15 ? 2 : 4);   // 刻度密度随缩放自适应
    var bar = 'rgba(8,10,13,0.72)';
    var edge = 'rgba(255,255,255,0.35)';
    var tick = 'rgba(255,255,255,0.30)';
    var text = 'rgba(226,232,238,0.92)';
    var ox = layout.chatWidth;
    ctx.save();
    ctx.font = '10px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 顶部横条（x 轴刻度）
    ctx.fillStyle = bar;
    ctx.fillRect(ox, 0, viewWidth, RULER_H);
    ctx.fillStyle = edge;
    ctx.fillRect(ox, RULER_H - 1, viewWidth, 1);
    var tx0 = Math.max(0, Math.floor(camera.x / camera.zoom / TILE_SIZE));
    var tx1 = Math.min(MAP_WIDTH - 1, Math.floor((camera.x + viewWidth) / camera.zoom / TILE_SIZE));
    for (var tx = tx0; tx <= tx1; tx++) {
      if (tx % step !== 0) continue;
      var sx = ox + tx * ts - camera.x;
      ctx.fillStyle = tick;
      ctx.fillRect(Math.round(sx) - 0.5, RULER_H - 4, 1, 4);
      ctx.fillStyle = text;
      ctx.fillText(String(tx), sx + ts / 2, RULER_H / 2 - 1);
    }

    // 左侧竖条（y 轴刻度）
    ctx.fillStyle = bar;
    ctx.fillRect(ox, RULER_H, RULER_W, viewHeight - RULER_H);
    ctx.fillStyle = edge;
    ctx.fillRect(ox + RULER_W - 1, RULER_H, 1, viewHeight - RULER_H);
    var ty0 = Math.max(0, Math.floor(camera.y / camera.zoom / TILE_SIZE));
    var ty1 = Math.min(MAP_HEIGHT - 1, Math.floor((camera.y + viewHeight) / camera.zoom / TILE_SIZE));
    for (var ty = ty0; ty <= ty1; ty++) {
      if (ty % step !== 0) continue;
      var sy = ty * ts - camera.y;
      ctx.fillStyle = tick;
      ctx.fillRect(ox + RULER_W - 4, Math.round(sy) - 0.5, 4, 1);
      ctx.fillStyle = text;
      ctx.fillText(String(ty), ox + RULER_W / 2, sy + ts / 2);
    }

    // 左上角十字区
    ctx.fillStyle = bar;
    ctx.fillRect(ox, 0, RULER_W, RULER_H);
    ctx.fillStyle = text;
    ctx.fillText('x\\y', ox + RULER_W / 2, RULER_H / 2 - 1);

    // 鼠标所在格坐标提示：指哪读哪，报点更顺手
    if (mouse.inCanvas) {
      var mx = mouse.x - ox;
      if (mx >= 0 && mx < viewWidth && mouse.y >= 0 && mouse.y < viewHeight) {
        var wx = (mx + camera.x) / camera.zoom;
        var wy = (mouse.y + camera.y) / camera.zoom;
        var gx = Math.floor(wx / TILE_SIZE), gy = Math.floor(wy / TILE_SIZE);
        if (gx >= 0 && gx < MAP_WIDTH && gy >= 0 && gy < MAP_HEIGHT) {
          var label = '格 (' + gx + ',' + gy + ')';
          ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
          ctx.textAlign = 'left';
          var lw = ctx.measureText(label).width + 12;
          var lx = mouse.x + 14, ly = mouse.y + 20;
          if (lx + lw > ox + viewWidth) lx = mouse.x - lw - 10;
          if (ly > this.canvas.height - 10) ly = mouse.y - 24;
          ctx.fillStyle = 'rgba(8,10,13,0.8)';
          ctx.fillRect(lx, ly - 12, lw, 19);
          ctx.fillStyle = '#ffd76a';
          ctx.fillText(label, lx + 6, ly + 2);
        }
      }
    }
    ctx.restore();
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
