// 语音输入：按住键说话 → 语音转文字 → 作为上帝命令发出
//
// 用浏览器内置的 Web Speech API（Chrome/Edge 支持，localhost 属于安全上下文可直接用）。
// 注意：Chrome 的识别服务在部分网络环境下不可达（报 network 错误），
// 此时会给出明确提示；若需要，可在配置页改用自建 ASR 端点（见 README）。

export class VoiceInput {
  constructor() {
    this.recognition = null;
    this.listening = false;
    this.supported = false;
    this._callbacks = null;
    this._finalText = '';
    this._interimText = '';
  }

  static isSupported() {
    return typeof window !== 'undefined' &&
      !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  init(callbacks) {
    this._callbacks = callbacks || {};
    const Ctor = typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null;
    if (!Ctor) {
      this.supported = false;
      return false;
    }
    this.supported = true;
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.interimResults = true;

    rec.onstart = () => {
      this.listening = true;
      this._finalText = '';
      this._interimText = '';
      if (this._callbacks.onState) this._callbacks.onState('listening', '');
    };

    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) this._finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this._interimText = interim;
      const shown = (this._finalText + interim).trim();
      if (this._callbacks.onPartial) this._callbacks.onPartial(shown);
    };

    rec.onerror = (ev) => {
      this.listening = false;
      const code = ev && ev.error ? ev.error : 'unknown';
      let msg = '语音识别出错：' + code;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        msg = '麦克风权限被拒绝：请在浏览器地址栏允许麦克风后重试';
      } else if (code === 'network') {
        msg = '语音识别服务不可达（浏览器内置识别依赖联网服务）：可挂代理重试，或改用配置页里的自建 ASR 端点';
      } else if (code === 'no-speech') {
        msg = '没听到声音，再试一次（按住 V 说话）';
      }
      if (this._callbacks.onState) this._callbacks.onState('error', msg);
    };

    rec.onend = () => {
      const wasListening = this.listening;
      this.listening = false;
      const text = (this._finalText || this._interimText).trim();
      if (this._callbacks.onState) this._callbacks.onState('idle', '');
      if (wasListening && text && this._callbacks.onFinal) this._callbacks.onFinal(text);
    };

    this.recognition = rec;
    return true;
  }

  start() {
    if (!this.recognition || this.listening) return false;
    try {
      this.recognition.start();
      return true;
    } catch (e) {
      // 连续 start 会抛 InvalidStateError，忽略即可
      return false;
    }
  }

  stop() {
    if (!this.recognition || !this.listening) return false;
    try { this.recognition.stop(); } catch (e) { /* 忽略 */ }
    return true;
  }
}
