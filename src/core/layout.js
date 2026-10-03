// 界面布局单一事实源：左侧聊天栏（可拖宽）+ 右侧栏 + 顶栏
//
// 沙盘把基座「底部聊天栏」改为「左侧竖排聊天栏」，宽度与右侧栏一致（300px）且可拖动调宽。
// 地图可视区 = 视窗宽 − 聊天栏宽 − 右侧栏宽；可视高 = 视窗高（底部不再预留聊天栏）。
// 相机/输入/渲染三处都从这里读，替代散落的 canvas.width - 300 与 CHAT_PANEL_HEIGHT。

export const SIDEBAR_WIDTH = 300;   // 右侧栏固定宽
export const TOPBAR_HEIGHT = 44;
export const CHAT_MIN_WIDTH = 220;  // 聊天栏可拖范围
export const CHAT_MAX_WIDTH = 600;

export const layout = {
  chatWidth: 300,   // 左侧聊天栏当前宽度（拖把手实时改）
};

// getter 而非字段：聊天栏拖宽 / 窗口缩放后即时反映最新值
Object.defineProperty(layout, 'viewW', {
  get() { return Math.max(0, window.innerWidth - layout.chatWidth - SIDEBAR_WIDTH); },
});
Object.defineProperty(layout, 'viewH', {
  get() { return window.innerHeight; },
});
