// 语音输入：按住键说话 → 语音转文字 → 作为上帝命令发出
//
// 用浏览器内置的 Web Speech API（Chrome/Edge 支持，localhost 属于安全上下文可直接用）。
// 关键坑：识别引擎在"静音超时"或一段话结束后会自行 onend，导致按住说话时被切断。
// 解决：continuous 模式 + onend 时若用户仍按住就立刻重启识别，跨段累计最终文本，
// 直到用户松开才把累计文本作为一条命令提交。

export class VoiceInput {
  constructor() {
    this.recognition = null;
    this.listening = false;
    this.supported = false;
    this._callbacks = null;
    this._desiredOn = false;   // 用户是否还按着（决定 onend 后是否续听）
    this._accumulated = '';    // 跨段累计的最终文本
    this._interim = '';        // 当前段的中间结果
    this._restartTimer = null;
    this._fatal = false;       // 致命错误（如麦克风被拒），不再自动重启
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
    if (!Ctor) { this.supported = false; return false; }
    this.supported = true;
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;      // 持续听，避免一句话结束就断开
    rec.interimResults = true;

    rec.onstart = () => {
      this.listening = true;
      if (this._callbacks.onState) this._callbacks.onState('listening', '');
    };

    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) this._accumulated += r[0].transcript;
        else interim += r[0].transcript;
      }
      this._interim = interim;
      if (this._callbacks.onPartial) this._callbacks.onPartial((this._accumulated + interim).trim());
    };

    rec.onerror = (ev) => {
      const code = ev && ev.error ? ev.error : 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        // 致命：权限被拒，不再重启，避免反复弹
        this._fatal = true;
        this.listening = false;
        if (this._callbacks.onState) {
          this._callbacks.onState('error', '麦克风权限被拒绝：请在浏览器地址栏允许麦克风后重试');
        }
      } else if (code === 'network') {
        this._fatal = true;
        this.listening = false;
        if (this._callbacks.onState) {
          this._callbacks.onState('error', '语音识别服务不可达（浏览器内置识别依赖联网）：可挂代理重试');
        }
      } else {
        // no-speech / aborted 等：不致命，onend 会按需重启
        if (this._callbacks.onState && code !== 'no-speech' && code !== 'aborted') {
          this._callbacks.onState('error', '语音识别出错：' + code);
        }
      }
    };

    rec.onend = () => {
      this.listening = false;
      if (this._desiredOn && !this._fatal) {
        // 用户还按着：自动续听，跨段继续累计
        if (this._restartTimer) clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => { this._tryStart(); }, 120);
        return;
      }
      // 松开才提交累计结果
      const text = (this._accumulated || this._interim).trim();
      if (this._callbacks.onState) this._callbacks.onState('idle', '');
      if (text && this._callbacks.onFinal) this._callbacks.onFinal(text);
    };

    this.recognition = rec;
    return true;
  }

  _tryStart() {
    if (!this.recognition || this._fatal || !this._desiredOn) return;
    try {
      this.recognition.start();
    } catch (e) { /* InvalidStateError：已在识别中，忽略 */ }
  }

  start() {
    if (!this.recognition || this._fatal) return false;
    this._desiredOn = true;
    this._accumulated = '';
    this._interim = '';
    if (this._callbacks.onPartial) this._callbacks.onPartial('');
    this._tryStart();
    return true;
  }

  stop() {
    this._desiredOn = false;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this.recognition) {
      try { this.recognition.stop(); } catch (e) { /* 忽略 */ }
    }
    return true;
  }
}
