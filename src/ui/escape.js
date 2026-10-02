// HTML 转义：面板会用 innerHTML 拼卡片，而台词/意图来自 LLM 输出，必须转义后再插入

export function escapeHtml(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
