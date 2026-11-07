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
let lastLoggedQ = null;    // 最後にログした姿勢(デッドバンド判定用)
let lastMove = null;       // 直近のMOVE {move, serial, cubeT}
let lastMoveAtMs = -1e9;   // 直近のMOVEの相対ms(整合チェックの保留判定用)
let lastFacelets = null;   // 直近のFACELETS(重複排除用)
let pendingResync = false; // 高速ターン中の不一致を保留して再照合
let lastCheckState = null;  // 直近に照合OK/基準セットした実機状態
let movesSinceCheck = [];   // その後に記録した面手列(スライス推定の位置探索用)
let dupCount = 0, missCount = 0, mismatchCount = 0, checkCount = 0;

const DEADBAND_RAD = 2.5 * Math.PI / 180; // これ未満の姿勢変化は「ほぼ静止」として記録省略
const SETTLE_MS = 400;                    // 直近MOVEからこの時間内の不一致は保留(高速ターンの偽陽性対策)

const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
// スクランブル関連
let currentScramble = [];   // 現在提示中のスクランブル(手の配列)
let scrambleActive = false; // 追従中(完了すると false)
let scrambleSi = 0;         // 適用済みの手数(進捗)
let scrambleDouble = 0;     // ダブル手(例 U2)の途中カウント(0/1)

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

// スライス手(M/E/S)の「センター固定・エッジのみ」置換(幾何モデルから生成し面手で検証済み)。
// GANキューブはコーナー/エッジのみ送り、スライスをMOVEとして報告しないため、
// FACELETS差分からスライス手を推定するのに使う。各quarterは該当スライスの4エッジ8ステッカーのみ動く。
const SLICE_PERM = {
  M: [0,52,2,3,4,5,6,46,8,9,10,11,12,13,14,15,16,17,18,1,20,21,22,23,24,7,26,27,19,29,30,31,32,33,25,35,36,37,38,39,40,41,42,43,44,45,34,47,48,49,50,51,28,53],
  E: [0,1,2,3,4,5,6,7,8,9,10,11,21,13,23,15,16,17,18,19,20,39,22,41,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,48,40,50,42,43,44,45,46,47,12,49,14,51,52,53],
  S: [0,1,2,43,4,37,6,7,8,9,3,11,12,13,14,15,5,17,18,19,20,21,22,23,24,25,26,27,28,29,16,31,10,33,34,35,36,30,38,39,40,41,42,32,44,45,46,47,48,49,50,51,52,53],
};
function applySliceN(s, base, n) {
  const perm = SLICE_PERM[base];
  let a = s.split('');
  for (let k = 0; k < n; k++) a = perm.map((i) => a[i]);
  return a.join('');
}
// baseState に movesSinceCheck(面手列)を適用する途中のどこか1箇所にスライス手を挿入して
// target に一致するものを探す。実際の解きでは M2 等が面手の間に入るため、位置も探索する。
function inferSliceBurst(baseState, moves, target) {
  if (baseState == null) return null;
  let prefix = baseState;
  for (let k = 0; k <= moves.length; k++) {
    if (k > 0) prefix = applyMove(prefix, moves[k - 1]);
    for (const base of ['M', 'E', 'S']) {
      for (let n = 1; n <= 3; n++) {
        let s = applySliceN(prefix, base, n);
        for (let i = k; i < moves.length; i++) s = applyMove(s, moves[i]);
        if (s === target) return base + (n === 1 ? '' : (n === 2 ? '2' : "'"));
      }
    }
  }
  return null;
}

let simState = null; // 直近のFACELETS基準に手順を適用した状態

function syncCheckpoint(reported) {
  // 照合が解決したので基準を更新
  simState = reported;
  lastCheckState = reported;
  movesSinceCheck = [];
  pendingResync = false;
}

function checkConsistency(reported) {
  checkCount++;
  if (simState == null) {
    pushLog('CHECK', '基準状態をセットしました', 'meta');
    syncCheckpoint(reported);
    updateQuality();
    return;
  }
  if (reported === simState) {
    // 一致 → ログには出さず、件数だけ更新
    syncCheckpoint(reported);
    updateQuality();
    return;
  }
  // 不一致 → まずスライス手(M/E/S)で説明できるか試す。
  // キューブはスライスをMOVEとして報告しないので、FACELETS差分から推定して記録する。
  if ($('optInferSlice').checked) {
    const slice = inferSliceBurst(lastCheckState, movesSinceCheck, reported);
    if (slice) {
      pushLog('SLICE', `${slice}   （スライス手: 実機状態から推定）`);
      moveCount++;
      $('statLastMove').textContent = slice;
      lastMoveAtMs = relMs();
      syncCheckpoint(reported);
      updateStats();
      updateQuality();
      return;
    }
  }
  // 不一致
  const sinceMove = relMs() - lastMoveAtMs;
  if (sinceMove < SETTLE_MS) {
    // 直前まで回していた → 高速ターン中の一時的な同期ズレの可能性。確定させず再照合。
    if (!pendingResync) {
      pendingResync = true;
      setTimeout(() => { try { conn && conn.sendCubeCommand({ type: 'REQUEST_FACELETS' }); } catch (_) {} }, SETTLE_MS);
    }
    return;
  }
  // 落ち着いた状態での不一致 → 多くはスライス手/持ち替え/高速操作。実機状態に再同期する。
  // (BLEの取りこぼしは serial の飛び=MISSED で別途検出しており、これは手の欠落ではない)
  mismatchCount++;
  const diff = [...reported].filter((c, i) => c !== simState[i]).length;
  pushLog('SYNC', `実機状態に再同期（スライス手/持ち替え/高速操作の可能性・差分${diff}ステッカー）`, 'warn');
  syncCheckpoint(reported);
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

function fmtRel(ms) {
  const s = ms / 1000;
  return (s >= 0 ? '+' : '') + s.toFixed(3);
}

// type別の色クラス
const CLASS_FOR = { MOVE: '', SLICE: 'slice', ROT: 'dim', FACELETS: 'meta', BATTERY: 'meta', HARDWARE: 'meta', CONNECT: 'meta', DISCONNECT: 'meta', CHECK: 'meta', SCRAMBLE: 'note', SYNC: 'warn', MISSED: 'warn', MISMATCH: 'err' };

// 1行をログ(画面+配列)に追加
function pushLog(type, detail, forceClass) {
  const line = `${padL(fmtRel(relMs()), 9)}  ${pad(type, 9)} ${detail}`;
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
  $('statQuality').textContent = `重複 ${dupCount} ・ 欠落 ${missCount} ・ 再同期 ${mismatchCount} ・ 照合 ${checkCount}`;
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
      lastMoveAtMs = relMs();
      moveCount++;
      if (simState && $('optConsistency').checked) {
        simState = applyMove(simState, ev.move);
        movesSinceCheck.push(ev.move);
      }
      const extra = `serial=${serial ?? '-'}` + (cubeT != null ? ` cubeT=${cubeT}ms` : '');
      pushLog('MOVE', `${pad(ev.move, 3)}  ${extra}`);
      $('statLastMove').textContent = ev.move;
      updateStats();
      scrambleOnMove(ev.move);
      break;
    }
    case 'GYRO': {
      gyroSeen++;
      const q = ev.quaternion;
      const t = relMs();
      const est = angSpeedFromQ(lastQ, q, t - lastQMs);
      lastQ = q; lastQMs = t;
      // 画面の姿勢表示は常に更新(間引き対象外)。レイアウトが動かないよう常に2行で表示。
      const e = quatToEuler(q);
      $('statOrient').textContent =
        `q(${q.x.toFixed(2)}, ${q.y.toFixed(2)}, ${q.z.toFixed(2)}, ${q.w.toFixed(2)})\n` +
        `R ${e.roll.toFixed(0)}°  P ${e.pitch.toFixed(0)}°  Y ${e.yaw.toFixed(0)}°`;
      // 記録は間引き
      if (!$('optGyro').checked) return;
      const interval = Math.max(0, +$('optGyroInterval').value || 0);
      if (interval > 0 && (t - lastGyroLogMs) < interval) return;
      // デッドバンド: 前回ログした姿勢からの変化が小さい(ほぼ静止)なら記録を省略
      if ($('optDeadband').checked && lastLoggedQ) {
        let dot = lastLoggedQ.x * q.x + lastLoggedQ.y * q.y + lastLoggedQ.z * q.z + lastLoggedQ.w * q.w;
        dot = Math.min(1, Math.abs(dot));
        if (2 * Math.acos(dot) < DEADBAND_RAD) return;
      }
      lastGyroLogMs = t;
      lastLoggedQ = q;
      const v = ev.velocity;
      let detail = `q=(${q.x.toFixed(4)}, ${q.y.toFixed(4)}, ${q.z.toFixed(4)}, ${q.w.toFixed(4)})` +
        ` euler=(${e.roll.toFixed(1)}, ${e.pitch.toFixed(1)}, ${e.yaw.toFixed(1)})deg`;
      if (est != null) detail += ` w=${est.toFixed(2)}rad/s`;
      if (v) detail += ` v=(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
      pushLog('ROT', detail);
      break;
    }
    case 'FACELETS': {
      // キューブは同一状態を繰り返し送ってくるため、変化が無ければ無視(重複排除)。
      // ただし再照合の保留中(pendingResync)は、同一状態でも照合を走らせて確定/解消する。
      if (ev.facelets === lastFacelets && !pendingResync) break;
      const changed = ev.facelets !== lastFacelets;
      lastFacelets = ev.facelets;
      if (changed && $('optFacelets').checked) pushLog('FACELETS', ev.facelets);
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

    // ヘッダー(ファイル先頭に付く説明)。個人情報保護のため、MAC/デバイス名/絶対時刻は含めない。
    headerLines = [
      '# Speed Cube Tracker ログ',
      '# 形式: <接続からの相対秒>  <種別>  <詳細>',
      '#   MOVE=回転操作(例 R, U\')  SLICE=スライス手(M/E/S, 実機状態から推定)',
      '#   ROT=姿勢(クォータニオン/オイラー角°/角速度rad/s)',
      '#   FACELETS=キューブ状態(Kociemba表記)  BATTERY=電池  HARDWARE=機器情報',
      '#   SCRAMBLE=提示したスクランブル  MISSED=BLEレベルの取りこぼし',
      '#   SYNC=実機状態への再同期(スライス手/持ち替え/高速操作。手の欠落ではない)',
      '#   ※GANはコーナー/エッジのみ送信。スライス手(M/E/S)は外2層ペアとして報告され、',
      '#     高速スライス中はMOVE列が不正確になる場合あり。FACELETS(全状態)が正。',
      '#   face順(オイラー/面): U,R,F,D,L,B / クォータニオンは (x, y, z, w)',
      '',
    ];

    setStatus(`接続しました: ${conn.deviceName}`, 'connected');
    $('statDevice').textContent = `${conn.deviceName}`;
    setConnectedUI(true);
    acquireWakeLock();

    pushLog('CONNECT', '接続しました');

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
  lastQ = null; lastQMs = 0; lastLoggedQ = null;
  lastMove = null; lastMoveAtMs = -1e9;
  lastFacelets = null; pendingResync = false;
  lastCheckState = null; movesSinceCheck = [];
  dupCount = 0; missCount = 0; mismatchCount = 0; checkCount = 0;
  simState = null;
  updateStats(); updateQuality();
}

// =====================================================================
// コピー / ダウンロード / クリア
// =====================================================================
function fullText() {
  const head = headerLines.slice();
  if (currentScramble.length) {
    head.push('# スクランブル: ' + currentScramble.join(' '));
    head.push('');
  }
  return head.concat(logLines).join('\n') + '\n';
}

function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : 'var(--ok)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.textContent = ''; }, 2500);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
  }
}

async function doCopy() {
  if (logLines.length === 0) { toast('ログが空です', true); return; }
  const ok = await copyToClipboard(fullText());
  toast(ok ? 'ログをコピーしました' : 'コピーに失敗しました。手動で選択してください', !ok);
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
// スクランブル
// =====================================================================
function generateScramble(len) {
  const faces = ['U', 'D', 'R', 'L', 'F', 'B'];
  const axis = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };
  const sfx = ['', "'", '2'];
  const res = [];
  let prevFace = null, prevAxis = null, prevPrevAxis = null;
  while (res.length < len) {
    const f = faces[Math.floor(Math.random() * 6)];
    if (f === prevFace) continue;                               // 同一面の連続を避ける
    if (axis[f] === prevAxis && axis[f] === prevPrevAxis) continue; // 同一軸3連続を避ける
    res.push(f + sfx[Math.floor(Math.random() * 3)]);
    prevPrevAxis = prevAxis; prevAxis = axis[f]; prevFace = f;
  }
  return res;
}

function renderScramble(progress) {
  const view = $('scrambleView');
  if (!currentScramble.length) { view.textContent = '「生成」でスクランブルを表示します'; return; }
  view.innerHTML = currentScramble
    .map((m, i) => `<span class="${i < progress ? 'done' : (i === progress ? 'cur' : 'todo')}">${m}</span>`)
    .join(' ');
}

function onGenerateScramble() {
  const len = Math.min(40, Math.max(1, +$('scrambleLen').value || 20));
  currentScramble = generateScramble(len);
  scrambleActive = true;
  scrambleSi = 0;
  scrambleDouble = 0;
  renderScramble(0);
  const prog = $('scrambleProgress');
  prog.className = 'scramble-progress';
  prog.textContent = conn
    ? `キューブを回してください  次: ${currentScramble[0]}`
    : '（未接続：手動でスクランブルしてください）';
  if (conn) pushLog('SCRAMBLE', currentScramble.join(' '));
}

// 手(MOVE)ごとにスクランブル進捗を更新。ダブル手(U2)は2クォーターとして扱う。
// 途中状態や誤操作でも進捗を0に戻さない(前進のみ)。
function scrambleOnMove(move) {
  if (!scrambleActive || scrambleSi >= currentScramble.length) return;
  const exp = currentScramble[scrambleSi];
  const isDouble = exp.endsWith('2');
  if (move === exp) {
    // そのトークン(クォーター/プライム、または"R2"単体報告)に完全一致
    scrambleSi++; scrambleDouble = 0;
  } else if (isDouble && move[0] === exp[0]) {
    // ダブル手を2クォーターで実施中
    scrambleDouble++;
    if (scrambleDouble >= 2) { scrambleDouble = 0; scrambleSi++; }
  } else {
    // 期待と違う手 → 進めない(0には戻さない)
    scrambleDouble = 0;
  }
  renderScramble(scrambleSi);
  const el = $('scrambleProgress');
  if (scrambleSi >= currentScramble.length) {
    el.textContent = 'スクランブル完了 ✓  ソルブを開始できます';
    el.className = 'scramble-progress done';
    scrambleActive = false;
    pushLog('SCRAMBLE', '適用完了（ソルブ開始）');
  } else {
    el.textContent = `適用 ${scrambleSi} / ${currentScramble.length} 手  次: ${currentScramble[scrambleSi]}`
      + (scrambleDouble ? '（あと1回転）' : '');
    el.className = 'scramble-progress';
  }
}

async function doCopyScramble() {
  if (!currentScramble.length) { toast('スクランブルがありません', true); return; }
  const ok = await copyToClipboard(currentScramble.join(' '));
  toast(ok ? 'スクランブルをコピーしました' : 'コピーに失敗しました', !ok);
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
  $('btnScramble').onclick = onGenerateScramble;
  $('btnScrambleCopy').onclick = doCopyScramble;
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
      pushLog('CONNECT', '接続しました');
      setConnectedUI(true);
    },
  };
}
