(function () {
  'use strict';

  /* ============================================================
     Мост «KNS Paint ↔ профиль Элизии» (#84, wave 2).

     Третий файл рядом с байт-в-байт копией редактора (index.html +
     paint-data.js): сам редактор не знает про игру и никогда не узнает
     (контракт PAINT-ELYSIA-AGREEMENT). Мост строит свой интерфейс из
     живого window.PAINT (экспорт «кот+слой» — exportGameCanvas, слой
     краски — exportFlatCanvas) и общается с API сайта cookie-сессией:

       1) «Сохранить и надеть»: canvas → toBlob → POST /sprites/mine
          (multipart file+name) → PATCH /profiles/me {sprite} — порядок
          строго upload→PATCH (контракт);
       2) «Только сохранить в Мои»: тот же POST без PATCH;
       3) панель «Вернуться в профиль / Продолжить рисовать» — вместо
          мгновенного редиректа (контракт), ошибки не покидают холст;
       4) ?back=profile — allowlist значений (анти-open-redirect):
          допустимое значение одно — «profile», возврат ведёт на
          /players/?id=<аккаунт>&mine=<спрайт>#settings;
       5) beforeunload-гуард: изменённый холст (срез-подпись краски
          отличается от стартовой) не даёт молча уйти со страницы.

     Синхронизация версий: при обновлении копии редактора из репо kns
     шов в index.html (одна строка подключения этого файла) переносится
     тем же PR; этот файл меняется только при изменении API редактора.
     Проверка шва и сверка хэша исходника: scripts/check-paint-seam.mjs.
     ============================================================ */

  /* Хост-гейт: мост живёт только там, где есть сессия Элизии и её API
     (прод www-elyria, PR-превью *.elysiae.*, dev localhost). На прочих
     хостах (публичные гроты, где страницы профиля нет) мост молчит —
     редактор остаётся чистым KNS Paint. */
  var HOST = location.hostname || '';
  function bridgeEnabled() {
    if (location.protocol === 'file:') return false;
    if (HOST === 'localhost' || HOST === '127.0.0.1' || HOST === '[::1]') return true;
    return HOST === 'phainonsmilk.ru' || HOST.endsWith('.elysiae.phainonsmilk.ru');
  }
  if (!bridgeEnabled()) return;

  /* API-база — тот же выбор, что у клиента игры (coop.ts httpOrigin):
     Элизия/превью — same-origin (кука сессии ездит сама), dev — сервер
     комнаты на 3780. Куки идут с запросами (credentials: include). */
  function apiBase() {
    if (HOST === 'localhost' || HOST === '127.0.0.1' || HOST === '[::1]') return 'http://localhost:3780';
    return '';
  }

  /* Дожидающийся window.PAINT. Шов стоит в конце <body>: inline-скрипт
     редактора к этому моменту уже отработал; страховка на случай
     будущих перестановок — тихий поллинг. */
  var PAINT = null;
  function start() {
    if (window.PAINT && typeof window.PAINT.exportGameCanvas === 'function') {
      PAINT = window.PAINT;
      init();
      return;
    }
    var n = 0;
    var t = setInterval(function () {
      if (window.PAINT && typeof window.PAINT.exportGameCanvas === 'function') {
        clearInterval(t);
        PAINT = window.PAINT;
        init();
      } else if (++n > 100) {
        clearInterval(t); /* 10 с без редактора — мост перестаёт ждать */
      }
    }, 100);
  }

  /* ---------- утилиты ---------- */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* Отказы сервера → русский текст (тот же словарь, что человеческие
     подсказки профиля: http-my-sprites.ts humanMineError + пару строк
     о надевании из player-profile.tsx humanEditError). */
  var REASON_TEXT = {
    auth_required: 'Нужен вход в аккаунт.',
    csrf_origin_required: 'Запрос отклонён защитой — обновите страницу и попробуйте снова.',
    csrf: 'Запрос отклонён защитой — обновите страницу и попробуйте снова.',
    offline: 'Сервер недоступен.',
    no_file: 'Не удалось приложить картинку — попробуйте снова.',
    bad_magic: 'Файл не похож на PNG — нужен рисунок из редактора окрасов.',
    bad_name: 'Имя окраса: 2–24 символа.',
    bad_dims: 'Картинка не подходит: сторона 100–1000 px, файл от 1,5 КБ.',
    too_large: 'Файл больше 1 МБ не принимается — уменьшите картинку.',
    limit: 'У вас уже 3 окраса — удалите один в профиле.',
    rate: 'Слишком много загрузок подряд — немного подождите и попробуйте снова.',
    capacity: 'Каталог окрасов переполнен — попробуйте позже.',
    worn: 'Этот окрас сейчас надет — сначала переоденьте кота.',
    forbidden: 'Это окрас другого игрока.',
    unknown_sprite: 'Окраса уже нет — обновите страницу.',
    invalid: 'Не удалось надеть — окрас недоступен.',
    empty_patch: 'Нет полей для сохранения.',
    invalid_body: 'Запрос не читается — обновите страницу и попробуйте снова.',
    io: 'Не удалось сохранить файл окраса — попробуйте позже.',
    storage: 'Не удалось сохранить файл окраса — попробуйте позже.'
  };
  function humanText(reason, fallback) {
    var t = REASON_TEXT[reason];
    return t || fallback || 'Не получилось — попробуйте ещё раз.';
  }

  function readJson(res) {
    return res.text().then(function (text) {
      var row = null;
      try { row = JSON.parse(text); } catch (e) { row = null; }
      return { status: res.status, row: row, text: text };
    }, function () { return { status: 0, row: null, text: '' }; });
  }

  /* ---------- сессия: accountId + имя для префилла ---------- */

  var accountId = null;
  var accountName = 'игрока';

  function loadSession() {
    return fetch(apiBase() + '/auth/me', { credentials: 'include' })
      .then(readJson)
      .then(function (r) {
        if (r.status === 200 && r.row && r.row.ok === true && r.row.accountId) {
          accountId = String(r.row.accountId);
          var dn = r.row.profile && typeof r.row.profile.displayName === 'string' ? r.row.profile.displayName : r.row.login;
          if (dn) accountName = String(dn);
        }
      })
      .catch(function () { /* гость — префилл «от игрока», как в профиле */ });
  }

  /* ---------- ?back= allowlist (анти-open-redirect) ----------
     Значение читается только из известного набора; в возврат никогда
     не подставляется строка из запроса целиком. */
  function backWanted() {
    try {
      var q = new URLSearchParams(location.search);
      return q.get('back') === 'profile';
    } catch (e) {
      return /(?:^|[?&])back=profile(?:&|$)/.test(location.search);
    }
  }
  var HAS_BACK = backWanted();

  function profileHref(spriteId) {
    var u = '/players/';
    if (accountId) {
      u += '?id=' + encodeURIComponent(accountId);
      if (spriteId) u += '&mine=' + encodeURIComponent(spriteId);
      u += '#settings';
    }
    return u;
  }

  /* ---------- подпись краски: пустой холст и beforeunload ---------- */

  /* Срез-подпись сплющенных видимых слоёв: сумма альфы. Ловит любой
     источник изменения — штрих, заливку, импорт проекта; undo до
     исходного состояния возвращает исходную подпись (гуард молчит). */
  function paintSign() {
    try {
      var cv = PAINT.exportFlatCanvas();
      var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      var s = 0;
      for (var i = 3; i < d.length; i += 4) {
        if (d[i]) s = (s + d[i] + 1) % 4294967291;
      }
      return s;
    } catch (e) {
      return 0;
    }
  }

  /* ---------- API ---------- */

  function postMineSprite(name, blob) {
    var form = new FormData();
    form.append('file', blob, 'kns-paint-sprite.png');
    form.append('name', name);
    return fetch(apiBase() + '/sprites/mine', {
      method: 'POST',
      credentials: 'include',
      body: form
    }).then(readJson).then(function (r) {
      if (
        (r.status === 200 || r.status === 201) &&
        r.row && r.row.ok === true && r.row.sprite && typeof r.row.sprite === 'object'
      ) {
        return { ok: true, sprite: r.row.sprite, dedup: r.row.dedup === true };
      }
      var reason = r.status === 0 ? 'offline' : (r.row && r.row.reason) || 'upload_failed';
      return { ok: false, reason: reason, message: r.row && r.row.message };
    });
  }

  /* Надевание после загрузки (контракт: строго upload→PATCH). Сервер
     проверит id по вайтлисту каталога; спрайт уже в «Мои окрасы». */
  function wearSprite(id) {
    return fetch(apiBase() + '/profiles/me', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sprite: id })
    }).then(readJson).then(function (r) {
      if (r.status === 200 && r.row && r.row.ok === true) return { ok: true };
      var reason = r.status === 0 ? 'offline' : (r.row && r.row.reason) || 'invalid';
      return { ok: false, reason: reason, message: r.row && r.row.message };
    });
  }

  /* ---------- интерфейс моста ---------- */

  var root = null;      /* вставленная панель */
  var panelState = 'idle'; /* idle | form | busy | done */
  var currentAction = 'wear'; /* wear | save */
  var busyMsg = '';
  var nameDirty = false;  /* юзер правит имя сам — авто-префилл больше не мешает */

  function defaultName() {
    /* Префилл «Окрас от <имя> <дата>» обязан влезать в лимит имени (2–24)
       ДО ручной правки — обрезаем год до двух цифр и страхуем хвост:
       длинный ник не должен ломать первую отправку. */
    var d = new Date();
    function two(x) { return x < 10 ? '0' + x : '' + x; }
    var stamp = two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(-2);
    var base = 'Окрас от ' + accountName + ' ' + stamp;
    return base.length > 24 ? base.slice(0, 24) : base;
  }

  function findAnchor() {
    /* панель экспорта редактора: блок с btnExpGame/btnExpWork */
    var b = document.getElementById('btnExpGame');
    if (!b) return null;
    var box = b.parentNode;
    return box && box.parentNode ? box : null;
  }

  function renderPanel() {
    if (!root) return;
    root.textContent = '';

    if (panelState === 'idle') {
      var hint = el('div', 'pb-note',
        'Окрашенный кот сохранится в «Мои окрасы» вашего профиля.');
      var wear = el('button', 'gbtn pb-btn', 'Сохранить и надеть');
      wear.type = 'button';
      wear.title = 'Загрузить окрас в профиль и сразу надеть его на персонажа';
      wear.onclick = function () { openForm('wear'); };
      var save = el('button', 'gbtn pb-btn2', 'Только сохранить в Мои');
      save.type = 'button';
      save.title = 'Загрузить окрас в «Мои окрасы» без переодевания';
      save.onclick = function () { openForm('save'); };
      root.appendChild(hint);
      root.appendChild(wear);
      root.appendChild(save);
      return;
    }

    if (panelState === 'form') {
      var box = el('div', 'pb-form');
      var lab = el('div', 'pb-note', currentAction === 'wear'
        ? 'Сохранить и надеть: окрас появится в профиле и на поле.'
        : 'Сохранить в «Мои окрасы»: надеть можно будет в профиле.');
      var name = el('input', 'pb-name');
      name.type = 'text';
      name.maxLength = 24;
      name.value = defaultName();
      /* ручной ввод главнее авто-префилла: пока поле не трогали — можно
         подменять значение после догрузки сессии (openForm) */
      name.oninput = function () { nameDirty = true; };
      nameDirty = false;
      var row = el('div', 'pb-row');
      var ok = el('button', 'gbtn pb-btn', currentAction === 'wear' ? 'Сохранить и надеть' : 'Сохранить в Мои');
      ok.type = 'button';
      ok.onclick = function () { beginUpload(name.value); };
      var cancel = el('button', 'abtn pb-btn2', 'Отмена');
      cancel.type = 'button';
      cancel.onclick = function () { panelState = 'idle'; renderPanel(); };
      row.appendChild(ok);
      row.appendChild(cancel);
      box.appendChild(lab);
      box.appendChild(name);
      box.appendChild(row);
      root.appendChild(box);
      name.focus();
      name.select();
      return;
    }

    if (panelState === 'busy') {
      root.appendChild(el('div', 'pb-note', busyMsg));
      return;
    }

    if (panelState === 'done') {
      root.appendChild(el('div', 'pb-done', doneNote));
      var row2 = el('div', 'pb-row');
      if (HAS_BACK) {
        var back = el('button', 'gbtn pb-btn', 'Вернуться в профиль');
        back.type = 'button';
        back.onclick = function () { location.href = profileHref(doneSpriteId); };
        row2.appendChild(back);
      }
      if (doneSaved) {
        var more = el('button', 'abtn pb-btn2', 'Продолжить рисовать');
        more.type = 'button';
        more.onclick = function () {
          panelState = 'idle';
          renderPanel();
        };
        row2.appendChild(more);
      }
      root.appendChild(row2);
      return;
    }
  }

  var doneNote = '';
  var doneSpriteId = null;
  var doneSaved = false;

  function failPanel(reason, message) {
    panelState = 'form';
    renderPanel();
    var base = humanText(reason, 'Не получилось.');
    /* Сервер иногда дословно повторяет канонический текст reason —
       не печатаем одну и ту же фразу дважды. */
    var text = !message ? base : (message === base ? base : base + ' ' + message);
    var err = el('div', 'pb-err', text);
    err.className = 'pb-err';
    var box = root.querySelector('.pb-form');
    if (box) box.insertBefore(err, box.firstChild);
    else root.appendChild(err);
  }

  function openForm(action) {
    currentAction = action;
    panelState = 'form';
    renderPanel();
    /* Сессия могла приехать позже старта моста (вход/логин в соседней
       вкладке): поправим префилл имени, пока поле не трогали руками. */
    loadSession().then(function () {
      if (panelState !== 'form') return;
      var inp = root && root.querySelector('input.pb-name');
      if (inp && !nameDirty) inp.value = defaultName();
    });
  }

  /* Пустой холст — гейт клиента (контракт): «пустой холст» ловится в
     редакторе, не на сервере. Считаем непрозрачные пиксели краски. */
  function canvasHasPaint(cv) {
    try {
      var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      var n = 0;
      for (var i = 3; i < d.length; i += 4) {
        if (d[i] > 0 && ++n > 0) return true;
      }
      return false;
    } catch (e) {
      return true; /* не читается — не мешаем сохранить с честной ошибкой сервера */
    }
  }

  function beginUpload(rawName) {
    var name = String(rawName || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 24) {
      failPanel('bad_name', '');
      return;
    }
    var cv = PAINT.exportGameCanvas();
    if (!cv) {
      PAINT.toast('нечего экспортировать — скетч не читается');
      return;
    }
    /* Экспорт «кот+слой» содержит и базовый скетч: проверяем краску по
       сплющенному слою (секрет пустого холста — альфа краски нулевая). */
    if (!canvasHasPaint(PAINT.exportFlatCanvas())) {
      PAINT.toast('Холст пустой — сначала раскрасьте котика!');
      return;
    }
    panelState = 'busy';
    busyMsg = currentAction === 'wear' ? 'Сохраняем окрас и надеваем…' : 'Сохраняем окрас…';
    renderPanel();
    cv.toBlob(function (blob) {
      if (!blob) {
        failPanel('no_file', '');
        return;
      }
      postMineSprite(name, blob).then(function (up) {
        if (!up.ok) {
          failPanel(up.reason, up.message || '');
          return;
        }
        doneSpriteId = up.sprite && up.sprite.id ? String(up.sprite.id) : null;
        if (currentAction !== 'wear') {
          doneNote = (up.dedup
            ? 'Такая картинка уже была загружена — показываем существующий окрас.'
            : 'Окрас сохранён в «Мои окрасы» — надеть можно в профиле.');
          doneSaved = true;
          panelState = 'done';
          renderPanel();
          return;
        }
        if (!doneSpriteId) {
          failPanel('unknown_sprite', '');
          return;
        }
        return wearSprite(doneSpriteId).then(function (w) {
          if (!w.ok) {
            /* загрузка прошла — окрас в «Мои»; надевание нет: честно
               рассказываем, что делать (надеть в профиле) */
            doneNote = 'Окрас сохранён в «Мои окрасы», но надеть не вышло: ' + humanText(w.reason, 'попробуйте надеть в профиле.') + ' Надеть можно в профиле.';
            doneSaved = true;
            panelState = 'done';
            renderPanel();
            return;
          }
          doneNote = up.dedup
            ? 'Окрашенный кот сохранён и надет (картинка уже была — взяли существующий окрас).'
            : 'Окрас сохранён и надет на персонажа!';
          doneSaved = true;
          panelState = 'done';
          renderPanel();
        });
      });
    }, 'image/png');
  }

  /* ---------- beforeunload-гуард ---------- */

  var initialSign = null;
  function armUnloadGuard() {
    initialSign = paintSign();
    window.addEventListener('beforeunload', function (ev) {
      if (initialSign === null) return;
      if (paintSign() !== initialSign) {
        /* Стандартное подтверждение браузера; текст в нём — браузерный,
           это гейт от молчаливой потери рисунка, не наша вёрстка. */
        ev.preventDefault();
        ev.returnValue = '';
      }
    });
  }

  /* ---------- запуск ---------- */

  function applyEditorChrome() {
    document.body.classList.add('uk-editor-page');
    if (document.getElementById('editor-chrome-css')) return;
    var link = document.createElement('link');
    link.id = 'editor-chrome-css';
    link.rel = 'stylesheet';
    link.href = '/ui/editor-chrome.css';
    document.head.appendChild(link);
  }

  function init() {
    applyEditorChrome();
    loadSession().then(function () {
      var anchor = findAnchor();
      if (!anchor) return;
      root = el('div', 'pb exp');
      root.id = 'paint-bridge';
      anchor.parentNode.insertBefore(root, anchor.nextSibling);

      /* стили моста локальны: без правки статики редактора */
      var css = [
        '#paint-bridge.pb { margin: 8px 0 0; }',
        '#paint-bridge.pb .pb-note { font: 500 11px/1.35 system-ui, sans-serif; color: #9aa3c0; margin: 0 0 6px; }',
        '#paint-bridge.pb .pb-btn { margin: 0 6px 6px 0; }',
        '#paint-bridge.pb .pb-btn2 { margin: 0 0 6px 0; }',
        '#paint-bridge.pb input.pb-name { width: 100%; box-sizing: border-box; margin: 0 0 6px; padding: 5px 8px; font: 500 12px system-ui, sans-serif; color: #e8e6f0; background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.18); border-radius: 8px; outline: none; }',
        '#paint-bridge.pb input.pb-name:focus { border-color: #e7bd8c; }',
        '#paint-bridge.pb .pb-done { font: 700 12px/1.4 system-ui, sans-serif; color: #7dcaa0; margin: 0 0 6px; }',
        '#paint-bridge.pb .pb-err { font: 500 11px/1.35 system-ui, sans-serif; color: #e98a8a; margin: 0 0 6px; }'
      ].join('\n');
      var st = document.createElement('style');
      st.id = 'paint-bridge-style';
      st.textContent = css;
      document.head.appendChild(st);

      panelState = 'idle';
      renderPanel();
      armUnloadGuard();
    });
  }

  start();
})();
