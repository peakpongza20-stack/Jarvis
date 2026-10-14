(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var log = $('log'), input = $('say'), note = $('note');
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var CLAUDE_MODEL = 'claude-sonnet-5-5';
  var GEMINI_MODEL = 'gemini-2.5-flash-lite';
  var GEMINI_FALLBACK = 'gemini-2.5-flash';

  /* ---------- state ---------- */
  var lang = store.get('jv-lang');
  if (['auto', 'en', 'th'].indexOf(lang) < 0) lang = 'auto';
  var muted = store.get('jv-mute') === '1';
  var hands = store.get('jv-hands') === '1';
  var apiKey = store.get('jv-key') || '';
  var model = store.get('jv-model') || '';   // custom model name, empty = default for the key type
  // Keys starting with sk-ant are Claude keys. Anything else (AIza...) is treated as a Google Gemini key.
  function provider() { return /^sk-ant/i.test(apiKey) ? 'claude' : 'gemini'; }
  function activeModel() {
    var p = provider();
    if (model && p === 'gemini' && !/^claude/i.test(model)) return model;
    if (model && p === 'claude' && !/^gemini/i.test(model)) return model;
    return p === 'claude' ? CLAUDE_MODEL : GEMINI_MODEL;
  }
  var mode = 'idle', busy = false, history = [], speaking = false, armed = false;
  var STATE_TEXT = { idle: 'STANDING BY', listen: 'LISTENING', think: 'PROCESSING', speak: 'RESPONDING' };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  /* ---------- arc reactor ---------- */
  var cv = $('reactor'), cx = cv.getContext('2d'), S = cv.width, C = S / 2;
  var CYAN = '#4fd8ff';
  var SPEED = { idle: 0.3, listen: 0.9, think: 2.6, speak: 0.7 };
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var rot = 0, lastT = 0;

  function ring(r, lw, n, fill, angle, alpha) {
    cx.save();
    cx.rotate(angle);
    cx.beginPath();
    cx.arc(0, 0, r, 0, Math.PI * 2);
    cx.lineWidth = lw;
    cx.globalAlpha = alpha;
    if (n > 1) {
      var seg = (Math.PI * 2 * r) / n;
      cx.setLineDash([seg * fill, seg * (1 - fill)]);
    } else {
      cx.setLineDash([]);
    }
    cx.stroke();
    cx.restore();
  }
  function paint(t) {
    cx.clearRect(0, 0, S, S);
    var pulse = mode === 'speak' ? 0.5 + 0.5 * Math.sin(t * 0.011) * Math.sin(t * 0.0043 + 1)
      : mode === 'think' ? 0.5 + 0.5 * Math.sin(t * 0.008)
      : 0.5 + 0.5 * Math.sin(t * 0.002);
    cx.save();
    cx.translate(C, C);
    cx.strokeStyle = CYAN;
    cx.shadowColor = CYAN;
    cx.shadowBlur = 10;
    ring(C * 0.93, 2, 48, 0.25, rot * 0.5, 0.6);
    ring(C * 0.8, 5, 6, 0.72, -rot * 1.3, 0.9);
    ring(C * 0.66, 1.5, 1, 1, 0, 0.5);
    ring(C * 0.5, 12, 10, 0.62, rot * 0.7, 0.85);
    cx.shadowBlur = 14 + 26 * pulse;
    cx.fillStyle = '#e9fbff';
    cx.globalAlpha = 1;
    cx.beginPath();
    cx.arc(0, 0, C * (0.16 + 0.03 * pulse), 0, Math.PI * 2);
    cx.fill();
    cx.restore();
  }
  function frame(t) {
    var dt = (t - lastT) || 16;
    lastT = t;
    rot += dt * 0.001 * SPEED[mode];
    paint(t);
    requestAnimationFrame(frame);
  }
  function setMode(m) {
    mode = m;
    $('state').textContent = STATE_TEXT[m];
    if (reduce) paint(0);
  }
  if (reduce) paint(0); else requestAnimationFrame(frame);

  /* ---------- clock ---------- */
  function two(n) { return n < 10 ? '0' + n : '' + n; }
  function tickClock() {
    var d = new Date();
    $('clock').textContent = two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
    $('date').textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).replace(/,/g, '').toUpperCase();
  }

  /* ---------- transcript ---------- */
  function addMsg(role, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + role;
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = role === 'bot' ? 'JARVIS' : 'YOU';
    var p = document.createElement('p');
    p.textContent = text;
    el.appendChild(tag);
    el.appendChild(p);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return p;
  }
  function addLink(parentP, url, label) {
    var a = document.createElement('a');
    a.className = 'link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    parentP.parentElement.appendChild(a);
    log.scrollTop = log.scrollHeight;
  }
  function say(msg) {
    note.textContent = msg;
    clearTimeout(say.t);
    say.t = setTimeout(function () { note.textContent = ''; }, 9000);
  }
  function setNet() {
    var net = $('net');
    net.textContent = apiKey ? 'CORE READY / ' + (provider() === 'claude' ? 'CLAUDE' : 'GEMINI') : 'NO KEY SET';
    net.className = 'sub ' + (apiKey ? 'ok' : 'off');
  }

  /* ---------- voice out ---------- */
  var synth = window.speechSynthesis || null, voices = [];
  if (synth) {
    voices = synth.getVoices();
    synth.onvoiceschanged = function () { voices = synth.getVoices(); };
  }
  function pickVoice(l) {
    var list = voices.filter(function (v) { return v.lang.toLowerCase().replace('_', '-').indexOf(l) === 0; });
    if (l === 'en') {
      var gb = list.filter(function (v) { return /en[-_]GB/i.test(v.lang); });
      return gb.filter(function (v) { return /male|daniel|oliver|arthur/i.test(v.name); })[0] || gb[0] || list[0];
    }
    return list[0];
  }
  function stopSpeech() {
    if (synth) { try { synth.cancel(); } catch (e) {} }
    speaking = false;
    if (mode === 'speak') setMode('idle');
    resumeHands();
  }
  function speak(text) {
    if (muted || !synth) { resumeHands(); return; }
    try {
      synth.cancel();
      var th = /[฀-๿]/.test(text);
      var u = new SpeechSynthesisUtterance(text);
      u.lang = th ? 'th-TH' : 'en-GB';
      var v = pickVoice(th ? 'th' : 'en');
      if (v) u.voice = v;
      u.pitch = 0.9;
      u.onstart = function () { speaking = true; pauseHands(); setMode('speak'); };
      u.onend = u.onerror = function () { speaking = false; if (mode === 'speak') setMode('idle'); resumeHands(); };
      synth.speak(u);
    } catch (e) { resumeHands(); }
  }
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ac = new AC(), o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.7);
      o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + 0.75);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } catch (e) {}
  }

  /* ---------- timers ---------- */
  var timers = {}, timerId = 0;
  function fmtClock(s) {
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + two(m) : two(m)) + ':' + two(x);
  }
  function fmtDur(s) {
    if (s % 3600 === 0) return (s / 3600) + (s === 3600 ? ' hour' : ' hours');
    if (s % 60 === 0) return (s / 60) + (s === 60 ? ' minute' : ' minutes');
    return s + ' seconds';
  }
  function addTimer(sec, label) {
    sec = Math.max(1, Math.min(86400, Math.round(Number(sec) || 0)));
    var id = ++timerId;
    timers[id] = { end: Date.now() + sec * 1000, label: (label && String(label).trim()) || fmtDur(sec) };
    renderTimers();
    return sec;
  }
  function renderTimers() {
    var box = $('timers');
    box.textContent = '';
    Object.keys(timers).forEach(function (id) {
      var t = timers[id];
      var left = Math.max(0, Math.ceil((t.end - Date.now()) / 1000));
      var el = document.createElement('div');
      el.className = 'timer';
      var txt = document.createElement('span');
      txt.textContent = t.label + '  ' + fmtClock(left);
      var x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Cancel timer ' + t.label);
      x.textContent = '×';
      x.addEventListener('click', function () { delete timers[id]; renderTimers(); });
      el.appendChild(txt);
      el.appendChild(x);
      box.appendChild(el);
    });
  }
  function tickTimers() {
    var done = [];
    Object.keys(timers).forEach(function (id) { if (timers[id].end <= Date.now()) done.push(id); });
    done.forEach(function (id) {
      var label = timers[id].label;
      delete timers[id];
      var msg = 'Timer complete: ' + label + '.';
      addMsg('bot', msg);
      beep();
      speak(msg);
    });
    renderTimers();
  }

  /* ---------- tools ---------- */
  function calc(src) {
    var clean = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
    var t = clean.match(/\d*\.?\d+|[-+*\/%^()]/g);
    if (!t || t.join('').length !== clean.length) throw new Error('Unsupported expression');
    var i = 0;
    function peek() { return t[i]; }
    function next() { return t[i++]; }
    function expr() { var v = term(); while (peek() === '+' || peek() === '-') { v = next() === '+' ? v + term() : v - term(); } return v; }
    function term() {
      var v = pow();
      while (peek() === '*' || peek() === '/' || peek() === '%') {
        var o = next(), r = pow();
        v = o === '*' ? v * r : o === '/' ? v / r : v % r;
      }
      return v;
    }
    function pow() { var b = unary(); if (peek() === '^') { next(); return Math.pow(b, pow()); } return b; }
    function unary() { if (peek() === '-') { next(); return -unary(); } if (peek() === '+') { next(); return unary(); } return atom(); }
    function atom() {
      var x = next();
      if (x === '(') { var v = expr(); if (next() !== ')') throw new Error('Missing bracket'); return v; }
      var n = parseFloat(x);
      if (isNaN(n)) throw new Error('Bad number');
      return n;
    }
    var out = expr();
    if (i !== t.length || !isFinite(out)) throw new Error('Cannot evaluate');
    return out;
  }
  function getPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('Location is not available on this device'));
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lon: p.coords.longitude }); },
        function () { reject(new Error('Location permission was denied. Ask the user to name a city instead.')); },
        { timeout: 12000, maximumAge: 600000 }
      );
    });
  }
  var WMO = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
    80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };
  async function weather(args) {
    var pos, place = '';
    if (args && args.city) {
      var g = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(args.city));
      var gj = await g.json();
      if (!gj.results || !gj.results.length) throw new Error('City not found: ' + args.city);
      pos = { lat: gj.results[0].latitude, lon: gj.results[0].longitude };
      place = gj.results[0].name + (gj.results[0].country ? ', ' + gj.results[0].country : '');
    } else {
      pos = await getPosition();
      place = 'your location';
    }
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + pos.lat + '&longitude=' + pos.lon +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1';
    var r = await fetch(u);
    if (!r.ok) throw new Error('Weather service unavailable');
    var j = await r.json();
    var c = j.current, d = j.daily;
    return {
      place: place,
      conditions: WMO[c.weather_code] || 'unknown',
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_percent: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      today_high_c: d.temperature_2m_max[0],
      today_low_c: d.temperature_2m_min[0],
      rain_chance_percent_today: d.precipitation_probability_max[0]
    };
  }
  var pendingLinks = [];
  function openLink(args) {
    var q = encodeURIComponent(String(args.query || '').trim());
    if (!q) throw new Error('Missing query');
    var kind = args.kind;
    var url = kind === 'maps' ? 'https://www.google.com/maps/search/?api=1&query=' + q
      : kind === 'youtube' ? 'https://www.youtube.com/results?search_query=' + q
      : kind === 'directions' ? 'https://www.google.com/maps/dir/?api=1&destination=' + q
      : 'https://www.google.com/search?q=' + q;
    var label = kind === 'maps' ? 'OPEN IN MAPS' : kind === 'youtube' ? 'OPEN IN YOUTUBE' : kind === 'directions' ? 'START DIRECTIONS' : 'SEARCH THE WEB';
    pendingLinks.push({ url: url, label: label });
    return { prepared: true, note: 'A tap-to-open button is shown to the user. Tell them to tap it.' };
  }
  var TOOLS = [
    { name: 'get_time', description: "Current local date and time on the user's phone.", input_schema: { type: 'object', properties: {} } },
    { name: 'set_timer', description: 'Start a countdown timer on screen. It rings out loud and vibrates when finished.',
      input_schema: { type: 'object', properties: { seconds: { type: 'number', description: 'Duration in seconds, 1 to 86400.' }, label: { type: 'string', description: 'Optional short name.' } }, required: ['seconds'] } },
    { name: 'calculate', description: 'Evaluate arithmetic. Supports + - * / % ^ and brackets. Convert percentages to plain numbers first.',
      input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
    { name: 'get_weather', description: "Current weather and today's outlook. Omit city to use the phone's location.",
      input_schema: { type: 'object', properties: { city: { type: 'string', description: 'City name in English. Optional.' } } } },
    { name: 'open_link', description: 'Prepare a tap-to-open button for a web search, a map search, directions, or a YouTube search. Use for anything you cannot answer from your own knowledge, and for opening places.',
      input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['search', 'maps', 'directions', 'youtube'] }, query: { type: 'string' } }, required: ['kind', 'query'] } }
  ];
  async function runTool(name, a) {
    a = a || {};
    if (name === 'get_time') {
      var d = new Date();
      return { local: d.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'medium' }), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    }
    if (name === 'set_timer') return { started: true, seconds: addTimer(a.seconds, a.label) };
    if (name === 'calculate') return { result: calc(a.expression) };
    if (name === 'get_weather') return await weather(a);
    if (name === 'open_link') return openLink(a);
    throw new Error('Unknown tool');
  }

  /* ---------- the brain (Claude Messages API) ---------- */
  function system() {
    var rule = lang === 'en' ? 'Always reply in English.'
      : lang === 'th' ? 'Always reply in Thai.'
      : 'Reply in the language the user wrote in, Thai or English.';
    return 'You are J.A.R.V.I.S., a calm, dry-witted AI assistant running as an app on the user’s Android phone. ' +
      'Your replies are read aloud, so write plain spoken sentences: no markdown, no lists, no asterisks, no emojis. ' +
      'Keep each reply to one to three short sentences unless the user asks for detail. ' +
      'Use tools for the time, timers, arithmetic, weather and opening searches, maps, directions or YouTube. ' +
      'You cannot launch other apps, send messages, make calls or read the phone’s data. Say so briefly if asked. ' +
      'Do not assume the user’s gender and do not call them sir or madam. You are male: in Thai, end sentences with ครับ. ' + rule;
  }
  async function callClaude(messages) {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: activeModel(), max_tokens: 1024, system: system(), tools: TOOLS, messages: messages })
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  /* Gemini (Google). Same tools, translated to Gemini's function-calling format. */
  var GEMINI_TOOLS = [{ functionDeclarations: TOOLS.map(function (t) {
    var d = { name: t.name, description: t.description };
    var props = t.input_schema && t.input_schema.properties;
    if (props && Object.keys(props).length) d.parameters = t.input_schema;   // Gemini rejects empty parameter objects
    return d;
  }) }];
  async function callGemini(contents, modelName) {
    var res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelName) + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system() }] },
        contents: contents,
        tools: GEMINI_TOOLS,
        generationConfig: { maxOutputTokens: 1024 }
      })
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  async function thinkGemini() {
    var contents = history.slice(-16).map(function (m) {
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    });
    while (contents.length && contents[0].role !== 'user') contents.shift();
    // Try the chosen model first. If it is busy (503), over quota (429) or missing (404), move to the next one.
    var chain = [activeModel(), GEMINI_FALLBACK, 'gemini-2.5-flash-lite'].filter(function (m, i, a) { return a.indexOf(m) === i; });
    var at = 0;
    for (var step = 0; step < 5; step++) {
      var data;
      for (;;) {
        try {
          data = await callGemini(contents, chain[at]);
          break;
        } catch (e) {
          var retryable = e.status === 503 || e.status === 500 || e.status === 429 || e.status === 404;
          if (retryable && at < chain.length - 1) { at++; continue; }
          throw e;
        }
      }
      var cand = data.candidates && data.candidates[0];
      if (!cand || !cand.content) {
        var why = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || 'empty reply';
        return 'I could not answer that one (' + why + ').';
      }
      var parts = cand.content.parts || [];
      var calls = parts.filter(function (p) { return p.functionCall; });
      if (!calls.length) {
        return parts.filter(function (p) { return typeof p.text === 'string' && !p.thought; }).map(function (p) { return p.text; }).join('').trim();
      }
      contents.push({ role: 'model', parts: parts });   // echo the model turn back untouched
      var replies = [];
      for (var i = 0; i < calls.length; i++) {
        var fc = calls[i].functionCall, out;
        try { out = await runTool(fc.name, fc.args); } catch (e) { out = { error: String(e && e.message || e) }; }
        replies.push({ functionResponse: { name: fc.name, response: { result: out } } });
      }
      contents.push({ role: 'user', parts: replies });
    }
    return 'That took too many steps. Please try a simpler request.';
  }

  async function think() {
    if (provider() === 'gemini') return thinkGemini();
    // history holds plain user/assistant turns. Tool loops stay inside this call.
    var msgs = history.slice(-16).map(function (m) { return { role: m.role, content: m.content }; });
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    for (var step = 0; step < 5; step++) {
      var data = await callClaude(msgs);
      var content = data.content || [];
      if (data.stop_reason !== 'tool_use') {
        return content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('').trim();
      }
      msgs.push({ role: 'assistant', content: content });
      var results = [];
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (b.type !== 'tool_use') continue;
        try {
          results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await runTool(b.name, b.input)) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: String(e && e.message || e) });
        }
      }
      msgs.push({ role: 'user', content: results });
    }
    return 'That took too many steps. Please try a simpler request.';
  }

  async function ask(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    stopSpeech();
    stopListening();
    if (!apiKey) {
      addMsg('user', text);
      addMsg('bot', 'I need an API key before I can think. Tap SET at the top and paste a free Gemini key or a Claude key.');
      openSheet();
      return;
    }
    busy = true;
    pauseHands();
    $('send').disabled = true;
    addMsg('user', text);
    history.push({ role: 'user', content: text });
    var body = addMsg('bot', 'Thinking…');
    body.parentElement.classList.add('pending');
    setMode('think');
    pendingLinks = [];
    try {
      var reply = await think();
      if (!reply) reply = 'My apologies, I had nothing to say to that.';
      body.parentElement.classList.remove('pending');
      body.textContent = reply;
      pendingLinks.forEach(function (l) { addLink(body, l.url, l.label); });
      history.push({ role: 'assistant', content: reply });
      if (mode === 'think') setMode('idle');
      speak(reply);
    } catch (e) {
      var s = e && e.status;
      var gem = provider() === 'gemini';
      var msg = (s === 401 || s === 403 || (s === 400 && /api key/i.test(e.message))) ? 'The API key was rejected. Check it in SET.'
        : s === 429 ? (gem ? 'The free Gemini limit is used up for now. Wait a minute, or try again tomorrow.' : 'Too many requests. Give me a few seconds.')
        : (s === 503 || s === 500) ? 'The AI service is busy right now. Try again in a moment.'
        : s === 404 ? 'That model name was not found. Clear the Model box in SET to use the default.'
        : (s === 400 && /credit|balance/i.test(e.message)) ? 'The Anthropic account has no credit left. Add credit at console.anthropic.com.'
        : !navigator.onLine ? 'You are offline. I need a connection to think.'
        : 'Something went wrong reaching my core: ' + (e && e.message ? e.message : 'unknown error');
      body.parentElement.classList.remove('pending');
      body.textContent = msg;
      history.pop();
      setMode('idle');
      resumeHands();
    } finally {
      busy = false;
      $('send').disabled = false;
      if (mode === 'think') setMode('idle');
    }
  }

  /* ---------- voice in ---------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, handsRec = null, handsPaused = false;
  function recLang() {
    if (lang === 'th') return 'th-TH';
    if (lang === 'en') return 'en-US';
    return (navigator.language || '').toLowerCase().indexOf('th') === 0 ? 'th-TH' : 'en-US';
  }
  function stopListening() { if (rec) { var r = rec; rec = null; try { r.stop(); } catch (e) {} } }
  function startListening() {
    if (!SR) { say('Voice input is not supported in this browser. Use Chrome, or your keyboard’s dictation key.'); return; }
    stopSpeech();
    pauseHands();
    try {
      var r = new SR();
      rec = r;
      r.lang = recLang();
      r.interimResults = true;
      r.continuous = false;
      r.onstart = function () { $('mic').setAttribute('aria-pressed', 'true'); setMode('listen'); };
      r.onresult = function (e) {
        var txt = '';
        for (var i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        input.value = txt;
        if (e.results[e.results.length - 1].isFinal) { input.value = ''; ask(txt); }
      };
      r.onerror = function (e) {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') say('Microphone permission is off. Allow it in Android settings for this app, or use the keyboard dictation key.');
        else if (e.error !== 'no-speech' && e.error !== 'aborted') say('Voice input error: ' + e.error);
      };
      r.onend = function () {
        $('mic').setAttribute('aria-pressed', 'false');
        if (rec === r) rec = null;
        if (mode === 'listen') setMode(busy ? 'think' : 'idle');
        if (!busy) resumeHands();
      };
      r.start();
    } catch (e) {
      say('Voice input could not start. Use your keyboard’s dictation key instead.');
    }
  }

  /* ---------- hands-free wake word ---------- */
  var WAKE = /(jarvis|jarvice|service|จาร์วิส|จาร์วีส|จาวิส|จาวีส|ยาวิส)/i;
  function startHands() {
    if (!hands || !SR || handsRec || handsPaused || busy || rec || speaking) return;
    try {
      var r = new SR();
      handsRec = r;
      r.lang = recLang();
      r.continuous = true;
      r.interimResults = false;
      r.onresult = function (e) {
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue;
          var t = e.results[i][0].transcript.trim();
          if (armed) { armed = false; stopHands(); ask(t); return; }
          var m = t.match(WAKE);
          if (m) {
            var rest = t.slice(t.search(WAKE) + m[0].length).replace(/^[\s,.!?]+/, '');
            if (rest.length > 1) { stopHands(); ask(rest); return; }
            armed = true;
            setMode('listen');
            say('Listening…');
          }
        }
      };
      r.onerror = function (e) {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { hands = false; store.set('jv-hands', '0'); say('Hands-free needs microphone permission.'); }
      };
      r.onend = function () {
        if (handsRec === r) handsRec = null;
        if (hands && !handsPaused && !busy && !rec && !speaking) setTimeout(startHands, 300);
      };
      r.start();
    } catch (e) { handsRec = null; }
  }
  function stopHands() { if (handsRec) { var r = handsRec; handsRec = null; try { r.stop(); } catch (e) {} } armed = false; }
  function pauseHands() { handsPaused = true; stopHands(); }
  function resumeHands() { handsPaused = false; if (hands && !busy && !speaking) setTimeout(startHands, 400); }

  /* ---------- settings sheet ---------- */
  function openSheet() {
    $('key').value = apiKey;
    $('model').value = model;
    $('hands').checked = hands;
    $('sheet').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; }
  $('gear').addEventListener('click', openSheet);
  $('close').addEventListener('click', closeSheet);
  $('save').addEventListener('click', function () {
    apiKey = $('key').value.trim();
    model = $('model').value.trim();
    hands = $('hands').checked;
    if (apiKey) store.set('jv-key', apiKey); else store.del('jv-key');
    if (model) store.set('jv-model', model); else store.del('jv-model');
    store.set('jv-hands', hands ? '1' : '0');
    setNet();
    closeSheet();
    if (hands) { handsPaused = false; startHands(); } else { stopHands(); }
    say(apiKey ? 'Saved.' : 'Key removed.');
  });
  $('clear').addEventListener('click', function () {
    history = [];
    log.textContent = '';
    closeSheet();
    greet();
  });

  /* ---------- controls ---------- */
  function applyLang() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-lang]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang));
    });
    input.placeholder = lang === 'th' ? 'พูดหรือพิมพ์คำสั่ง' : 'Speak or type a command';
  }
  function applyMute() {
    $('mute').setAttribute('aria-pressed', String(muted));
    $('mute').textContent = muted ? 'VOICE OFF' : 'VOICE ON';
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-lang]'), function (b) {
    b.addEventListener('click', function () {
      lang = b.getAttribute('data-lang'); store.set('jv-lang', lang); applyLang();
      if (handsRec) { stopHands(); setTimeout(startHands, 300); }
    });
  });
  $('mute').addEventListener('click', function () {
    muted = !muted; store.set('jv-mute', muted ? '1' : '0'); applyMute(); if (muted) stopSpeech();
  });
  $('core').addEventListener('click', function () { stopSpeech(); stopListening(); });
  $('mic').addEventListener('click', function () {
    if ($('mic').getAttribute('aria-pressed') === 'true') stopListening(); else startListening();
  });
  $('dock').addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var v = input.value;
    input.value = '';
    ask(v);
  });
  Array.prototype.forEach.call(document.querySelectorAll('#chips button'), function (b) {
    b.addEventListener('click', function () { ask(b.getAttribute('data-q')); });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { pauseHands(); } else { resumeHands(); }
  });

  /* ---------- boot ---------- */
  function greet() {
    var h = new Date().getHours();
    var part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    addMsg('bot', 'Good ' + part + '. All systems are online.\nI can tell the time, run timers, do sums, check the weather and open maps or searches. Ask in Thai or English.\nสวัสดีครับ พร้อมรับคำสั่งแล้วครับ');
  }
  greet();
  applyLang();
  applyMute();
  setNet();
  tickClock();
  setInterval(function () { tickClock(); tickTimers(); }, 1000);
  // The settings text lives in index.html; update it here so only app.js needs replacing.
  (function () {
    var lab = document.querySelector('label[for="key"]');
    if (lab) lab.textContent = 'API key (Gemini or Claude)';
    var hint = document.querySelector('.hint');
    if (hint) hint.textContent = 'Saved only on this phone. A key from aistudio.google.com (free) or console.anthropic.com both work. The app picks the right one automatically.';
    $('model').placeholder = 'leave empty for the default';
  })();
  if (!apiKey) { say('First step: tap SET and paste your API key.'); }
  if (hands) startHands();
})();
