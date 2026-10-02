// 相机夹取：地图比视口大时夹在边界内；比视口小时居中，避免拖到头露出大片黑框

import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE } from '../constants.js';

/**
 * @param camera { x, y, zoom }
 * @param viewW 可用视口宽（已扣除侧栏）
 * @param viewH 可用视口高（已扣除底部聊天栏）
 */
export function clampCameraToMap(camera, viewW, viewH) {
  const mapW = MAP_WIDTH * TILE_SIZE * camera.zoom;
  const mapH = MAP_HEIGHT * TILE_SIZE * camera.zoom;
  if (mapW <= viewW) camera.x = -(viewW - mapW) / 2;        // 居中
  else camera.x = Math.max(0, Math.min(mapW - viewW, camera.x));
  if (mapH <= viewH) camera.y = -(viewH - mapH) / 2;
  else camera.y = Math.max(0, Math.min(mapH - viewH, camera.y));
}
