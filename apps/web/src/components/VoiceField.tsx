import { useEffect, useRef, useState } from 'react';

interface Recognition {
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type VoiceWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

let cancelActiveRecognition: (() => void) | undefined;

export function VoiceField({ multiline, onValueChange, ...field }: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  multiline?: boolean;
  maxLength: number;
  required?: boolean;
  placeholder?: string;
}) {
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState('');
  const recognition = useRef<Recognition | null>(null);
  const latest = useRef({ value: field.value, onValueChange });
  useEffect(() => {
    latest.current = { value: field.value, onValueChange };
  }, [field.value, onValueChange]);
  useEffect(() => () => {
    const engine = recognition.current;
    if (!engine) return;
    engine.onresult = engine.onerror = engine.onend = null;
    recognition.current = null;
    cancelActiveRecognition = undefined;
    engine.abort();
  }, []);

  function toggleVoice() {
    if (recognition.current) {
      setStatus('正在转写…');
      recognition.current.stop();
      return;
    }
    const browser = window as VoiceWindow;
    const Engine = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Engine) {
      setStatus('当前浏览器不支持网页语音输入，可以使用键盘上的话筒。');
      return;
    }
    cancelActiveRecognition?.();
    const engine = new Engine();
    recognition.current = engine;
    engine.lang = 'zh-CN';
    function finish() {
      engine.onresult = engine.onerror = engine.onend = null;
      recognition.current = null;
      cancelActiveRecognition = undefined;
      setListening(false);
    }
    cancelActiveRecognition = () => {
      finish();
      engine.abort();
      setStatus('');
    };
    engine.onresult = event => {
      const transcript = Array.from(event.results, result => result[0]?.transcript ?? '').join('').trim();
      const { value, onValueChange: update } = latest.current;
      const next = (value + transcript).slice(0, field.maxLength);
      if (next !== value) update(next);
      setStatus(next !== value ? '已填入，可以修改。' : '没有添加文字，请检查输入长度或重试。');
    };
    engine.onerror = event => {
      finish();
      setStatus(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? '麦克风或语音服务未获允许，请检查浏览器权限。'
        : '语音识别暂不可用，可以继续输入或重试。');
    };
    engine.onend = () => {
      finish();
      setStatus(current => current === '正在听…' || current === '正在转写…' ? '没有听清，可以再试一次。' : current);
    };
    try {
      engine.start();
      setListening(true);
      setStatus('正在听…');
    } catch {
      finish();
      setStatus('无法开启语音输入，请重试或使用键盘。');
    }
  }

  return (
    <div className="voice-field">
      <div className="voice-field-row">
        {multiline
          ? <textarea {...field} onChange={event => onValueChange(event.target.value)} />
          : <input {...field} onChange={event => onValueChange(event.target.value)} />}
        <button type="button" className="secondary voice-mic" aria-controls={field.id}
          aria-label={listening ? '结束语音输入' : '开始语音输入'} aria-pressed={listening}
          title={listening ? '结束语音输入' : '开始语音输入'} onClick={toggleVoice}>
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-3 0h6" />
          </svg>
        </button>
      </div>
      {status && <small className="voice-status" role="status">{status}</small>}
    </div>
  );
}
