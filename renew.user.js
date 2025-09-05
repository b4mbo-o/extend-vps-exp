// ==UserScript==
// @name         Extend VPS Expiration (JP)
// @name:ja      Xserver VPS 自動延長スクリプト
// @namespace    http://tampermonkey.net/
// @version      2025-09-05
// @description  Xserver の無料VPSの期限延長を自動化（日本語化 + Cloudflare安定化）
// @description:ja Xserver の無料VPSの期限延長を自動化（日本語化 + Cloudflare安定化）
// @match        https://secure.xserver.ne.jp/xapanel*/xvps*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=xserver.ne.jp
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/GitHub30/extend-vps-exp/refs/heads/main/renew.user.js
// @downloadURL  https://raw.githubusercontent.com/GitHub30/extend-vps-exp/refs/heads/main/renew.user.js
// @supportURL   https://github.com/GitHub30/extend-vps-exp
// ==/UserScript==

/*
=================================================================================================
使い方（Usage）
=================================================================================================
1) ログインページをブクマ： https://secure.xserver.ne.jp/xapanel/login/xvps/
2) 1日1回このブクマを開く。
3) 初回はメールとパスワードを入力→保存され、以後は自動入力＆自動ログイン。

ワークフロー（Workflow）
- ログインページ：保存済みの認証情報を自動入力して送信。
- VPS管理トップ：無料VPSの期限を確認。『明日が期限』なら延長ページへ遷移。
- 申請ページ：確認ボタンを自動クリック→CAPTCHAページへ。
- CAPTCHAページ：
  a) 画像CAPTCHAを抽出→外部APIで認識
  b) 結果を自動入力
  c) Cloudflare Turnstileのトークン生成を待機→生成されたら送信

この版の追加ポイント（安定化）
- Cloudflareの待機/チャレンジが消えるまで待機（#cf-please-wait / challenges iframe を検知）
- Turnstileトークン検知の範囲を拡大（document全体から name="cf-turnstile-response" を探索）
- hidden inputの後出しに対応（DOM追加を監視）
- window.turnstile.getResponse() のポーリングをフォールバックで実装
- タイムアウトを60秒に延長
- CAPTCHA入力欄のセレクタを堅く（placeholder表記ゆれや name="authcode" などに対応）
=================================================================================================
*/

(function () {
  'use strict';

  const LOG_PREFIX = '[VPS延長スクリプト]';
  let isRunning = false;

  // 進捗トースト
  GM_addStyle(`
    #vps-renewal-progress {
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 10000;
      background: #333;
      color: #fff;
      padding: 10px 12px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      box-shadow: 0 6px 18px rgba(0,0,0,0.25);
      max-width: 280px;
      word-break: break-all;
    }
  `);

  function waitForDOMReady() {
    return new Promise(resolve => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', resolve);
      } else {
        resolve();
      }
    });
  }

  // jQueryに依存してる箇所があるため、必要時のみ待つ
  function waitForjQuery() {
    return new Promise(resolve => {
      if (typeof $ !== 'undefined') return resolve();
      const id = setInterval(() => {
        if (typeof $ !== 'undefined') { clearInterval(id); resolve(); }
      }, 50);
    });
  }

  function createStatusElement(message) {
    removeStatusElement();
    const el = document.createElement('div');
    el.id = 'vps-renewal-progress';
    el.textContent = message;
    document.body.appendChild(el);
  }

  function updateStatusElement(message) {
    const el = document.getElementById('vps-renewal-progress');
    if (el) el.textContent = message; else createStatusElement(message);
  }

  function removeStatusElement() {
    document.getElementById('vps-renewal-progress')?.remove();
  }

  // Cloudflareのチャレンジが終わるまで待つ
  async function waitForCloudflare(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const blocking = document.querySelector(
        '#cf-please-wait, #challenge-running, iframe[src*="challenges.cloudflare.com"]'
      );
      if (!blocking) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  // セレクタで要素を待つ
  async function waitForElement(selector, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }

  // ログインページ：自動入力＆保存
  async function handleLogin() {
    console.log(`${LOG_PREFIX} ログインページ検知。`);
    updateStatusElement('ログインを処理しています...');

    const memberid = GM_getValue('memberid');
    const user_password = GM_getValue('user_password');

    if (memberid && user_password && !document.querySelector('.errorMessage')) {
      console.log(`${LOG_PREFIX} 保存済みの認証情報を検出→自動ログイン試行。`);
      try {
        if (unsafeWindow.memberid && unsafeWindow.user_password) {
          unsafeWindow.memberid.value = memberid;
          unsafeWindow.user_password.value = user_password;
          updateStatusElement('保存済みの認証情報を検出。自動ログイン中...');
          setTimeout(() => {
            if (typeof unsafeWindow.loginFunc === 'function') {
              unsafeWindow.loginFunc();
            } else {
              console.warn(`${LOG_PREFIX} loginFunc が見つからない/関数でない。`);
              updateStatusElement('警告：ログイン関数が見つかりません。手動でログインしてください。');
            }
          }, 500);
        } else {
          throw new Error('ログインフォーム要素が存在しない');
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} 自動ログイン失敗:`, e);
        updateStatusElement('自動ログインに失敗しました。手動でログインしてください。');
      }
    } else {
      console.log(`${LOG_PREFIX} 認証情報未保存 or エラーメッセージあり→手動待ち。`);
      await waitForjQuery();
      if (typeof $ !== 'undefined') {
        $('#login_area').on('submit', function () {
          try {
            if (unsafeWindow.memberid && unsafeWindow.user_password) {
              GM_setValue('memberid', unsafeWindow.memberid.value);
              GM_setValue('user_password', unsafeWindow.user_password.value);
              console.log(`${LOG_PREFIX} 新しい認証情報を保存しました。`);
            }
          } catch (e) {
            console.error(`${LOG_PREFIX} 認証情報の保存エラー:`, e);
          }
        });
      }
    }
  }

  // VPS管理トップ：期限チェック＆遷移
  function handleVPSDashboard() {
    console.log(`${LOG_PREFIX} VPS管理トップを検知。`);
    updateStatusElement('更新状況を確認しています...');

    try {
      // 明日の日付（svロケールは YYYY-MM-DD で安定）
      const tomorrow = new Date(Date.now() + 86400000)
        .toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' });
      const row = document.querySelector('tr:has(.freeServerIco)');

      if (!row) {
        console.log(`${LOG_PREFIX} 無料VPS行が見つからない。`);
        updateStatusElement('無料VPSが見つかりませんでした。');
        return;
      }

      const expireSpan = row.querySelector('.contract__term');
      const expireDate = expireSpan ? expireSpan.textContent.trim() : null;

      console.log(`${LOG_PREFIX} ページ上の期限: ${expireDate || '不明'}`);
      console.log(`${LOG_PREFIX} 明日の日付: ${tomorrow}`);

      if (expireDate === tomorrow) {
        console.log(`${LOG_PREFIX} 期限=明日 → 延長ページへ遷移。`);
        const detailLink = row.querySelector('a[href^="/xapanel/xvps/server/detail?id="]');
        if (detailLink && detailLink.href) {
          updateStatusElement('期限間近を検出→延長に進みます...');
          setTimeout(() => {
            location.href = detailLink.href.replace('detail?id', 'freevps/extend/index?id_vps');
          }, 1000);
        } else {
          throw new Error('延長リンクを取得できませんでした');
        }
      } else {
        console.log(`${LOG_PREFIX} 期限は明日ではない → 何もしない。`);
        updateStatusElement('現在のVPSは延長不要です。');
        setTimeout(removeStatusElement, 3000);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} トップ処理エラー:`, e);
      updateStatusElement('更新状況の確認でエラーが発生しました。ページを再読み込みしてください。');
    }
  }

  // 申請ページ：確認ボタン押下
  function handleRenewalPage() {
    console.log(`${LOG_PREFIX} 延長申請ページを検知。`);
    updateStatusElement('延長申請の準備中...');

    try {
      setTimeout(() => {
        const extendButton = document.querySelector('[formaction="/xapanel/xvps/server/freevps/extend/conf"]');
        if (extendButton) {
          console.log(`${LOG_PREFIX} 延長ボタンをクリック。`);
          updateStatusElement('延長規約を確認中...');
          setTimeout(() => extendButton.click(), 800);
        } else {
          throw new Error('延長ボタンが見つかりません');
        }
      }, 1000);
    } catch (e) {
      console.error(`${LOG_PREFIX} 申請ページ操作エラー:`, e);
      updateStatusElement('延長申請ページの操作に失敗しました。');
    }
  }

  // CAPTCHAページ：認識→入力→Turnstile待ち→送信
  async function handleCaptchaPage() {
    console.log(`${LOG_PREFIX} CAPTCHAページ処理開始。`);
    updateStatusElement('CAPTCHAを認識して入力しています...');

    try {
      await waitForDOMReady();

      // Cloudflareの待機/チャレンジが終わるまで待つ
      const cfCleared = await waitForCloudflare(60000);
      if (!cfCleared) {
        console.warn(`${LOG_PREFIX} Cloudflareチャレンジが60秒以内に終了せず。続行します。`);
      }

      // CAPTCHA画像（base64）を取得
      const img = document.querySelector('img[src^="data:image"]') ||
                  document.querySelector('img[src^="data:"]');
      if (!img || !img.src) throw new Error('CAPTCHA画像が見つかりません');

      console.log(`${LOG_PREFIX} CAPTCHA画像をAPIへ送信して認識します...`);
      updateStatusElement('CAPTCHAを認識中... しばらくお待ちください');

      // 外部APIで認識（※元実装を踏襲）
      let codeResponse; const maxRetries = 3; let retry = 0;
      while (retry < maxRetries) {
        try {
          const res = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
            method: 'POST',
            body: img.src,
            headers: { 'Content-Type': 'text/plain' }
          });
          if (!res.ok) throw new Error(`APIエラー: ${res.status}`);
          codeResponse = (await res.text())?.trim();
          if (codeResponse && codeResponse.length >= 4) break;
          throw new Error('APIの応答が不正（短すぎ）');
        } catch (err) {
          retry++;
          if (retry >= maxRetries) throw err;
          console.log(`${LOG_PREFIX} CAPTCHA認識リトライ中... (${retry}/${maxRetries})`);
        }
      }

      const code = codeResponse;
      console.log(`${LOG_PREFIX} 認識結果: ${code}`);
      updateStatusElement('CAPTCHA認識完了。フォーム送信の準備中...');

      // 入力欄を探して入力（表記ゆれ/代替にも対応）
      const input = document.querySelector('[placeholder*="上の画像"]') ||
                    document.querySelector('[name="authcode"]') ||
                    document.querySelector('input[type="text"][maxlength="4"]');
      if (!input) throw new Error('CAPTCHA入力欄が見つかりません');
      input.value = code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      console.log(`${LOG_PREFIX} CAPTCHAを入力しました。`);
      updateStatusElement('CAPTCHA入力完了。人間認証（Turnstile）を処理中...');

      // --- Cloudflare Turnstile ---
      let cf = document.querySelector('[name="cf-turnstile-response"]') ||
               document.querySelector('.cf-turnstile [name="cf-turnstile-response"]');

      if (cf && cf.value) {
        console.log(`${LOG_PREFIX} Turnstileトークン検出→即送信。`);
        submitForm();
        return;
      }

      console.log(`${LOG_PREFIX} Turnstileトークン待機を開始。`);
      updateStatusElement('人間認証トークンの生成を待っています...');

      // 60秒で打ち切る
      const timeoutId = setTimeout(() => {
        console.error(`${LOG_PREFIX} Turnstileトークン生成がタイムアウト→強制送信。`);
        updateStatusElement('人間認証の応答がタイムアウトしました。強制送信します...');
        submitForm();
      }, 60000);

      // 既存hidden inputのvalue変化を監視
      const valueObserver = new MutationObserver(() => {
        if (cf && cf.value) {
          console.log(`${LOG_PREFIX} Turnstileトークン生成を検知→送信。`);
          clearTimeout(timeoutId);
          valueObserver.disconnect();
          addedObserver.disconnect();
          clearInterval(pollId);
          submitForm();
        }
      });
      if (cf) valueObserver.observe(cf, { attributes: true, attributeFilter: ['value'] });

      // hidden input 自体が後から追加されるケースに対応
      const addedObserver = new MutationObserver((ml) => {
        for (const m of ml) {
          for (const node of m.addedNodes || []) {
            if (node.nodeType === 1 && node.matches?.('[name="cf-turnstile-response"]')) {
              cf = node;
              console.log(`${LOG_PREFIX} Turnstile hidden input を検出（追加）。`);
              valueObserver.observe(cf, { attributes: true, attributeFilter: ['value'] });
              if (cf.value) {
                clearTimeout(timeoutId);
                valueObserver.disconnect();
                addedObserver.disconnect();
                clearInterval(pollId);
                submitForm();
              }
            }
          }
        }
      });
      addedObserver.observe(document.body, { childList: true, subtree: true });

      // 公式APIのフォールバック：最後にレンダされたwidgetの応答を取得
      const pollId = setInterval(() => {
        try {
          const token = window.turnstile?.getResponse?.();
          if (typeof token === 'string' && token.length > 0) {
            console.log(`${LOG_PREFIX} turnstile.getResponse() 経由でトークン取得→送信。`);
            clearTimeout(timeoutId);
            valueObserver.disconnect();
            addedObserver.disconnect();
            clearInterval(pollId);
            submitForm();
          }
        } catch (_) { /* noop */ }
      }, 1000);

    } catch (error) {
      console.error(`${LOG_PREFIX} CAPTCHA処理エラー:`, error);
      updateStatusElement('CAPTCHA処理でエラーが発生しました。ページを再読み込みしてください。');
    }

    // 送信処理
    function submitForm() {
      updateStatusElement('すべての認証が完了しました。送信します...');
      setTimeout(() => {
        if (typeof unsafeWindow.submit_button !== 'undefined' &&
            unsafeWindow.submit_button &&
            typeof unsafeWindow.submit_button.click === 'function') {
          unsafeWindow.submit_button.click();
        } else {
          const btn = document.querySelector('input[type="submit"], button[type="submit"]');
          if (btn) btn.click(); else {
            console.error(`${LOG_PREFIX} 送信ボタンが見つかりません`);
            updateStatusElement('送信ボタンが見つかりません。手動で送信してください。');
          }
        }
      }, 1000);
    }
  }

  // ルーティング
  function main() {
    if (isRunning) return; // 二重起動防止
    isRunning = true;

    const path = location.pathname;
    if (path.startsWith('/xapanel/login/xvps')) {
      handleLogin();
    } else if (path.includes('/xapanel/xvps/index')) {
      handleVPSDashboard();
    } else if (path.includes('/xapanel/xvps/server/freevps/extend/index')) {
      handleRenewalPage();
    } else if (
      path.includes('/xapanel/xvps/server/freevps/extend/conf') ||
      path.includes('/xapanel/xvps/server/freevps/extend/do')
    ) {
      handleCaptchaPage();
    } else {
      console.log(`${LOG_PREFIX} 非対応パスのため何もしません。`);
      isRunning = false;
    }
  }

  main();
})();
