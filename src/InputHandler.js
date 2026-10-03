import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, CONCRETE } from './constants.js';
import { BUILDING_DEFS, DEFENSE_DEFS, UNIT_DEFS } from './definitions.js';
import { clampCameraToMap } from './core/camera.js';
import { layout } from './core/layout.js';

export class InputHandler {
  constructor(canvas, minimapCanvas) {
    this.canvas = canvas;
    this.minimapCanvas = minimapCanvas;
    this.keys = {};
    this.mouse = { x: 0, y: 0, worldX: 0, worldY: 0, mapX: 0, mapY: 0, down: false, inCanvas: false };
    this.pendingAttackMove = false;
    this._callbacks = null;
    this._gameState = null;
    this._camera = null;
    this.lastNumberKey = 0;
    this.lastNumberTime = 0;
    // 左键拖拽平移视野（右击选成员、再右键地图下令）
    this.panning = { active: false, lastX: 0, lastY: 0 };
  }

  /**
   * 读档后重新绑定世界与相机。
   * 读档会构造全新的 GameState / camera 对象，而 setup 中的事件闭包捕获的是
   * 初次 setup 时的引用。若不重新绑定，读档后所有鼠标操作（选成员、建造放置、
   * 移动命令、拖图、滚轮缩放、小地图导航）都会作用在读档前的旧世界上。
   */
  rebind(gameState, camera) {
    this._gameState = gameState;
    this._camera = camera;
  }

  setup(gameState, camera, callbacks) {
    this._gameState = gameState;
    this._camera = camera;
    this._callbacks = callbacks;
    var self = this;
    var canvas = this.canvas;
    var mouse = this.mouse;

    canvas.addEventListener('mousemove', function(ev) {
      var rect = canvas.getBoundingClientRect();
      mouse.x = ev.clientX - rect.left;
      mouse.y = ev.clientY - rect.top;
      var viewW = layout.viewW;
      var viewH = layout.viewH;
      mouse.inCanvas = (mouse.x >= layout.chatWidth && mouse.x < layout.chatWidth + viewW && mouse.y >= 0 && mouse.y < viewH);
      var clampedX = Math.max(layout.chatWidth, Math.min(layout.chatWidth + viewW, mouse.x));
      var clampedY = Math.max(0, Math.min(viewH, mouse.y));
      mouse.worldX = (clampedX - layout.chatWidth + self._camera.x) / self._camera.zoom;
      mouse.worldY = (clampedY + self._camera.y) / self._camera.zoom;
      mouse.mapX = Math.max(0, Math.min(MAP_WIDTH - 1, Math.floor(mouse.worldX / TILE_SIZE)));
      mouse.mapY = Math.max(0, Math.min(MAP_HEIGHT - 1, Math.floor(mouse.worldY / TILE_SIZE)));
      // 左键/中键拖拽：按住平移视野（红警/RTS 的常见操作）
      if (self.panning.active) {
        const dx = ev.clientX - self.panning.lastX;
        const dy = ev.clientY - self.panning.lastY;
        self.panning.lastX = ev.clientX;
        self.panning.lastY = ev.clientY;
        self._camera.x -= dx;
        self._camera.y -= dy;
        clampCameraToMap(self._camera, layout.viewW, layout.viewH);
      }
    });

    canvas.addEventListener('mousedown', function(ev) {
      // 中键：开始拖拽视野（同时阻止浏览器默认的自动滚动）
      if (ev.button === 1) {
        ev.preventDefault();
        self.panning.active = true;
        self.panning.lastX = ev.clientX;
        self.panning.lastY = ev.clientY;
        return;
      }
      if (ev.button === 0) {
        // 左键：特殊模式（超武瞄准/修理/出售/放置）优先；否则进入「抓取地图」平移
        if (callbacks.superWeaponTargeting && mouse.inCanvas) {
          if (callbacks.onSuperWeaponFire) callbacks.onSuperWeaponFire(callbacks.superWeaponTargeting, mouse.mapX, mouse.mapY);
          return;
        }
        if (callbacks.activeAction === 'repair') {
          var clk = self._gameState.getEntityAt(mouse.worldX, mouse.worldY);
          if (clk && clk.team === self._gameState.humanTeam && clk.isBuilding && !clk.dead) callbacks.onRepair(clk);
          return;
        }
        if (callbacks.activeAction === 'sell') {
          var clk2 = self._gameState.getEntityAt(mouse.worldX, mouse.worldY);
          if (clk2 && clk2.team === self._gameState.humanTeam && clk2.isBuilding && !clk2.dead) callbacks.onSell(clk2);
          return;
        }
        if (callbacks.placingBuilding && callbacks.placingType && mouse.inCanvas) {
          var pDef = BUILDING_DEFS[callbacks.placingType] || DEFENSE_DEFS[callbacks.placingType];
          if (pDef && self._gameState.map.isBuildable(mouse.mapX, mouse.mapY, pDef.size) &&
              self._gameState.map.isNearBuilding(mouse.mapX, mouse.mapY, pDef.size, self._gameState.humanTeam)) {
            self._gameState.playerCredits -= pDef.cost;
            var nb = self._gameState.spawnEntity(callbacks.placingType, self._gameState.humanTeam, mouse.mapX, mouse.mapY);
            for (var ci = 0; ci < nb.size; ci++) for (var cj = 0; cj < nb.size; cj++) {
              if (mouse.mapY + ci < MAP_HEIGHT && mouse.mapX + cj < MAP_WIDTH) self._gameState.map.terrain[mouse.mapY + ci][mouse.mapX + cj] = CONCRETE;
            }
            if (!ev.shiftKey) { callbacks.placingBuilding = false; callbacks.placingType = null; }
            callbacks.onNotify(pDef.name + ' \u5f00\u59cb\u5efa\u9020', 'info');
            callbacks.onPlayBuildSound();
          } else { callbacks.onNotify('\u65e0\u6cd5\u5728\u6b64\u5904\u5efa\u9020', 'warn'); callbacks.onPlayCancelSound(); }
          return;
        }
        // 左键抓取移动地图
        self.panning.active = true;
        self.panning.lastX = ev.clientX;
        self.panning.lastY = ev.clientY;
      }
    });

    canvas.addEventListener('mouseup', function(ev) {
      if (ev.button === 0 || ev.button === 1) { self.panning.active = false; }
    });

    canvas.addEventListener('contextmenu', function(ev) {
      ev.preventDefault();
      // 攻击移动（A 键）标志：任何一次右键都消费它
      var amMove = self.pendingAttackMove;
      self.pendingAttackMove = false;
      if (callbacks.superWeaponTargeting) { callbacks.superWeaponTargeting = null; if (callbacks.onNotify) callbacks.onNotify('\u5df2\u53d6\u6d88', 'info'); return; }
      if (callbacks.placingBuilding) { callbacks.placingBuilding = false; callbacks.placingType = null; callbacks.onPlayCancelSound(); return; }
      if (callbacks.activeAction) {
        callbacks.activeAction = null;
        document.getElementById('btnRepair').classList.remove('active');
        document.getElementById('btnSell').classList.remove('active');
        return;
      }
      var rc = self._gameState.getEntityAt(mouse.worldX, mouse.worldY);

      // 右键点己方成员 → 选中（Shift 加选/减选；单选则清空重选）
      if (rc && !rc.dead && !rc.isMount && !rc.isBuilding && rc.team === self._gameState.humanTeam) {
        if (ev.shiftKey) {
          var si = callbacks.selectedUnits.indexOf(rc);
          if (si >= 0) { rc.selected = false; callbacks.selectedUnits.splice(si, 1); }
          else { rc.selected = true; callbacks.selectedUnits.push(rc); }
        } else {
          callbacks.selectedUnits.forEach(function(u) { u.selected = false; });
          callbacks.selectedUnits.length = 0;
          if (callbacks.selectedBuilding) { callbacks.selectedBuilding.selected = false; callbacks.selectedBuilding = null; }
          rc.selected = true;
          callbacks.selectedUnits.push(rc);
        }
        callbacks.onPlaySelectSound();
        return;
      }

      // 右键点敌方 → 命令当前选中成员攻击（作用域由 main 的 onMarkEnemy 按选中集处理）
      if (rc && !rc.dead && rc.team !== self._gameState.humanTeam && callbacks.onMarkEnemy) {
        callbacks.onMarkEnemy(rc);
        return;
      }

      if (callbacks.selectedUnits.length > 0) {
        if (rc && rc.isMount && rc.team === self._gameState.humanTeam && !rc.dead) {
          // 右键己方停放载具 → 走过去乘驾
          callbacks.selectedUnits.forEach(function(u) {
            if (!u.isMember || u.mountType) return;
            u.boardTarget = rc;
            u.attackTarget = null;
            u.attackMoveTarget = null;
            u.guardPos = null; u.fleeTo = null;
            u.path = self._gameState.map.findPath(Math.floor(u.x), Math.floor(u.y), Math.floor(rc.x), Math.floor(rc.y), 3000, u, true);
            u.pathIndex = 0;
          });
          callbacks.onNotify('\u524d\u5f80\u4e58\u9a7e ' + rc.name, 'info');
        } else if (rc && rc.team === self._gameState.humanTeam && rc.isBuilding && !rc.dead) {
          callbacks.selectedUnits.forEach(function(u) {
            if (u.canRepair) { u.attackTarget = rc; u.path = []; u.pathIndex = 0; }
            else u.guardPos = { x: Math.floor(rc.x), y: Math.floor(rc.y) };
            u.fleeTo = null;
          });
          callbacks.onNotify('\u62a4\u536b ' + rc.name, 'info');
        } else {
          // 空地：普通移动；A 键模式下为「攻击移动」（沿路遇敌即打）
          var cx = mouse.mapX, cy = mouse.mapY;
          var spread = Math.ceil(Math.sqrt(callbacks.selectedUnits.length));
          callbacks.selectedUnits.forEach(function(u, idx) {
            var ox = idx % spread - Math.floor(spread / 2);
            var oy = Math.floor(idx / spread) - Math.floor(spread / 2);
            var tx2 = Math.max(0, Math.min(MAP_WIDTH - 1, cx + ox));
            var ty2 = Math.max(0, Math.min(MAP_HEIGHT - 1, cy + oy));
            u.attackTarget = null;
            u.guardPos = null; u.fleeTo = null;
            u.burstRemaining = 0;
            u.attackMoveTarget = amMove ? { x: tx2, y: ty2 } : null;
            u.path = self._gameState.map.findPath(Math.floor(u.x), Math.floor(u.y), tx2, ty2, 3000, u, true);
            u.pathIndex = 0;
          });
          self._gameState.addFloatingText(mouse.worldX, mouse.worldY, amMove ? 'A\u2192' : '\u2192', amMove ? '#e67e22' : '#2ecc71');
        }
      }
      if (callbacks.selectedBuilding && callbacks.selectedBuilding.isBuilding) {
        if (rc && rc.team !== self._gameState.humanTeam && !rc.dead) {
          callbacks.selectedBuilding.rallyPoint = { x: Math.floor(rc.x), y: Math.floor(rc.y) };
          callbacks.onNotify('\u96c6\u5408\u70b9 \u2192 ' + rc.name, 'info');
        } else {
          callbacks.selectedBuilding.rallyPoint = { x: mouse.mapX, y: mouse.mapY };
          callbacks.onNotify('\u96c6\u5408\u70b9\u5df2\u8bbe\u7f6e', 'info');
        }
      }
    });

    document.addEventListener('keydown', function(ev) {
      self.keys[ev.code] = true;
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;

      if (ev.code === 'Escape') {
        if (callbacks.superWeaponTargeting) { callbacks.superWeaponTargeting = null; }
        else if (callbacks.placingBuilding) { callbacks.placingBuilding = false; callbacks.placingType = null; }
        else if (callbacks.activeAction) {
          callbacks.activeAction = null;
          document.getElementById('btnRepair').classList.remove('active');
          document.getElementById('btnSell').classList.remove('active');
        } else {
          callbacks.selectedUnits.forEach(function(u) { u.selected = false; });
          callbacks.selectedUnits.length = 0;
          if (callbacks.selectedBuilding) { callbacks.selectedBuilding.selected = false; callbacks.selectedBuilding = null; }
          callbacks.onHideHelp();
        }
      }
      if (ev.code === 'Delete' || ev.code === 'Backspace') {
        if (callbacks.selectedUnits.length > 0) {
          callbacks.selectedUnits.forEach(function(u) {
            u.selected = false;
            self._gameState.removeEntity(u);
          });
          callbacks.selectedUnits.length = 0;
          callbacks.onNotify('\u5df2\u5220\u9664\u9009\u4e2d\u5355\u4f4d', 'info');
        }
      }
      if (ev.code === 'Space') { ev.preventDefault(); callbacks.onTogglePause(); }
      if (ev.code === 'KeyH' && !ev.ctrlKey) { ev.preventDefault(); callbacks.onShowHelp(); }
      if (ev.code === 'KeyS' && !ev.ctrlKey && callbacks.selectedUnits.length > 0) { ev.preventDefault(); callbacks.onCommandStop(); }
      // W：切换选中成员的武器（机枪 ↔ 火箭筒）
      if (ev.code === 'KeyW' && !ev.ctrlKey && callbacks.selectedUnits.length > 0 && callbacks.onToggleWeapon) {
        ev.preventDefault();
        callbacks.onToggleWeapon();
      }
      if (ev.code === 'KeyA' && !ev.ctrlKey && callbacks.selectedUnits.length > 0) {
        ev.preventDefault();
        callbacks.onNotify('\u653b\u51fb\u6a21\u5f0f\uff1a\u79fb\u52a8\u5e76\u653b\u51fb\u6cbf\u9014\u654c\u4eba', 'info');
        self.pendingAttackMove = true;
      }
      if (ev.code === 'KeyG' && callbacks.selectedUnits.length > 0) {
        ev.preventDefault();
        callbacks.selectedUnits.forEach(function(u) {
          u.guardPos = { x: Math.floor(u.x), y: Math.floor(u.y) };
          u.path = []; u.pathIndex = 0; u.attackTarget = null;
        });
        callbacks.onNotify('\u5b88\u536b\u5f53\u524d\u4f4d\u7f6e', 'info');
      }
      if (ev.code === 'KeyA' && ev.ctrlKey) {
        ev.preventDefault();
        callbacks.selectedUnits.forEach(function(u) { u.selected = false; });
        var allUnits = self._gameState.getPlayerUnits();
        callbacks.selectedUnits.length = 0;
        allUnits.forEach(function(u) { u.selected = true; callbacks.selectedUnits.push(u); });
        if (callbacks.selectedBuilding) { callbacks.selectedBuilding.selected = false; callbacks.selectedBuilding = null; }
        callbacks.onPlaySelectSound();
      }
      if (ev.code === 'Home' || ev.code === 'Numpad5') {
        var base = self._gameState.entities.find(function(e) { return e.team === self._gameState.humanTeam && e.type === 'base'; });
        if (base) {
          self._camera.x = base.x * TILE_SIZE * self._camera.zoom - layout.viewW / 2;
          self._camera.y = base.y * TILE_SIZE * self._camera.zoom - canvas.height / 2;
          self._camera.x = Math.max(0, self._camera.x); self._camera.y = Math.max(0, self._camera.y);
        }
      }
      var keyMatch = ev.code.match(/^Digit([1-9])$/);
      if (keyMatch) {
        ev.preventDefault();
        var n = parseInt(keyMatch[1]);
        if (ev.ctrlKey) callbacks.onSetGroup(n);
        else callbacks.onSelectGroup(n);
      }
      if (ev.code === 'Tab') {
        ev.preventDefault();
        callbacks.onCycleTab();
      }
      if (ev.code === 'F5') { ev.preventDefault(); callbacks.onSaveGame(); }
      if (ev.code === 'F9') { ev.preventDefault(); callbacks.onLoadGame(); }
    });

    document.addEventListener('keyup', function(ev) {
      self.keys[ev.code] = false;
    });

    canvas.addEventListener('wheel', function(ev) {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        var oldZoom = self._camera.zoom;
        if (ev.deltaY < 0) self._camera.zoom = Math.min(2.0, self._camera.zoom + 0.1);
        else self._camera.zoom = Math.max(0.5, self._camera.zoom - 0.1);
        var zoomRatio = self._camera.zoom / oldZoom;
        var viewW = layout.viewW;
        self._camera.x = self._camera.x * zoomRatio + (mouse.x - layout.chatWidth - viewW / 2) * (1 - zoomRatio);
        self._camera.y = self._camera.y * zoomRatio + (mouse.y - canvas.height / 2) * (1 - zoomRatio);
      } else if (ev.shiftKey) {
        self._camera.x += ev.deltaY * 0.5;
      } else {
        self._camera.y += ev.deltaY * 0.5;
      }
      clampCameraToMap(self._camera, layout.viewW, layout.viewH);
    }, { passive: false });

    var mmCanvas = this.minimapCanvas;
    mmCanvas.addEventListener('mousedown', function(ev) {
      var rect = mmCanvas.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var sxR = mmCanvas.width / MAP_WIDTH, syR = mmCanvas.height / MAP_HEIGHT;
      if (ev.button === 2 && callbacks.selectedUnits.length > 0) {
        ev.preventDefault();
        var tmx = mx / sxR, tmy = my / syR;
        callbacks.selectedUnits.forEach(function(u, idx) {
          var spread = Math.ceil(Math.sqrt(callbacks.selectedUnits.length));
          var ox = idx % spread - Math.floor(spread / 2);
          var oy = Math.floor(idx / spread) - Math.floor(spread / 2);
          u.attackTarget = null;
          u.path = self._gameState.map.findPath(Math.floor(u.x), Math.floor(u.y),
            Math.max(0, Math.min(MAP_WIDTH - 1, Math.floor(tmx) + ox)),
            Math.max(0, Math.min(MAP_HEIGHT - 1, Math.floor(tmy) + oy)), 3000, u, true);
          u.pathIndex = 0;
        });
      } else {
        self._camera.x = Math.floor(mx / sxR * TILE_SIZE * self._camera.zoom - layout.viewW / 2);
        self._camera.y = Math.floor(my / syR * TILE_SIZE * self._camera.zoom - canvas.height / 2);
        clampCameraToMap(self._camera, layout.viewW, layout.viewH);
      }
    });
    mmCanvas.addEventListener('contextmenu', function(ev) { ev.preventDefault(); });

    window.addEventListener('resize', function() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    });

    canvas.addEventListener('mouseleave', function() {
      mouse.inCanvas = false;
    });
  }
}
