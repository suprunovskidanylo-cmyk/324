// ==UserScript==
// @name         На Урок — AI навчальний помічник
// @namespace    local-naurok-ai-helper
// @version      1.0.0
// @description  Надсилає запитання з варіантами до локального OpenAI proxy і підсвічує запропоновані відповіді
// @match        https://naurok.com.ua/*
// @match        https://*.naurok.com.ua/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const API_URL = 'http://127.0.0.1:3219/answer';
  const HIGHLIGHT_ATTR = 'data-naurok-ai-highlight';
  let panel;
  let lastSignature = '';
  let busy = false;

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  function getLabel(input) {
    if (input.labels && input.labels.length) return input.labels[0];
    if (input.id) {
      const found = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (found) return found;
    }
    return input.closest('label') || input.parentElement;
  }

  function findQuestionContainer(labels) {
    if (!labels.length) return null;
    let node = labels[0].parentElement;
    while (node && node !== document.body) {
      const text = norm(node.innerText);
      const containsAll = labels.every(label => node.contains(label));
      if (containsAll && text.length > 0 && text.length < 5000) {
        const inputsInside = node.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        if (inputsInside.length >= labels.length) {
          const parentText = norm(node.parentElement?.innerText);
          // Choose the smallest common ancestor that contains the options.
          if (!node.parentElement || parentText.length > text.length + 20) return node;
        }
      }
      node = node.parentElement;
    }
    return labels[0].parentElement;
  }

  function discoverQuestions() {
    const inputs = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
      .filter(input => visible(input) && !panel?.contains(input));
    const groups = new Map();
    for (const input of inputs) {
      const key = `${input.type}:${input.name || input.id || 'unnamed'}:${input.form ? 'form' : 'page'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(input);
    }
    const found = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const labels = group.map(getLabel).filter((el, i, arr) => el && arr.indexOf(el) === i && visible(el));
      if (labels.length < 2) continue;
      const container = findQuestionContainer(labels);
      const optionTexts = labels.map(label => norm(label.innerText || label.textContent)).filter(Boolean);
      if (optionTexts.length < 2) continue;
      let questionText = norm(container?.innerText || '');
      for (const option of optionTexts) questionText = questionText.replace(option, ' ');
      questionText = norm(questionText.replace(/[\n\t|•●○◉]+/g, ' '));
      // Avoid accidentally sending a huge page heading or unrelated content.
      if (questionText.length < 8) {
        const preceding = container?.querySelector('h1,h2,h3,[class*="question"],[class*="title"]');
        questionText = norm(preceding?.innerText || '');
      }
      if (!questionText || questionText.length > 2000) continue;
      found.push({ question: questionText, options: optionTexts, labels, container });
    }
    return found;
  }

  function ensurePanel() {
    if (panel && panel.isConnected) return;
    panel = document.createElement('section');
    panel.id = 'naurok-ai-helper-panel';
    Object.assign(panel.style, {
      position: 'fixed', right: '14px', bottom: '14px', zIndex: '2147483647',
      width: '340px', maxWidth: 'calc(100vw - 28px)', maxHeight: '55vh', overflow: 'auto',
      background: '#fff', color: '#17202a', border: '1px solid #cbd5e1', borderRadius: '12px',
      boxShadow: '0 8px 30px rgba(0,0,0,.22)', padding: '12px',
      font: '14px/1.4 system-ui, sans-serif'
    });
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <strong>На Урок · AI-помічник</strong>
        <button type="button" id="nh-close" title="Згорнути" style="border:0;background:#eee;border-radius:6px;padding:4px 8px;cursor:pointer">—</button>
      </div>
      <div id="nh-status" style="margin:8px 0;color:#475569">Знайди запитання з варіантами на сторінці.</div>
      <button type="button" id="nh-analyze" style="width:100%;padding:8px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer">Проаналізувати видиме запитання</button>
      <div id="nh-result" style="white-space:pre-wrap;margin-top:10px"></div>
      <div style="font-size:11px;color:#64748b;margin-top:8px">Працює лише з видимими стандартними radio/checkbox варіантами. ШІ може помилятися.</div>`;
    document.body.appendChild(panel);
    panel.querySelector('#nh-close').onclick = () => {
      panel.style.display = 'none';
      const reopen = document.createElement('button');
      reopen.id = 'naurok-ai-reopen';
      reopen.textContent = 'AI-помічник';
      Object.assign(reopen.style, { position:'fixed', right:'14px', bottom:'14px', zIndex:'2147483647', padding:'9px 12px', border:0, borderRadius:'8px', background:'#2563eb', color:'#fff', cursor:'pointer' });
      reopen.onclick = () => { panel.style.display = 'block'; reopen.remove(); };
      document.body.appendChild(reopen);
    };
    panel.querySelector('#nh-analyze').onclick = analyze;
  }

  function setStatus(message) {
    if (panel) panel.querySelector('#nh-status').textContent = message;
  }
  function clearHighlights() {
    document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach(el => {
      el.style.outline = el.dataset.nhOldOutline || '';
      el.style.backgroundColor = el.dataset.nhOldBg || '';
      delete el.dataset.nhOldOutline;
      delete el.dataset.nhOldBg;
      el.removeAttribute(HIGHLIGHT_ATTR);
    });
  }
  function highlight(el) {
    el.dataset.nhOldOutline = el.style.outline || '';
    el.dataset.nhOldBg = el.style.backgroundColor || '';
    el.style.outline = '3px solid #16a34a';
    el.style.backgroundColor = '#dcfce7';
    el.setAttribute(HIGHLIGHT_ATTR, '1');
  }

  function analyze() {
    ensurePanel();
    if (busy) return;
    const questions = discoverQuestions();
    if (!questions.length) {
      setStatus('Не знайшов стандартних radio/checkbox варіантів. Спробуй інший тип запитання або онови скрипт під цю сторінку.');
      return;
    }
    // Use the first detected question. If several are present, choose the one with the shortest question text.
    questions.sort((a, b) => a.question.length - b.question.length);
    const item = questions[0];
    const signature = JSON.stringify([item.question, item.options]);
    if (signature === lastSignature && panel.querySelector('#nh-result').textContent) {
      setStatus('Це запитання вже проаналізовано.');
      return;
    }
    lastSignature = signature;
    busy = true;
    const button = panel.querySelector('#nh-analyze');
    button.disabled = true;
    button.textContent = 'Аналізую…';
    setStatus(`Надсилаю запитання з ${item.options.length} варіантами до локального сервера…`);
    panel.querySelector('#nh-result').textContent = '';

    GM_xmlhttpRequest({
      method: 'POST', url: API_URL, timeout: 65000,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ question: item.question, options: item.options }),
      onload: response => {
        busy = false; button.disabled = false; button.textContent = 'Проаналізувати видиме запитання';
        let data;
        try { data = JSON.parse(response.responseText); } catch { data = { error: 'Некоректна відповідь локального сервера.' }; }
        if (response.status < 200 || response.status >= 300) {
          setStatus(data.error || `Помилка сервера (${response.status}). Перевір, чи запущений server.js.`);
          return;
        }
        clearHighlights();
        const indexes = Array.isArray(data.correctIndexes) ? data.correctIndexes : [];
        const unique = [...new Set(indexes)].filter(i => Number.isInteger(i) && i >= 0 && i < item.labels.length);
        unique.forEach(i => highlight(item.labels[i]));
        const names = unique.length ? unique.map(i => `${i + 1}. ${item.options[i]}`).join('\n') : 'ШІ не визначив відповідь упевнено.';
        panel.querySelector('#nh-result').textContent = `Варіант(и):\n${names}\n\nПояснення: ${data.explanation || 'Немає'}\n\n${data.note || 'Перевір відповідь самостійно.'}`;
        setStatus(unique.length ? 'Запропоновані варіанти підсвічено зеленим.' : 'Відповідь невизначена — нічого не підсвічував.');
      },
      onerror: () => {
        busy = false; button.disabled = false; button.textContent = 'Проаналізувати видиме запитання';
        setStatus('Не вдалося підключитися до http://127.0.0.1:3219. Переконайся, що server.js запущений.');
      },
      ontimeout: () => {
        busy = false; button.disabled = false; button.textContent = 'Проаналізувати видиме запитання';
        setStatus('Час очікування вичерпано. Спробуй ще раз.');
      }
    });
  }

  function init() {
    ensurePanel();
    // Do not continuously call the model. The user must press the button for each question.
    const observer = new MutationObserver(() => {
      if (!panel || !panel.isConnected) ensurePanel();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  init();
})();
