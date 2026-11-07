// Speed Cube Tracker
// GANスマートキューブの操作・回転をタイムスタンプ付きで記録し、
// LLMに貼り付けやすいテキストとして出力するブラウザ専用ツール。
//
// ライブラリ(gan-web-bluetooth / rxjs / aes-js)は ./vendor/ に同梱しており、
// 実行時に外部CDN・サーバーへアクセスしません。
import { connectGanCube, cubeTimestampLinearFit } from './vendor/gan-web-bluetooth.js';

const $ = (id) => document.getElementById(id);

// ---- 状態 ----
let conn = null;           // GanCubeConnection
let sub = null;            // rxjs Subscription
let connectWallMs = 0;     // 接続時のDate.now()
let connectPerfMs = 0;     // 接続時のperformance.now()
let logLines = [];         // 出力テキスト(1行=1要素)
let headerLines = [];      // ヘッダー(ファイル先頭に付与)

let moveCount = 0;
let gyroSeen = 0;          // 受信したGYRO総数(間引き前)
let lastGyroLogMs = -1e9;  // 最後にGYROをログした相対ms
let lastQ = null, lastQMs = 0;
let lastMove = null;       // 直近のMOVE {move, serial, cubeT}
let dupCount = 0, missCount = 0, mismatchCount = 0, checkCount = 0;

// ---- 相対時刻(接続からの秒) ----
const relMs = () => performance.now() - connectPerfMs;

// =====================================================================
// MAC アドレス供給
//   1回目(非フォールバック): 保存済みがあれば即利用。無ければ null で自動取得に委ねる。
//   フォールバック: 自動取得に失敗したので手入力ダイアログを出す。
// =====================================================================
function macKey(name) { return 'sct:mac:' + (name || ''); }

function normalizeMac(input) {
  if (!input) return null;
  const hex = String(input).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

async function macProvider(device, isFallback) {
  const key = macKey(device.name);
  const saved = localStorage.getItem(key);
  if (!isFallback) {
    // 保存済みMACがあれば自動取得(約10秒待ち)を省略して即接続。
    return saved || null;
  }
  const entered = await askMacModal(device.name || '(不明なデバイス)', saved || '');
  const mac = normalizeMac(entered);
  if (mac) localStorage.setItem(key, mac);
  return mac;
}

// MAC 入力モーダル
function askMacModal(deviceName, prefill) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>MACアドレスの入力</h3>
        <p class="modal-text">デバイス <b>${escapeHtml(deviceName)}</b> のMACアドレスを自動取得できませんでした。<br>
        キューブのMACアドレスを入力してください（例: <code>AB:12:34:5F:00:01</code>）。<br>
        Android: Cube Station の端末情報、または nRF Connect などで確認できます。</p>
        <input type="text" class="modal-input" placeholder="AB:12:34:5F:00:01" value="${escapeHtml(prefill)}">
        <div class="modal-err"></div>
        <div class="modal-actions">
          <button class="btn modal-cancel">キャンセル</button>
          <button class="btn btn-primary modal-ok">接続</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.modal-input');
    const err = overlay.querySelector('.modal-err');
    input.focus();
    input.select();

    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-ok').onclick = () => {
      const v = input.value.trim();
      if (!normalizeMac(v)) { err.textContent = 'MACアドレスの形式が正しくありません（16進12桁）。'; return; }
      close(v);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') overlay.querySelector('.modal-ok').click();
      if (e.key === 'Escape') close(null);
    };
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =====================================================================
// 整合チェック(記録した手順をシミュレートし、キューブ報告のFACELETSと照合)
//   PERMテーブルは Kociemba 54文字表記(URFDLB順)に対する面回転の置換。
// =====================================================================
const PERM = {
  U: [6,3,0,7,4,1,8,5,2,45,46,47,12,13,14,15,16,17,9,10,11,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,18,19,20,39,40,41,42,43,44,36,37,38,48,49,50,51,52,53],
  R: [0,1,20,3,4,23,6,7,26,15,12,9,16,13,10,17,14,11,18,19,29,21,22,32,24,25,35,27,28,51,30,31,48,33,34,45,36,37,38,39,40,41,42,43,44,8,46,47,5,49,50,2,52,53],
  F: [0,1,2,3,4,5,44,41,38,6,10,11,7,13,14,8,16,17,24,21,18,25,22,19,26,23,20,15,12,9,30,31,32,33,34,35,36,37,27,39,40,28,42,43,29,45,46,47,48,49,50,51,52,53],
  D: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,24,25,26,18,19,20,21,22,23,42,43,44,33,30,27,34,31,28,35,32,29,36,37,38,39,40,41,51,52,53,45,46,47,48,49,50,15,16,17],
  L: [53,1,2,50,4,5,47,7,8,9,10,11,12,13,14,15,16,17,0,19,20,3,22,23,6,25,26,18,28,29,21,31,32,24,34,35,42,39,36,43,40,37,44,41,38,45,46,33,48,49,30,51,52,27],
  B: [11,14,17,3,4,5,6,7,8,9,10,35,12,13,34,15,16,33,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,36,39,42,2,37,38,1,40,41,0,43,44,51,48,45,52,49,46,53,50,47],
};
function applyMove(s, m) {
  const p = PERM[m[0]];
  if (!p) return s;
  const n = m.endsWith("'") ? 3 : (m.endsWith('2') ? 2 : 1);
  let a = s.split('');
  for (let k = 0; k < n; k++) a = p.map((i) => a[i]);
  return a.join('');
}
let simState = null; // 直近のFACELETS基準に手順を適用した状態

function checkConsistency(reported) {
  checkCount++;
  if (simState == null) {
    simState = reported;
    pushLog('CHECK', '基準状態をセットしました', 'meta');
    return;
  }
  if (reported === simState) {
    pushLog('CHECK', `整合OK（${checkCount}回目）`, 'meta');
  } else {
    mismatchCount++;
    const diff = [...reported].filter((c, i) => c !== simState[i]).length;
    pushLog('MISMATCH', `記録手順と実機が不一致（${diff}ステッカー差）→ 手の欠落/誤記録の可能性。基準を再セット`, 'err');
    simState = reported;
  }
  updateQuality();
}

// =====================================================================
// 画面消灯防止(Wake Lock)
// =====================================================================
let wakeLock = null;
async function acquireWakeLock() {
  if (!$('optWakeLock').checked) return;
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) { /* ユーザー操作が必要な場合など。無視して続行 */ }
}
async function releaseWakeLock() {
  try { if (wakeLock) await wakeLock.release(); } catch (_) {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && conn) acquireWakeLock();
});

// =====================================================================
// クォータニオン → オイラー角(度) / 角速度推定
// =====================================================================
function quatToEuler(q) {
  const { x, y, z, w } = q;
  const sinr = 2 * (w * x + y * z);
  const cosr = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr, cosr);
  let sinp = 2 * (w * y - z * x);
  sinp = Math.max(-1, Math.min(1, sinp));
  const pitch = Math.asin(sinp);
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny, cosy);
  const d = 180 / Math.PI;
  return { roll: roll * d, pitch: pitch * d, yaw: yaw * d };
}
function angSpeedFromQ(q1, q2, dtMs) {
  if (!q1 || !q2 || dtMs <= 0) return null;
  let dot = q1.x * q2.x + q1.y * q2.y + q1.z * q2.z + q1.w * q2.w;
  dot = Math.min(1, Math.abs(dot));
  const ang = 2 * Math.acos(dot);
  return ang / (dtMs / 1000); // rad/s
}

// =====================================================================
// ログ出力
// =====================================================================
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function fmtWall(ms) {
  const d = new Date(ms);
  const p = (v, n = 2) => String(v).padStart(n, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function fmtRel(ms) {
  const s = ms / 1000;
  return (s >= 0 ? '+' : '') + s.toFixed(3);
}

// type別の色クラス
const CLASS_FOR = { MOVE: '', ROT: 'dim', FACELETS: 'meta', BATTERY: 'meta', HARDWARE: 'meta', CONNECT: 'meta', DISCONNECT: 'meta', CHECK: 'meta', MISSED: 'warn', MISMATCH: 'err' };

// 1行をログ(画面+配列)に追加
function pushLog(type, detail, forceClass) {
  const wall = Date.now();
  const line = `${padL(fmtRel(relMs()), 9)}  ${fmtWall(wall)}  ${pad(type, 9)} ${detail}`;
  logLines.push(line);
  appendToView(line, forceClass || CLASS_FOR[type] || '');
}

const logEl = () => $('log');
function appendToView(line, cls) {
  const el = logEl();
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = line + '\n';
  el.appendChild(span);
  if ($('optAutoscroll').checked) el.scrollTop = el.scrollHeight;
}

// =====================================================================
// 画面(ステータス)更新
// =====================================================================
function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status status-' + (kind || 'idle');
}
function updateStats() {
  $('statMoves').textContent = String(moveCount);
}
function updateQuality() {
  $('statQuality').textContent = `重複 ${dupCount} ・ 欠落 ${missCount} ・ 不整合 ${mismatchCount}`;
}
function setConnectedUI(on) {
  $('btnConnect').disabled = on;
  $('btnDisconnect').disabled = !on;
  $('btnRefresh').disabled = !on;
}

// =====================================================================
// イベント処理
// =====================================================================
function handleEvent(ev) {
  switch (ev.type) {
    case 'MOVE': {
      const serial = ev.serial;
      const cubeT = ev.cubeTimestamp ?? null;
      // 重複除去: serialがあればserialで、無ければcubeT一致で判定
      if (lastMove && lastMove.move === ev.move &&
          (serial != null ? serial === lastMove.serial
                          : (cubeT != null && cubeT === lastMove.cubeT))) {
        dupCount++; updateQuality(); return;
      }
      // 欠落検出: serialの飛び
      if (lastMove && serial != null && lastMove.serial != null) {
        const gap = ((serial - lastMove.serial) % 256 + 256) % 256;
        if (gap > 1) {
          missCount += gap - 1;
          pushLog('MISSED', `${gap - 1}手を取りこぼし（serial ${lastMove.serial} → ${serial}）`, 'warn');
        }
      }
      lastMove = { move: ev.move, serial, cubeT };
      moveCount++;
      if (simState && $('optConsistency').checked) simState = applyMove(simState, ev.move);
      const extra = `serial=${serial ?? '-'}` + (cubeT != null ? ` cubeT=${cubeT}ms` : '');
      pushLog('MOVE', `${pad(ev.move, 3)}  ${extra}`);
      $('statLastMove').textContent = ev.move;
      updateStats();
      break;
    }
    case 'GYRO': {
      gyroSeen++;
      const q = ev.quaternion;
      const t = relMs();
      const est = angSpeedFromQ(lastQ, q, t - lastQMs);
      lastQ = q; lastQMs = t;
      // 画面の姿勢表示は常に更新(間引き対象外)
      const e = quatToEuler(q);
      $('statOrient').textContent =
        `q(${q.x.toFixed(2)}, ${q.y.toFixed(2)}, ${q.z.toFixed(2)}, ${q.w.toFixed(2)})  ` +
        `R${e.roll.toFixed(0)}° P${e.pitch.toFixed(0)}° Y${e.yaw.toFixed(0)}°`;
      // 記録は間引き
      if (!$('optGyro').checked) return;
      const interval = Math.max(0, +$('optGyroInterval').value || 0);
      if (interval > 0 && (t - lastGyroLogMs) < interval) return;
      lastGyroLogMs = t;
      const v = ev.velocity;
      let detail = `q=(${q.x.toFixed(4)}, ${q.y.toFixed(4)}, ${q.z.toFixed(4)}, ${q.w.toFixed(4)})` +
        ` euler=(${e.roll.toFixed(1)}, ${e.pitch.toFixed(1)}, ${e.yaw.toFixed(1)})deg`;
      if (est != null) detail += ` w=${est.toFixed(2)}rad/s`;
      if (v) detail += ` v=(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
      pushLog('ROT', detail);
      break;
    }
    case 'FACELETS': {
      if ($('optFacelets').checked) pushLog('FACELETS', ev.facelets);
      if ($('optConsistency').checked) checkConsistency(ev.facelets);
      break;
    }
    case 'BATTERY': {
      $('statBattery').textContent = `${ev.batteryLevel}%`;
      pushLog('BATTERY', `${ev.batteryLevel}%`);
      break;
    }
    case 'HARDWARE': {
      const parts = [];
      if (ev.hardwareName) parts.push(`name=${ev.hardwareName}`);
      if (ev.softwareVersion) parts.push(`sw=${ev.softwareVersion}`);
      if (ev.hardwareVersion) parts.push(`hw=${ev.hardwareVersion}`);
      if (ev.productDate) parts.push(`date=${ev.productDate}`);
      if (ev.gyroSupported != null) parts.push(`gyro=${ev.gyroSupported ? 'yes' : 'no'}`);
      pushLog('HARDWARE', parts.join(' '));
      break;
    }
    case 'DISCONNECT': {
      onDisconnected('キューブから切断されました');
      break;
    }
  }
}

// =====================================================================
// 接続 / 切断
// =====================================================================
async function doConnect() {
  if (!navigator.bluetooth) {
    setStatus('このブラウザは Web Bluetooth に対応していません（Android Chrome / Windows Chrome・Edge をお使いください）', 'error');
    return;
  }
  if (!window.isSecureContext) {
    setStatus('HTTPS で開いてください（Bluetooth は安全なコンテキストでのみ使用できます）', 'error');
    return;
  }
  try {
    setStatus('接続中… デバイスを選択してください', 'connecting');
    conn = await connectGanCube(macProvider);

    connectPerfMs = performance.now();
    connectWallMs = Date.now();
    resetCounters();

    // ヘッダー(ファイル先頭に付く説明)
    const now = new Date(connectWallMs);
    headerLines = [
      '# Speed Cube Tracker ログ',
      `# デバイス: ${conn.deviceName}  (MAC ${conn.deviceMAC})`,
      `# 記録開始: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${fmtWall(connectWallMs)}`,
      '# 形式: <接続からの秒>  <時刻>  <種別>  <詳細>',
      '#   MOVE=回転操作(例 R, U\')  ROT=姿勢(クォータニオン/オイラー角°/角速度rad/s)',
      '#   FACELETS=キューブ状態(Kociemba表記)  BATTERY=電池  HARDWARE=機器情報',
      '#   MISSED=BLEレベルの取りこぼし  MISMATCH=記録手順と実機の不一致',
      '#   face順(オイラー/面): U,R,F,D,L,B / クォータニオンは (x, y, z, w)',
      '',
    ];

    setStatus(`接続しました: ${conn.deviceName}`, 'connected');
    $('statDevice').textContent = `${conn.deviceName}`;
    setConnectedUI(true);
    acquireWakeLock();

    pushLog('CONNECT', `${conn.deviceName} (MAC ${conn.deviceMAC})`);

    sub = conn.events$.subscribe({
      next: handleEvent,
      error: (e) => { console.error(e); onDisconnected('通信エラーが発生しました: ' + e); },
    });

    // 初期情報を要求
    try {
      await conn.sendCubeCommand({ type: 'REQUEST_HARDWARE' });
      await conn.sendCubeCommand({ type: 'REQUEST_BATTERY' });
      await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
    } catch (_) {}
  } catch (err) {
    conn = null;
    const msg = String(err && err.message || err);
    if (/cancelled|User cancelled|chooser|No device selected/i.test(msg)) {
      setStatus('接続をキャンセルしました', 'idle');
    } else {
      setStatus('接続エラー: ' + msg, 'error');
    }
    console.error(err);
  }
}

async function doDisconnect() {
  try { if (conn) await conn.disconnect(); } catch (_) {}
  // DISCONNECTイベントが来ない場合に備えて明示的に後始末
  onDisconnected('切断しました');
}

function onDisconnected(message) {
  if (sub) { try { sub.unsubscribe(); } catch (_) {} sub = null; }
  if (conn) pushLog('DISCONNECT', '');
  conn = null;
  setConnectedUI(false);
  setStatus(message, 'idle');
  releaseWakeLock();
}

function resetCounters() {
  moveCount = 0; gyroSeen = 0; lastGyroLogMs = -1e9;
  lastQ = null; lastQMs = 0; lastMove = null;
  dupCount = 0; missCount = 0; mismatchCount = 0; checkCount = 0;
  simState = null;
  updateStats(); updateQuality();
}

// =====================================================================
// コピー / ダウンロード / クリア
// =====================================================================
function fullText() {
  return headerLines.concat(logLines).join('\n') + '\n';
}

function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : 'var(--ok)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.textContent = ''; }, 2500);
}

async function doCopy() {
  if (logLines.length === 0) { toast('ログが空です', true); return; }
  const text = fullText();
  try {
    await navigator.clipboard.writeText(text);
    toast('ログをコピーしました');
  } catch (_) {
    // フォールバック(非セキュア/権限なし環境)
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    toast(ok ? 'ログをコピーしました' : 'コピーに失敗しました。手動で選択してください', !ok);
  }
}

function stamp() {
  const d = new Date();
  const p = (v, n = 2) => String(v).padStart(n, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function doDownload() {
  if (logLines.length === 0) { toast('ログが空です', true); return; }
  const blob = new Blob([fullText()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cube-log-${stamp()}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('ログを保存しました');
}

function doClear() {
  if (logLines.length && !confirm('ログをすべて消去しますか？')) return;
  logLines = [];
  logEl().textContent = '';
  resetCounters();
  $('statLastMove').textContent = '—';
  toast('ログをクリアしました');
}

// =====================================================================
// 起動
// =====================================================================
function init() {
  $('btnConnect').onclick = doConnect;
  $('btnDisconnect').onclick = doDisconnect;
  $('btnRefresh').onclick = async () => {
    if (!conn) return;
    try { await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' }); await conn.sendCubeCommand({ type: 'REQUEST_BATTERY' }); }
    catch (_) {}
  };
  $('btnCopy').onclick = doCopy;
  $('btnDownload').onclick = doDownload;
  $('btnClear').onclick = doClear;
  $('btnForgetMac').onclick = () => {
    let n = 0;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sct:mac:')) { localStorage.removeItem(k); n++; }
    }
    toast(n ? `保存済みMACを${n}件消去しました` : '保存済みMACはありません');
  };

  updateStats();
  updateQuality();

  if (!navigator.bluetooth) {
    setStatus('このブラウザは Web Bluetooth 非対応です（Android Chrome / Windows Chrome・Edge をお使いください。iOS は非対応）', 'error');
    $('btnConnect').disabled = true;
  } else if (!window.isSecureContext) {
    setStatus('HTTPS で開いてください（GitHub Pages など）。file:// では Bluetooth を使用できません', 'error');
  }
}

init();

// 開発用デバッグフック(?debug=1 のときのみ有効。通常動作には影響しません)
if (location.search.includes('debug=1')) {
  connectPerfMs = performance.now();
  window.__sct = {
    feed: handleEvent,
    text: fullText,
    startSession() {
      connectPerfMs = performance.now();
      connectWallMs = Date.now();
      headerLines = ['# Speed Cube Tracker ログ (debug)'];
      pushLog('CONNECT', 'DEBUG-CUBE (MAC 00:00:00:00:00:00)');
      setConnectedUI(true);
    },
  };
}
