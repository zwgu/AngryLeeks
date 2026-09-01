/* ============================================================================
 * 愤怒的韭菜 (Angry Leeks)
 * ----------------------------------------------------------------------------
 * 微信小游戏 + 浏览器双端运行的单文件游戏核心。
 *
 * 玩法：拖动弹弓把愤怒的韭菜射出去，砸碎多头牛、空头熊和庄家的堡垒，
 *       收集收益（金币），一路过关，夺回韭菜村的财富！
 *
 * 双端适配：
 *   - 微信小游戏：全局 wx 存在，使用 wx.createCanvas / wx.onTouch* ；
 *   - 浏览器：   通过 UMD 暴露 AngryLeeksGame，index.html 调用 start()。
 *
 * 素材策略（v3）：主角/敌人/武器/背景用真实图片素材（assets/，IMG_DEF 注册）；
 *       未加载成功时自动回退到 Canvas 实时绘制（drawLeek/drawEnemy 兜底）。
 *       音效仍用 WebAudio 合成，无音频资源。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.AngryLeeksGame = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  /* ====================== 工具函数 ====================== */
  var TAU = Math.PI * 2;
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var easeOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };
  var easeInOut = function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };
  /* 确定性伪随机（用于画砖缝、裂纹等，保证每帧稳定） */
  function hash01(n) {
    var s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  var IS_WX = (typeof wx !== 'undefined') && (typeof wx.createCanvas === 'function');

  /* ====================== 存储 ====================== */
  function storageGet(key, def) {
    try {
      if (IS_WX && typeof wx.getStorageSync === 'function') {
        var v = wx.getStorageSync(key);
        return (v === '' || v === undefined || v === null) ? def : v;
      }
      if (typeof localStorage !== 'undefined') {
        var s = localStorage.getItem(key);
        return s === null ? def : JSON.parse(s);
      }
    } catch (e) { /* ignore */ }
    return def;
  }
  function storageSet(key, val) {
    try {
      if (IS_WX && typeof wx.setStorageSync === 'function') { wx.setStorageSync(key, val); return; }
      if (typeof localStorage !== 'undefined') { localStorage.setItem(key, JSON.stringify(val)); }
    } catch (e) { /* ignore */ }
  }

  /* ====================== 音效（WebAudio 合成） ====================== */
  var Sound = {
    ctx: null,
    muted: !!storageGet('al_muted', false),
    init: function () {
      if (this.ctx) return;
      try {
        if (IS_WX && typeof wx.createWebAudioContext === 'function') {
          this.ctx = wx.createWebAudioContext();
        } else if (typeof AudioContext !== 'undefined') {
          this.ctx = new AudioContext();
        } else if (typeof webkitAudioContext !== 'undefined') {
          this.ctx = new webkitAudioContext();
        }
      } catch (e) { this.ctx = null; }
    },
    resume: function () {
      if (this.ctx && this.ctx.state === 'suspended') {
        try { this.ctx.resume(); } catch (e) { /* ignore */ }
      }
    },
    tone: function (freq, dur, type, vol, when, slideTo) {
      if (!this.ctx || this.muted) return;
      try {
        var t = this.ctx.currentTime + (when || 0);
        var o = this.ctx.createOscillator();
        var g = this.ctx.createGain();
        o.type = type || 'sine';
        o.frequency.setValueAtTime(freq, t);
        if (slideTo) { o.frequency.exponentialRampToValueAtTime(slideTo, t + dur); }
        g.gain.setValueAtTime(vol || 0.2, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(this.ctx.destination);
        o.start(t); o.stop(t + dur + 0.03);
      } catch (e) { /* ignore */ }
    },
    noise: function (dur, vol, when) {
      if (!this.ctx || this.muted) return;
      try {
        var t = this.ctx.currentTime + (when || 0);
        var len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
        var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) { d[i] = (Math.random() * 2 - 1) * (1 - i / len); }
        var src = this.ctx.createBufferSource();
        src.buffer = buf;
        var g = this.ctx.createGain();
        g.gain.setValueAtTime(vol || 0.2, t);
        var f = this.ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 1400;
        src.connect(f); f.connect(g); g.connect(this.ctx.destination);
        src.start(t);
      } catch (e) { /* ignore */ }
    },
    launch: function () { this.noise(0.18, 0.22); this.tone(300, 0.12, 'sine', 0.06, 0, 620); },
    hit: function () { this.tone(150, 0.1, 'triangle', 0.22); this.noise(0.07, 0.12); },
    crack: function () { this.noise(0.18, 0.3); this.tone(220, 0.16, 'sawtooth', 0.08, 0, 80); },
    bigCrack: function () { this.noise(0.3, 0.4); this.tone(140, 0.25, 'sawtooth', 0.12, 0, 50); },
    coin: function () { this.tone(880, 0.07, 'square', 0.1); this.tone(1318, 0.1, 'square', 0.08, 0.055); },
    reload: function () { this.tone(520, 0.07, 'sine', 0.1, 0, 780); },
    win: function () { var me = this; [523, 659, 784, 1047].forEach(function (f, i) { me.tone(f, 0.2, 'triangle', 0.18, i * 0.13); }); },
    lose: function () { var me = this; [330, 262, 196, 147].forEach(function (f, i) { me.tone(f, 0.24, 'triangle', 0.15, i * 0.15); }); },
    /* v7：敌人镰刀激光 / 主角受伤 */
    laser: function () { this.tone(1500, 0.12, 'sawtooth', 0.07, 0, 260); this.noise(0.05, 0.12); },
    hurt: function () { this.tone(250, 0.25, 'sawtooth', 0.16, 0, 100); this.noise(0.14, 0.22); },
    /* v7.11：结局烟花高潮的人群欢呼（纯合成：喧闹底噪 + woohoo 滑音 + 尖叫 + 掌声） */
    cheer: function () {
      if (!this.ctx || this.muted) return;
      try {
        var ctx = this.ctx, t0 = ctx.currentTime;
        /* 1) 人群喧闹底噪：带通噪声 3.2s，缓起 + 指数缓落 + 3Hz 音量波动 */
        var len = Math.floor(ctx.sampleRate * 3.2);
        var buf = ctx.createBuffer(1, len, ctx.sampleRate);
        var d = buf.getChannelData(0);
        var att = ctx.sampleRate * 0.5;
        for (var i = 0; i < len; i++) {
          var env = Math.min(1, i / att) * Math.exp(-i / (ctx.sampleRate * 2.1));
          d[i] = (Math.random() * 2 - 1) * env;
        }
        var src = ctx.createBufferSource(); src.buffer = buf;
        var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.7;
        var ng = ctx.createGain(); ng.gain.value = 0.13;
        var lfo = ctx.createOscillator(); lfo.frequency.value = 3;
        var lfoG = ctx.createGain(); lfoG.gain.value = 0.045;
        lfo.connect(lfoG); lfoG.connect(ng.gain);
        src.connect(bp); bp.connect(ng); ng.connect(ctx.destination);
        src.start(t0); lfo.start(t0);
        src.stop(t0 + 3.4); lfo.stop(t0 + 3.4);
        /* 2) 多声部 woohoo 滑音（带颤音的人声上扬） */
        var whoops = [
          { at: 0.1,  f0: 470, f1: 950,  dur: 0.85, vol: 0.05,  type: 'sawtooth' },
          { at: 0.32, f0: 550, f1: 1120, dur: 0.9,  vol: 0.045, type: 'sawtooth' },
          { at: 0.58, f0: 430, f1: 880,  dur: 0.8,  vol: 0.04,  type: 'square' },
          { at: 1.15, f0: 510, f1: 1050, dur: 0.95, vol: 0.05,  type: 'sawtooth' },
          { at: 1.5,  f0: 600, f1: 1240, dur: 1.0,  vol: 0.045, type: 'square' }
        ];
        for (var w = 0; w < whoops.length; w++) {
          var wp = whoops[w], wt = t0 + wp.at;
          var o = ctx.createOscillator(); o.type = wp.type;
          o.frequency.setValueAtTime(wp.f0, wt);
          o.frequency.exponentialRampToValueAtTime(wp.f1, wt + wp.dur * 0.7);
          o.frequency.exponentialRampToValueAtTime(wp.f1 * 0.85, wt + wp.dur);
          var vb = ctx.createOscillator(); vb.frequency.value = 7;
          var vbG = ctx.createGain(); vbG.gain.value = 14;
          vb.connect(vbG); vbG.connect(o.frequency);
          var g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, wt);
          g.gain.exponentialRampToValueAtTime(wp.vol, wt + 0.09);
          g.gain.setValueAtTime(wp.vol, wt + wp.dur * 0.7);
          g.gain.exponentialRampToValueAtTime(0.0001, wt + wp.dur);
          o.connect(g); g.connect(ctx.destination);
          o.start(wt); o.stop(wt + wp.dur + 0.05);
          vb.start(wt); vb.stop(wt + wp.dur + 0.05);
        }
        /* 3) 两声尖叫（高音下滑） */
        var screams = [
          { at: 0.5, f0: 2100, f1: 1350, dur: 0.5,  vol: 0.035 },
          { at: 1.4, f0: 2300, f1: 1500, dur: 0.55, vol: 0.04 }
        ];
        for (var s = 0; s < screams.length; s++) {
          var sp = screams[s], st = t0 + sp.at;
          var o = ctx.createOscillator(); o.type = 'sine';
          o.frequency.setValueAtTime(sp.f0, st);
          o.frequency.exponentialRampToValueAtTime(sp.f1, st + sp.dur);
          var g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, st);
          g.gain.exponentialRampToValueAtTime(sp.vol, st + 0.06);
          g.gain.exponentialRampToValueAtTime(0.0001, st + sp.dur);
          o.connect(g); g.connect(ctx.destination);
          o.start(st); o.stop(st + sp.dur + 0.03);
        }
        /* 4) 掌声碎点：8 个随机高频噪声短爆 */
        for (var c = 0; c < 8; c++) {
          var ct = t0 + 0.1 + Math.random() * 2.9;
          var cl = Math.floor(ctx.sampleRate * 0.05);
          var cb = ctx.createBuffer(1, cl, ctx.sampleRate);
          var cd = cb.getChannelData(0);
          for (var j = 0; j < cl; j++) cd[j] = (Math.random() * 2 - 1) * (1 - j / cl);
          var cs = ctx.createBufferSource(); cs.buffer = cb;
          var cf = ctx.createBiquadFilter(); cf.type = 'highpass'; cf.frequency.value = 2500;
          var cg = ctx.createGain(); cg.gain.value = 0.055;
          cs.connect(cf); cf.connect(cg); cg.connect(ctx.destination);
          cs.start(ct);
        }
      } catch (e) { /* ignore */ }
    }
  };

  /* ====================== 环境 / Canvas ====================== */
  var canvas = null;
  var ctx = null;
  var W = 450, H = 800, DPR = 1;

  function setupCanvas(canvasId) {
    if (IS_WX) {
      canvas = wx.createCanvas();
      var info = (typeof wx.getSystemInfoSync === 'function') ? wx.getSystemInfoSync() : {};
      W = info.windowWidth || 375;
      H = info.windowHeight || 667;
      DPR = info.pixelRatio || 1;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
    } else {
      canvas = document.getElementById(canvasId);
      DPR = Math.min((window.devicePixelRatio || 1), 2);
      W = 450; H = 800;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
    }
    ctx = canvas.getContext('2d');
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  /* ====================== 真实图片素材（v3） ====================== */
  var IMG = {};               // key -> Image
  var IMG_READY = 0;
  /* v7.10 关键修复：微信小游戏 wx.createImage 的本地路径【不支持 query string】——
   * 'assets/head_male.png?v=3' 会被当作远程 URL 请求而加载失败（onerror），
   * 导致微信端全部回退到旧素材/Canvas 兜底（旧全身角色、旧武器、旧卡通敌人）。
   * 修复：微信端用纯路径（包内文件每次上传整体替换，无需破缓存）；
   * 浏览器端保留 ?v= 破旧 HTTP 缓存。 */
  var IMG_DEF = (function () {
    var q = IS_WX ? '' : '?v=4';
    return {
      bg:         'assets/bg_mountain.png' + q,
      heroMale:   'assets/hero_leek.png' + q,
      heroFemale: 'assets/hero_leekflower.png' + q,
      heroMaleHead:   'assets/head_male.png' + q,      /* 大头特写（男） */
      heroFemaleHead: 'assets/head_female.png' + q,    /* 大头特写（女） */
      /* v7.4 敌人素材白洞清理批次（镰刀与腿之间的白色背景缝隙已清除） */
      bull:       'assets/enemy_bull.png' + q,
      bear:       'assets/enemy_bear.png' + q,
      tiger:      'assets/enemy_tiger.png' + q,
      lion:       'assets/enemy_lion.png' + q,
      wolf:       'assets/enemy_wolf.png' + q,
      fox:        'assets/enemy_fox.png' + q,
      dog:        'assets/enemy_dog.png' + q,
      /* v7.6：石头还原真实素材（用户：Canvas 圆石不像石头）；其余武器仍用 Canvas 精绘 */
      stone: 'assets/wpn_stone.png' + q,
    };
  })();
  function loadImages() {
    /* Node 测试环境无 Image，直接跳过（hasImg 返回 false，走 Canvas 兜底） */
    if (typeof Image === 'undefined' && !IS_WX) return;
    var mk = IS_WX ? (function () { return wx.createImage(); }) : (function () { return new Image(); });
    var keys = Object.keys(IMG_DEF);
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        var img = mk();
        IMG[k] = img;
        img.onload = function () { IMG_READY++; };
        img.onerror = function () { IMG_READY++; };
        img.src = IMG_DEF[k];
      })(keys[i]);
    }
  }
  function hasImg(k) { return !!(IMG[k] && IMG[k].width > 0); }
  function drawImg(k, x, y, w, h) {
    var img = IMG[k];
    if (!img || !img.width) return false;
    ctx.drawImage(img, x, y, w, h);
    return true;
  }

  /* ===== v5 自定义头像：把头部换成玩家自己的头像 =====
   * src：图片 URL / 本地路径（微信 wx.chooseMedia 的临时文件）。
   * 设置后立即生效并持久化到 al_avatar；传空串清除。
   * CUSTOM_AVATAR_ACTIVE 同步标志：保证 drawHeadFace 头饰跳过判断的可靠性（异步 onload 不可依赖）。 */
  var CUSTOM_AVATAR_ACTIVE = false;
  function setAvatar(src) {
    if (IMG['avatar']) { IMG['avatar'].onload = IMG['avatar'].onerror = null; }
    if (!src) { delete IMG['avatar']; CUSTOM_AVATAR_ACTIVE = false; storageSet('al_avatar', ''); return; }
    var img = IS_WX ? (function () { return wx.createImage(); })() : new Image();
    IMG['avatar'] = img;
    img.onload = function () { IMG_READY++; };
    img.onerror = function () { IMG_READY++; };
    img.src = src;
    storageSet('al_avatar', src);
    CUSTOM_AVATAR_ACTIVE = true;
  }
  /* 启动时恢复上次的头像 */
  var savedAvatar = storageGet('al_avatar', '');
  if (savedAvatar) {
    var avImg = IS_WX ? (function () { return wx.createImage(); })() : new Image();
    IMG['avatar'] = avImg;
    avImg.onload = function () { IMG_READY++; };
    avImg.onerror = function () { IMG_READY++; };
    avImg.src = savedAvatar;
    CUSTOM_AVATAR_ACTIVE = true;
  }

  var raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame
    : function (cb) { setTimeout(function () { cb(performance.now()); }, 16); };

  /* ====================== 输入 ====================== */
  var touchState = { x: 0, y: 0, active: false };

  function onTouch(type, x, y) {
    touchState.x = x; touchState.y = y;
    if (type === 'down') {
      touchState.active = true;
      Sound.init(); Sound.resume();
      handleDown(x, y);
    } else if (type === 'move') {
      handleMove(x, y);
    } else if (type === 'up') {
      touchState.active = false;
      handleUp(x, y);
    }
  }

  function toLogical(clientX, clientY) {
    if (IS_WX) { return { x: clientX, y: clientY }; }
    var rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (W / Math.max(rect.width, 1)),
      y: (clientY - rect.top) * (H / Math.max(rect.height, 1))
    };
  }

  function setupInput() {
    if (IS_WX) {
      wx.onTouchStart(function (e) {
        var t = e.touches && e.touches[0];
        if (t) onTouch('down', t.clientX, t.clientY);
      });
      wx.onTouchMove(function (e) {
        var t = e.touches && e.touches[0];
        if (t) onTouch('move', t.clientX, t.clientY);
      });
      wx.onTouchEnd(function () { onTouch('up', 0, 0); });
      wx.onTouchCancel(function () { onTouch('up', 0, 0); });
    } else {
      canvas.addEventListener('mousedown', function (e) {
        var p = toLogical(e.clientX, e.clientY);
        onTouch('down', p.x, p.y);
      });
      window.addEventListener('mousemove', function (e) {
        if (touchState.active) {
          var p = toLogical(e.clientX, e.clientY);
          onTouch('move', p.x, p.y);
        }
      });
      window.addEventListener('mouseup', function () { if (touchState.active) onTouch('up', 0, 0); });
      canvas.addEventListener('touchstart', function (e) {
        if (e.preventDefault) e.preventDefault();
        var t = e.touches && e.touches[0];
        if (t) { var p = toLogical(t.clientX, t.clientY); onTouch('down', p.x, p.y); }
      }, { passive: false });
      canvas.addEventListener('touchmove', function (e) {
        if (e.preventDefault) e.preventDefault();
        var t = e.touches && e.touches[0];
        if (t) { var p = toLogical(t.clientX, t.clientY); onTouch('move', p.x, p.y); }
      }, { passive: false });
      window.addEventListener('touchend', function () { onTouch('up', 0, 0); });
    }
  }

  /* ====================== 全局状态 ====================== */
  var GROUND_Y = 650;   // 地面线（山脚韭菜地平面，start() 中按画布高重算）
  var SX = W * 0.5, SY = GROUND_Y - 40; // v7.8 弹弓居中（W/2）；v7.7 起再低 14px 插进黄土；start() 中按画布宽重算
  var GRAV = 1500;
  var POWER = 12;
  var AIM_SPEED = 1080;   /* v7.9：发射速度提升（860→1080，飞行更快手感更爽） */
  var MAX_DRAG = 100;   // 最大下拉：山巅敌人需要更大的初速度
  var MIN_DRAG = 16;
  var LEEK_R = 16;
  /* 发射点相对地面的高度：抬高发射点可增加下拉空间，让高位敌人够得着。
   * 旧值 44 时最大下拉仅 42px → 弹道最高点离地约 67px，第 3/5 关的高台敌人永远打不到；
   * 70 时最大下拉 68px → 最高点约 170px 以上，全部敌人可达。 */
  var LAUNCH_OFF = 70;
  /* ===== 山体场景（v4 自下而上打上山顶） =====
   * 山脚 = 绿油油的韭菜地（弹弓中置），敌人按关卡从低到高站在梯田上：
   *   第 1 关 游资狗 → 第 6 关 空头熊，山顶平台是城堡（欢庆胜利后冲进去）。 */
  /* 每关梯田台面 y（关卡越高越高，间距 70：从山脚一路爬升到山巅）。
   * 第 1 关台面(505)明显高于弹弓发射点(510-70=…)，保证游资狗站得高、够得着 */
  var TERRACE_TOPS = [505, 435, 365, 295, 225, 155];
  var TERRACE_HALF = [168, 156, 142, 124, 106, 88]; // v7.8 整体收窄（山体更瘦，弹弓居中的黄土空地更大）；仍严格递减 12/14/18/18/18；顶台 88 容金牛+城堡并排（金牛右缘 313=台面右缘，不能再缩）
  var PEAK_Y = 120;     // 山顶平台（城堡所在地）

  var G = {
    state: 'MENU',        // MENU | SELECT | SHOP | PLAY | WIN | LOSE
    level: 0,
    blocks: [],
    projectiles: [],
    particles: [],
    coins: [],
    texts: [],
    drones: [],           // 召唤单位（航母小飞机 / 空天母舰无人机）
    beams: [],            // 激光特效（智子折射 / 无人机点射 / 敌人镰刀激光）
    enemyFire: [],        // v7：敌人镰刀发射的激光球（打伤主角）
    hp: 12,               // v7：主角生命值（被敌人激光击中扣 1）
    hurtT: 0,             // 受伤红屏计时
    minis: [],            // 分裂弹 / 机枪弹雨
    nukeDouble: false,    // 本关是否触发过大爆炸双倍收益
    shotsLeft: 0,
    score: 0,
    enemiesLeft: 0,
    dragging: false,
    dragVec: { x: 0, y: 0 },
    activeLeek: null,     // 飞行中的韭菜
    settleTimer: 0,
    flightTimer: 0,
    reloadPop: 0,
    shake: 0,
    time: 0,
    hintTimer: 999,
    winTimer: 0,
    loseTimer: 0,
    finalT: 0,            // 通关结局动画计时（FINAL 状态）
    fwTimer: 0,           // 烟花发射节拍
    finaleBoom: false,    // 高潮齐射是否已触发
    stars: 0,
    starAnim: [0, 0, 0],
    unlock: storageGet('al_unlock', 1),
    bestStars: storageGet('al_stars', {}),
    muted: Sound.muted,
    uiButtons: [],
    pressedBtn: null,
    isLast: false,
    levelName: '',
    whiteFlash: 0,        // v7.3：城堡受击闪白计时（弹头命中山顶城堡的反馈）
    /* v3 角色/武器系统 / v7.7：积分兑换武器 */
    gender: storageGet('al_gender', 'male'),          // male 韭菜 | female 韭菜花
    weapon: storageGet('al_weapon', 'stone'),         // 当前装备的武器（玩家自选，默认石头）
    owned: storageGet('al_owned', ['stone']),         // 已拥有（已兑换）的武器列表，默认石头
    weaponLv: storageGet('al_wlv', {}),               // { leek: 3 } 武器等级
    money: storageGet('al_money', 0),                 // 累计收益 ¥
    shopTab: 'upgrade',                               // 武器库标签：upgrade 升级 | select 选择
    selLevel: 0,                                      // 从菜单选择要进入的关卡
    resetModal: false                                 // v7.9：重置确认弹窗是否打开（点击「重置」后弹出，确定才执行）
  };

  /* ====================== 武器系统（v7.4 山脚直线弹道·时代升级版 / v7.7 积分兑换版） ======================
   * 主角站在山脚武器阵地，直线弹道向上发射，每关对应一个战争时代：
   *   stone   石头         冷兵器   巨石直砸
   *   knife   炸弹         热兵器   命中爆炸 AOE
   *   grenade 火箭弹       现代战争 弹雨扫射（一发 7 颗）
   *   gun     超级炸弹       重火力   重炮轰击（命中爆炸 AOE）
   *   cannon  脉冲弹       智能战争 EMP 大爆炸全屏双倍
   *   nuke    恒星弹       星球大战 升空到山头上方 → 轨道轰炸 + 无人机群
   * cost: 兑换所需积分（0=默认拥有石头）。玩家在武器库用积分自由兑换，
   * 打得好（三星通关）还可直接奖励解锁下一把武器。
   * type: ball 直射 / pierce 穿透 / rapid 连发 / bomb 爆炸 / nuke 大爆炸 / carrier 空袭
   */
  var WEAPONS = {
    stone:   { name: '石头',   era: 1, cost: 0,    dmg: 26, type: 'ball',   desc: '巨石直砸山头' },
    knife:   { name: '炸弹',   era: 2, cost: 250,  dmg: 40, type: 'bomb',   desc: '扫雷黑地雷·炸飞一片' },
    grenade: { name: '火箭弹', era: 3, cost: 600,  dmg: 48, type: 'rapid',  desc: '火箭弹雨·火力覆盖' },
    gun:     { name: '超级炸弹', era: 4, cost: 1000, dmg: 58, type: 'bomb',   desc: '巨型炸弹·夷平高崖' },
    cannon:  { name: '脉冲弹', era: 5, cost: 1600, dmg: 75, type: 'nuke',   desc: '脉冲弹·EMP 全屏打击' },
    nuke:    { name: '恒星弹', era: 6, cost: 2400, dmg: 85, type: 'carrier', desc: '火太阳恒星弹·星球大战' }
  };
  var WEAPON_ORDER = ['stone', 'knife', 'grenade', 'gun', 'cannon', 'nuke'];
  var LV_COST = [0, 200, 500, 1000, 2000];   /* 升到 Lv2~Lv5 的花费 */
  var LV_MAX = 5;
  var ERA_NAMES = ['', '冷兵器时代', '热兵器时代', '现代战争时代', '重火力时代', '智能战争时代', '星球大战时代'];
  var ERA_ICON = ['', '🏹', '💣', '🚀', '💥', '⚡', '🌌'];
  var LV_COST = [0, 200, 500, 1000, 2000];   /* 升到 Lv2~Lv5 的花费 */
  var LV_MAX = 5;

  /* ====================== 敌人系统（半山腰摄魂怪动物军团） ====================== */
  var ENEMY_DEF = {
    bull:       { hp: 240, score: 2500, coins: 60, name: '金牛',     type: 'bull' },
    wolf:       { hp: 55,  score: 400,  coins: 10, name: '主力狼',   type: 'wolf' },
    fox:        { hp: 70,  score: 450,  coins: 11, name: '量化狐',   type: 'fox' },
    bear:       { hp: 130, score: 900,  coins: 20, name: '空头熊',   type: 'bear' },
    dog:        { hp: 150, score: 800,  coins: 18, name: '游资狗',   type: 'dog' },
    tiger:      { hp: 180, score: 1000, coins: 22, name: '机构虎',   type: 'tiger' },
    lion:       { hp: 220, score: 1500, coins: 30, name: '庄家狮',   type: 'lion' },
    whitehouse: { hp: 900, score: 5000, coins: 60, name: '山顶老怪', type: 'whitehouse' }
  };
  /* 每关敌人 HP 成长系数 */
  var ENEMY_GROW = 0.12;

  /* ====================== 关卡定义（v4 山体战场 / v7 直线弹道） ======================
   * item = [kind, cxOff(相对画面中心的横向偏移), yUp(物品底部距本关梯田台面的高度), w, h, elite?]
   * 敌人按关卡从低到高站在山体梯田上：第 1 关游资狗（山脚）→ 第 5 关空头熊（顶峰），
   * 第 6 关金牛坐在城堡门口——战胜金牛，冲进城堡，欢庆胜利！
   * weapon：本关主角武器（stone 石头 / knife 炸弹 / grenade 火箭弹 / gun 超级炸弹 / cannon 脉冲弹 / nuke 恒星弹）
   */
  var LEVELS = [
    {
      name: '第 1 关 · 山脚 · 游资狗',
      leeks: 7,
      weapon: 'stone',
      hint: '石头就位，砸烂山脚的游资狗！',
      items: [
        ['plank', -95, 0, 120, 16],
        ['leg', -119, 0, 12, 16],
        ['leg', -71, 0, 12, 16],
        ['dog', -95, 16, 56, 60],
        ['stone', 95, 0, 46, 40],
        ['dog', 95, 40, 56, 60],
        ['brick', 40, 0, 34, 26]
      ]
    },
    {
      name: '第 2 关 · 低坡 · 量化狐',
      leeks: 6,
      weapon: 'knife',
      hint: '炸弹就位，狐狸无处遁形！',
      items: [
        ['plank', -85, 0, 120, 16],
        ['leg', -109, 0, 12, 16],
        ['leg', -61, 0, 12, 16],
        ['fox', -85, 16, 48, 52],
        ['stone', 80, 0, 50, 44],
        ['wolf', 80, 44, 52, 58],
        ['plank', 100, 0, 80, 14],
        ['leg', 76, 0, 12, 14],
        ['leg', 124, 0, 12, 14],
        ['fox', 100, 14, 48, 52]
      ]
    },
    {
      name: '第 3 关 · 半山腰 · 主力狼',
      leeks: 6,
      weapon: 'grenade',
      hint: '火箭弹就位，狼群灰飞烟灭！',
      items: [
        ['stone', -75, 0, 56, 52],
        ['wolf', -75, 52, 52, 58],
        ['stone', 75, 0, 56, 52],
        ['wolf', 75, 52, 52, 58],
        ['plank', 0, 0, 90, 14],
        ['leg', -24, 0, 12, 14],
        ['leg', 24, 0, 12, 14],
        ['wolf', 0, 14, 52, 58]
      ]
    },
    {
      name: '第 4 关 · 高崖 · 庄家狮',
      leeks: 8,
      weapon: 'gun',
      hint: '超级炸弹一响，狮王也低头！',
      items: [
        ['stone', -45, 0, 76, 64],
        ['lion', -45, 64, 90, 96],
        ['dog', 20, 0, 56, 60],
        ['fox', 80, 0, 48, 52],
        ['brick', -80, 0, 34, 26]
      ]
    },
    {
      name: '第 5 关 · 顶峰 · 空头熊',
      leeks: 10,
      weapon: 'cannon',
      hint: '脉冲弹升空，熊市彻底终结！',
      items: [
        ['bear', 0, 0, 70, 76, true],
        ['bear', -52, 0, 64, 70],
        ['tiger', 52, 0, 60, 64],
        ['wolf', -72, 0, 52, 58],
        ['fox', 72, 0, 48, 52]
      ]
    },
    {
      name: '第 6 关 · 城堡门口 · 金牛',
      leeks: 12,
      weapon: 'nuke',
      hint: '恒星弹锁定，火太阳轰炸城堡门口的金牛！',
      items: [
        ['bull', 44, 0, 84, 88, true],
        ['bear', -46, 0, 64, 70],
        ['wolf', -62, 0, 52, 58],
        ['fox', 60, 0, 48, 52]
      ]
    }
  ];

  var BLOCK_DEF = {
    plank:  { hp: 40,  score: 40,  coins: 2 },
    leg:    { hp: 30,  score: 30,  coins: 1 },
    brick:  { hp: 70,  score: 80,  coins: 3 },
    stone:  { hp: 110, score: 120, coins: 4 },
    bull:       { hp: 240, score: 2500, coins: 60, enemy: true },
    wolf:       { hp: 55,  score: 400,  coins: 10, enemy: true },
    fox:        { hp: 70,  score: 450,  coins: 11, enemy: true },
    bear:       { hp: 130, score: 900,  coins: 20, enemy: true },
    dog:        { hp: 150, score: 800,  coins: 18, enemy: true },
    tiger:      { hp: 180, score: 1000, coins: 22, enemy: true },
    lion:       { hp: 220, score: 1500, coins: 30, enemy: true },
    whitehouse: { hp: 900, score: 5000, coins: 60, enemy: true }
  };

  function isEnemy(k) { return !!(BLOCK_DEF[k] && BLOCK_DEF[k].enemy); }
  function enemyName(k) { return (ENEMY_DEF[k] && ENEMY_DEF[k].name) || k; }
  /* v7：BOSS 判定（精英 / 大怪）——周期性发射镰刀激光 */
  function isBossEnemy(b) {
    return !!(b.elite || b.kind === 'bull' || b.kind === 'lion' || b.kind === 'whitehouse');
  }

  function buildLevel(idx) {
    var def = LEVELS[idx];
    var s = clamp(W / 470, 0.8, 1);
    var A = W * 0.5;
    var baseY = TERRACE_TOPS[idx] || GROUND_Y;   /* v4：站在本关梯田台面上（越高越难） */
    G.blocks = [];
    G.projectiles = [];
    G.particles = [];
    G.coins = [];
    G.texts = [];
    G.drones = [];
    G.beams = [];
    G.minis = [];
    G.enemyFire = [];
    G.hp = 12;                      /* v7：主角生命 */
    G.hurtT = 0;
    G.nukeDouble = false;
    G.shotsLeft = def.leeks;
    G.score = 0;
    G.enemiesLeft = 0;
    G.activeLeek = null;
    G.settleTimer = 0;
    G.flightTimer = 0;
    G.dragging = false;
    G.dragVec = { x: 0, y: 0 };
    G.shake = 0;
    G.winTimer = 0;
    G.loseTimer = 0;
    G.hintTimer = 999;
    G.levelName = def.name;
    G.isLast = idx === LEVELS.length - 1;
    /* v7.7：武器由玩家在武器库用积分兑换/自选，不再按关卡强制（默认都是石头）。
     * 若装备的武器未拥有（旧存档越权），回退石头。 */
    if (G.owned.indexOf(G.weapon) < 0) G.weapon = 'stone';
    /* 敌人 HP 随关成长 */
    var grow = 1 + ENEMY_GROW * idx;
    for (var i = 0; i < def.items.length; i++) {
      var it = def.items[i];
      var w = it[3] * s, h = it[4] * s;
      var x = A + it[1] * s - w / 2;
      var y = baseY - it[2] * s - h;
      var d = BLOCK_DEF[it[0]];
      var elite = !!it[5];
      var hp = d.hp * (isEnemy(it[0]) ? grow : 1) * (elite ? 1.5 : 1);
      var b = {
        kind: it[0], x: x, y: y, w: w, h: h,
        vx: 0, vy: 0,
        hp: hp, maxHp: hp,
        score: d.score * (elite ? 2 : 1), coins: Math.round(d.coins * (elite ? 2 : 1)),
        enemy: !!d.enemy, elite: elite,
        dead: false, wobble: 0, flash: 0,
        /* v6.1：出生即休眠——方块静止站在本关梯田台面上，不再滑落山脚地面。
         * 被击中(collideLeekBlock)/爆炸(explode/nuke)/支撑被毁(wakeNear)/碰撞时唤醒 */
        awake: false, sleepT: 0,
        slowT: 0,          /* 花粉减速计时 */
        attackT: isEnemy(it[0]) ? rand(2.5, 4.5) : 0,   /* v7：敌人镰刀激光攻击倒计时 */
        yellT: isEnemy(it[0]) ? rand(1.2, 3.0) : 0,     /* v7：狂叫气泡倒计时 */
        swingT: 0,          /* v7：挥镰动画计时 */
        firedOnce: false,   /* v7：小怪被惊动后只咔嚓一次激光 */
        everAwake: false    /* v7：是否曾被惊动（首次唤醒时重置攻击倒计时） */
      };
      G.blocks.push(b);
      if (b.enemy) G.enemiesLeft++;
    }
  }

  function startLevel(idx) {
    G.level = idx;
    G.state = 'PLAY';
    buildLevel(idx);
    Sound.reload();
  }

  /* ====================== 特效：粒子 / 金币 / 飘字 ====================== */
  function spawnParticles(x, y, color, n, spread, type) {
    for (var i = 0; i < n; i++) {
      if (G.particles.length > 320) return;
      var a = rand(0, TAU);
      var sp = rand(60, spread);
      G.particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - rand(40, 140),
        size: rand(3, 7),
        life: rand(0.4, 0.9),
        maxLife: 0.9,
        color: color,
        type: type || 'rect',
        rot: rand(0, TAU),
        vr: rand(-8, 8)
      });
    }
  }

  function spawnCoins(x, y, n) {
    for (var i = 0; i < n; i++) {
      G.coins.push({
        x: x + rand(-14, 14), y: y + rand(-14, 14),
        vx: rand(-60, 60), vy: rand(-360, -180),
        t: 0, phase: 'rise', rot: rand(0, TAU),
        kind: 'coin', val: 10
      });
    }
  }

  /* v7：敌人死亡「蹦出很多金币和美元」——金色 ¥ 圆 + 绿色 $ 纸钞飞向 HUD */
  function spawnLoot(x, y, n) {
    for (var i = 0; i < n; i++) {
      var isDollar = Math.random() < 0.4;
      G.coins.push({
        x: x + rand(-18, 18), y: y + rand(-18, 18),
        vx: rand(-80, 80), vy: rand(-400, -220),
        t: 0, phase: 'rise', rot: rand(0, TAU),
        kind: isDollar ? 'dollar' : 'coin',
        val: isDollar ? 25 : 10
      });
    }
  }

  function addText(x, y, txt, color, size) {
    G.texts.push({ x: x, y: y, txt: txt, color: color || '#ffd75e', size: size || 18, life: 1.0, maxLife: 1.0 });
  }

  function destroyBlock(b) {
    if (b.dead) return;
    b.dead = true;
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var palette = {
      plank: '#b98a4a', leg: '#a3743c', brick: '#c75b4a',
      stone: '#9aa5b1', bull: '#8a6a3a', wolf: '#6b7280', fox: '#d9822b',
      bear: '#8b5a2b', dog: '#4a5568', tiger: '#d9822b', lion: '#c9a227',
      whitehouse: '#f0ece2'
    };
    spawnParticles(cx, cy, palette[b.kind] || '#aaa', b.wobble > 0.15 ? 18 : 12, 260);
    if (b.enemy) {
      /* v7：敌人死亡蹦出很多金币 + 美元（数值大于普通方块） */
      spawnLoot(cx, cy, 8 + Math.round(b.coins * 1.2));
    } else {
      spawnCoins(cx, cy, b.coins);
    }
    G.score += b.score;
    addText(cx, cy - b.h / 2 - 10, '+' + b.score, b.enemy ? '#ffd75e' : '#ffffff', b.enemy ? 22 : 16);
    if (b.enemy) {
      Sound.bigCrack();
      G.shake = Math.min(G.shake + 7, 12);
      G.enemiesLeft--;
      if (G.enemiesLeft <= 0 && G.state === 'PLAY') {
        /* v4：末关打完空头熊 → 抓多头牛冲进城堡放烟花的结局动画 */
        G.finalT = 0; G.fwTimer = 0; G.finaleBoom = false;
        computeStars();
        if (G.isLast) { G.state = 'FINAL'; G.uiButtons = []; }
        else { G.state = 'WIN'; G.winTimer = 0; G.uiButtons = []; }
        Sound.win();
      }
    } else {
      Sound.crack();
      G.shake = Math.min(G.shake + 2.5, 8);
    }
    wakeNear(cx, cy, 90);
  }

  function wakeNear(x, y, r) {
    for (var i = 0; i < G.blocks.length; i++) {
      var b = G.blocks[i];
      if (b.dead || b.awake) continue;
      if (Math.abs((b.x + b.w / 2) - x) < r + b.w && Math.abs((b.y + b.h / 2) - y) < r + b.h) b.awake = true;
    }
  }

  /* ====================== 武器系统：伤害与特效 ====================== */
  function weaponLv(id) { return G.weaponLv[id] || 1; }
  function weaponDmg(id, lv) {
    var def = WEAPONS[id] || WEAPONS.stone;
    var l = lv || weaponLv(id);
    return def.dmg * (1 + 0.25 * (l - 1));
  }
  function isUnlocked(id) {
    /* v7.7：武器由玩家用积分兑换获得（al_owned 列表），石头默认拥有 */
    return G.owned.indexOf(id) >= 0;
  }
  function unlockForLevel(levelIdx) {
    /* 返回进入某关时可用的武器（仅已兑换拥有的武器；关卡不再自动发武器） */
    var list = [];
    for (var i = 0; i < WEAPON_ORDER.length; i++) {
      var id = WEAPON_ORDER[i];
      if (G.owned.indexOf(id) >= 0) list.push(id);
    }
    return list;
  }
  /* 命中敌人/方块基础伤害（物理冲击 + 武器加成） */
  function hitDamage(p, impact) {
    var base = impact * 0.07;
    var w = (p.weapon && WEAPONS[p.weapon]) ? weaponDmg(p.weapon, p.wlv) : 0;
    return base + w;
  }
  /* 对单个方块造成伤害 */
  function damageBlock(b, dmg, src) {
    if (b.dead) return;
    b.hp -= dmg;
    b.flash = 0.12;
    b.wobble = clamp(b.wobble + 0.05, 0, 0.2);
    if (b.hp <= 0) destroyBlock(b);
  }
  /* 爆炸：半径内 AOE */
  function explode(x, y, r, dmg) {
    spawnParticles(x, y, '#ffd75e', 22, 320, 'circle');
    spawnParticles(x, y, '#ff8a4f', 14, 260);
    for (var i = 0; i < G.blocks.length; i++) {
      var b = G.blocks[i];
      if (b.dead) continue;
      var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      var d = Math.sqrt((cx - x) * (cx - x) + (cy - y) * (cy - y));
      if (d < r + b.w * 0.4) {
        var fall = 1 - clamp(d / (r + b.w * 0.4), 0, 1);
        damageBlock(b, dmg * (0.5 + fall * 0.5), 'explode');
        b.vx += (cx - x) / (d + 1) * 260 * fall;
        b.vy += (cy - y) / (d + 1) * 260 * fall - 120 * fall;
        b.awake = true;
      }
    }
    G.shake = Math.min(G.shake + 6, 12);
    Sound.bigCrack();
    addText(x, y - 18, 'BOOM!', '#ffd75e', 20);
  }
  /* 大爆炸：全屏 + 双倍收益标记。v7.4：伤害与双倍收益按调用方武器的等级计算
   （之前硬编码 'nuke' 导致脉冲弹/超级炸弹等非 nuke 武器触发时伤害错乱） */
  function nuke(x, y, wkey, wlv) {
    spawnParticles(x, y, '#fff3c4', 40, 460, 'circle');
    spawnParticles(x, y, '#ff8a4f', 30, 360);
    spawnParticles(x, y, '#c75b4a', 20, 300);
    G.shake = Math.min(G.shake + 14, 16);
    var dmg = weaponDmg(wkey || 'nuke', wlv || (G.weaponLv[wkey] || 1));
    for (var i = 0; i < G.blocks.length; i++) {
      var b = G.blocks[i];
      if (b.dead) continue;
      var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      var d = Math.sqrt((cx - x) * (cx - x) + (cy - y) * (cy - y));
      var fall = 1 - clamp(d / (W * 0.7), 0, 0.6);
      damageBlock(b, dmg * (0.4 + fall * 0.6), 'nuke');
      b.vx += (cx - x) / (d + 1) * 420 * fall;
      b.vy += (cy - y) / (d + 1) * 420 * fall - 200 * fall;
      b.awake = true;
      if (b.enemy) G.nukeDouble = true;  /* 双倍收益 */
    }
    Sound.bigCrack();
    Sound.bigCrack();
    addText(x, y - 24, '💥 大爆炸！', '#ffd75e', 26);
  }
  /* 分裂弹：生成 n 个小弹丸散射 */
  function spawnSplits(p, n, kind, dmg, speed) {
    for (var i = 0; i < n; i++) {
      var a = rand(-1.1, 1.1) + (i / n) * TAU;
      G.minis.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * speed * rand(0.6, 1.1),
        vy: Math.sin(a) * speed * rand(0.6, 1.1) - 60,
        r: kind === 'petal' ? 6 : 8,
        dmg: dmg, kind: kind,
        life: 1.6, maxLife: 1.6,
        hitSet: {}
      });
    }
  }
  /* v7：机关枪——命中后朝前方喷出扇形弹雨（直线弹丸） */
  function spawnBulletSpray(p, n) {
    var baseAng = Math.atan2(p.vy, p.vx);
    var dmg = weaponDmg(p.weapon, p.wlv) * 0.28;
    for (var i = 0; i < n; i++) {
      var a = baseAng + rand(-0.6, 0.6);
      var sp = rand(380, 520);
      G.minis.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        r: 4.5, dmg: dmg, kind: 'bullet',
        life: 0.6, maxLife: 0.6,
        hitSet: {}, noGrav: true
      });
    }
    Sound.hit();
  }
  /* 智子链式折射：命中后连跳最多 4 个其他敌人 */
  function chainRefract(p, b, dmg) {
    var targets = [b];
    var maxJumps = 5;
    var used = {};
    used[G.blocks.indexOf(b)] = true;
    var fx = p.x, fy = p.y;
    while (targets.length < maxJumps) {
      var best = null, bestD = 1e9, bestIdx = -1;
      for (var i = 0; i < G.blocks.length; i++) {
        var ob = G.blocks[i];
        if (ob.dead || !ob.enemy || used[i]) continue;
        var ox = ob.x + ob.w / 2, oy = ob.y + ob.h / 2;
        var dd = (ox - fx) * (ox - fx) + (oy - fy) * (oy - fy);
        if (dd < bestD) { bestD = dd; best = ob; bestIdx = i; }
      }
      if (!best) break;
      used[bestIdx] = true;
      targets.push(best);
      var nx2 = best.x + best.w / 2, ny2 = best.y + best.h / 2;
      G.beams.push({ x1: fx, y1: fy, x2: nx2, y2: ny2, life: 0.35, maxLife: 0.35, color: '#7dfa9c' });
      fx = nx2; fy = ny2;
    }
    for (var t = 1; t < targets.length; t++) {
      damageBlock(targets[t], dmg * 0.7, 'chip');
      addText(targets[t].x + targets[t].w / 2, targets[t].y, '-' + Math.round(dmg * 0.7), '#7dfa9c', 14);
    }
    Sound.coin();
  }
  /* 召唤单位：航母小飞机 / 空天母舰无人机 */
  function spawnDrones(x, y, kind) {
    var n = (kind === 'carrier') ? 3 : 5;
    var lv = G.weaponLv[G.weapon] || 1;
    if (kind === 'drone') n = 3 + lv * 2;   /* Lv1 5 架 → Lv5 13 架 */
    for (var i = 0; i < n; i++) {
      G.drones.push({
        x: x + rand(-30, 30), y: y - rand(20, 70),
        t: i * 0.3, life: 5, maxLife: 5,
        kind: kind, interval: kind === 'drone' ? 0.35 : 0.5,
        dmg: weaponDmg(G.weapon, lv) * (kind === 'drone' ? 0.8 : 0.55)
      });
    }
  }
  /* 无人机/母舰开火：向最近敌人射激光 */
  function droneFire(d) {
    var best = null, bestD = 1e9;
    for (var i = 0; i < G.blocks.length; i++) {
      var b = G.blocks[i];
      if (b.dead || !b.enemy) continue;
      var ex = b.x + b.w / 2, ey = b.y + b.h / 2;
      var dd = (ex - d.x) * (ex - d.x) + (ey - d.y) * (ey - d.y);
      if (dd < bestD) { bestD = dd; best = b; }
    }
    if (!best) return;
    var tx = best.x + best.w / 2, ty = best.y + best.h / 2;
    G.beams.push({ x1: d.x, y1: d.y, x2: tx, y2: ty, life: 0.22, maxLife: 0.22, color: d.kind === 'drone' ? '#7dfa9c' : '#ffd75e' });
    damageBlock(best, d.dmg, 'drone');
    addText(tx, ty - 8, '-' + Math.round(d.dmg), d.kind === 'drone' ? '#7dfa9c' : '#ffd75e', 11);
    spawnParticles(tx, ty, d.kind === 'drone' ? '#7dfa9c' : '#ffd75e', 3, 100, 'circle');
  }
  /* 花粉减速/持续伤害 */
  function applySlow(b, t) {
    b.slowT = Math.max(b.slowT || 0, t);
  }


  /* ====================== 物理 ====================== */
  function stepPhysics(dt) {
    var i, j, b, p;
    /* --- 积分：方块 --- */
    for (i = 0; i < G.blocks.length; i++) {
      b = G.blocks[i];
      if (b.dead) continue;
      if (!b.awake) { b.sleepT += dt; continue; }
      b.vy += GRAV * dt;
      b.vx *= (1 - 0.004);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (Math.abs(b.vx) < 4 && Math.abs(b.vy) < 4) {
        b.sleepT += dt;
        if (b.sleepT > 0.5) { b.awake = false; b.vx = 0; b.vy = 0; }
      } else { b.sleepT = 0; }
      if (b.y > H + 240) { b.dead = true; continue; }
    }
    /* --- 积分：韭菜 --- */
    for (i = 0; i < G.projectiles.length; i++) {
      p = G.projectiles[i];
      if (p.resting || p.fading || p.dead) continue;
      if (p.noGrav !== true) p.vy += GRAV * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.ang += p.spin * dt;
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 9) p.trail.shift();
    }
    /* --- 积分：分裂弹（小花瓣/小饺子） --- */
    for (i = G.minis.length - 1; i >= 0; i--) {
      var m = G.minis[i];
      m.life -= dt;
      if (m.life <= 0) { G.minis.splice(i, 1); continue; }
      if (m.noGrav !== true) m.vy += GRAV * dt;   /* v7：弹雨子弹直线飞行 */
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      if (m.y > GROUND_Y - m.r) { m.y = GROUND_Y - m.r; m.vy *= -0.35; m.vx *= 0.6; }
      for (var mi = 0; mi < G.blocks.length; mi++) {
        var mb = G.blocks[mi];
        if (mb.dead || m.hitSet[mi]) continue;
        var mcx = clamp(m.x, mb.x, mb.x + mb.w);
        var mcy = clamp(m.y, mb.y, mb.y + mb.h);
        var mdx = m.x - mcx, mdy = m.y - mcy;
        if (mdx * mdx + mdy * mdy < m.r * m.r) {
          m.hitSet[mi] = true;
          damageBlock(mb, m.dmg, 'mini');
          addText(m.x, m.y - 10, '-' + Math.round(m.dmg), '#ffd75e', 11);
          spawnParticles(m.x, m.y, m.kind === 'petal' ? '#7ddb8a' : '#fff3c4', 4, 120, 'circle');
          Sound.hit();
          break;
        }
      }
    }
    /* --- v7：梯田台面托举——敌人被唤醒后掉回梯田就停在台面上，不再一路滑到山脚 --- */
    var terrCx = W * 0.5;
    for (i = 0; i < G.blocks.length; i++) {
      b = G.blocks[i];
      if (b.dead || !b.awake) continue;
      var bCx = b.x + b.w / 2, bBot = b.y + b.h;
      for (var k = TERRACE_TOPS.length - 1; k >= 0; k--) {
        var tTop = TERRACE_TOPS[k], tHw = TERRACE_HALF[k];
        if (bCx < terrCx - tHw || bCx > terrCx + tHw) continue;   /* 不在该台面水平范围 */
        if (bBot >= tTop - 2 && bBot <= tTop + 26) {              /* 底部落到台面附近 */
          if (b.vy < 0) break;                                    /* 正在向上飞，不托举 */
          b.y = tTop - b.h;
          if (b.vy > 260) {                                       /* 高处摔落台面自伤 */
            var sd = (b.vy - 260) * 0.05;
            if (sd > 4) { b.hp -= sd; b.flash = 0.12; b.wobble += 0.1; if (b.hp <= 0) { destroyBlock(b); break; } }
            spawnParticles(b.x + b.w / 2, tTop, '#8a6a3a', 4, 110, 'circle');
          }
          b.vy = 0;
          b.vx *= 0.8;
          break;
        }
        if (bBot < tTop - 2) break;   /* 还在该台面上方（未落到台面），等下一帧 */
      }
    }
    /* --- 方块 vs 地面 --- */
    for (i = 0; i < G.blocks.length; i++) {
      b = G.blocks[i];
      if (b.dead) continue;
      if (b.y + b.h > GROUND_Y) {
        var vy0 = b.vy;
        b.y = GROUND_Y - b.h;
        if (vy0 > 0) {
          if (vy0 > 300) { /* 高处摔落自伤 */
            var selfDmg = (vy0 - 300) * 0.06;
            if (selfDmg > 6) {
              b.hp -= selfDmg; b.flash = 0.12; b.wobble += 0.1;
              G.shake = Math.min(G.shake + vy0 * 0.004, 10);
              if (b.hp <= 0) { destroyBlock(b); continue; }
            }
          }
          if (vy0 > 160) spawnParticles(b.x + b.w / 2, GROUND_Y, '#8a6a3a', 5, 120, 'circle');
        }
        b.vy = 0;
        b.vx *= 0.8;
        b.awake = true;
      }
      if (b.x < -60) b.x = -60;
      if (b.x + b.w > W + 60) b.x = W + 60 - b.w;
    }
    /* --- 韭菜 vs 地面 --- */
    for (i = 0; i < G.projectiles.length; i++) {
      p = G.projectiles[i];
      if (p.resting || p.fading || p.dead) continue;
      if (p.y + p.r > GROUND_Y && G.flightTimer > 0.05) {
        p.y = GROUND_Y - p.r;
        var vn = p.vy;
        if (vn > 60) {
          p.vy = -vn * 0.32;
          p.vx *= 0.7;
          p.spin *= 0.6;
          spawnParticles(p.x, GROUND_Y, '#b9c99a', 5, 130, 'circle');
          Sound.hit();
        } else {
          p.vy = 0;
          p.vx *= 0.86;
        }
        if (Math.abs(p.vx) < 50 && Math.abs(p.vy) < 50) settleLeek(p);
      }
      if (p.x < -100 || p.x > W + 100 || p.y < -400) settleLeek(p);
    }
    /* --- 方块 vs 方块（O(n^2)，n 很小） --- */
    for (i = 0; i < G.blocks.length; i++) {
      var a = G.blocks[i];
      if (a.dead) continue;
      for (j = i + 1; j < G.blocks.length; j++) {
        b = G.blocks[j];
        if (b.dead) continue;
        if (!a.awake && !b.awake) continue;
        if (a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h) continue;
        var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        var aCenterX = a.x + a.w / 2, bCenterX = b.x + b.w / 2;
        if (ox < oy) {
          var dir = (aCenterX < bCenterX) ? -1 : 1; /* a 在左则向左推 */
          a.x += dir * ox / 2;
          b.x -= dir * ox / 2;
          var rel = a.vx - b.vx; /* 相对速度（正 = 靠近） */
          if ((dir === -1 && rel > 0) || (dir === 1 && rel < 0)) {
            var jimp = Math.abs(rel);
            if (jimp > 140) {
              var kd = jimp * 0.02;
              if (a.hp - kd <= 0) destroyBlock(a);
              else { a.hp -= kd; a.flash = 0.1; a.wobble += (dir === -1 ? 0.08 : -0.08); }
              if (b.hp - kd <= 0) destroyBlock(b);
              else { b.hp -= kd; b.flash = 0.1; b.wobble += (dir === -1 ? -0.08 : 0.08); }
              Sound.hit();
            }
            a.vx += dir * jimp * 0.42;
            b.vx -= dir * jimp * 0.42;
          }
        } else {
          var dirY = (a.y < b.y) ? -1 : 1; /* a 在上则向上推 */
          a.y += dirY * oy / 2;
          b.y -= dirY * oy / 2;
          var relY = a.vy - b.vy;
          if ((dirY === -1 && relY > 0) || (dirY === 1 && relY < 0)) {
            var jimpY = Math.abs(relY);
            if (jimpY > 140) {
              var kdY = jimpY * 0.02;
              if (a.hp - kdY <= 0) destroyBlock(a);
              else { a.hp -= kdY; a.flash = 0.1; a.wobble += (dirY === -1 ? 0.08 : -0.08); }
              if (b.hp - kdY <= 0) destroyBlock(b);
              else { b.hp -= kdY; b.flash = 0.1; a.wobble += (dirY === -1 ? -0.08 : 0.08); }
              Sound.hit();
            }
            a.vy += dirY * jimpY * 0.42;
            b.vy -= dirY * jimpY * 0.42;
          }
        }
        a.awake = true; b.awake = true;
      }
    }
    /* --- 韭菜 vs 方块 --- */
    for (i = 0; i < G.projectiles.length; i++) {
      p = G.projectiles[i];
      if (p.resting || p.fading || p.dead) continue;
      for (j = 0; j < G.blocks.length; j++) {
        b = G.blocks[j];
        if (b.dead) continue;
        collideLeekBlock(p, b);
        if (p.fading || p.dead) break;
      }
    }
    /* --- 韭菜 vs 山顶城堡（v7.3：城堡是剧情建筑，弹头命中即炸开冒烟，
     * 不再穿过建筑飞到天上。城堡不可破坏——结局是抓牛冲进去。 --- */
    for (i = 0; i < G.projectiles.length; i++) {
      p = G.projectiles[i];
      if (p.resting || p.fading || p.dead) continue;
      /* 城堡碰撞盒：x 在山顶中央 W/2±55（主体+两翼，城堡固定在山顶不随弹弓移动），y 在 PEAK_Y-46..PEAK_Y（墙+三角楣） */
      if (p.y < PEAK_Y && p.y > PEAK_Y - 46 && Math.abs(p.x - W / 2) < 55) {
        hitWhitehouse(p);
        if (p.dead) continue;
      }
    }
  }

  /* v7.3：弹头命中山顶城堡——爆炸烟尘 + 城堡闪白 + 弹头结束（不伤害任何方块/敌人） */
  function hitWhitehouse(p) {
    spawnParticles(p.x, p.y, '#ffffff', 14, 220, 'circle');
    spawnParticles(p.x, p.y, '#ffd75e', 8, 180);
    spawnParticles(p.x, p.y, '#9aa4ae', 10, 140);
    G.whiteFlash = 0.6;
    G.shake = Math.min(G.shake + 4, 11);
    Sound.hit();
    addText(p.x, p.y - 16, '命中城堡!', '#ffe9a8', 13);
    /* 所有弹头命中城堡即结束（航母弹头此时早已展开无人机群，不影响轰炸） */
    p.dead = true;
  }

  function collideLeekBlock(p, b) {
    var cx = clamp(p.x, b.x, b.x + b.w);
    var cy = clamp(p.y, b.y, b.y + b.h);
    var dx = p.x - cx, dy = p.y - cy;
    var d2 = dx * dx + dy * dy;
    var r = p.r;
    if (d2 > r * r) return;
    var nx, ny, depth;
    if (d2 > 0.0001) {
      var d = Math.sqrt(d2);
      nx = dx / d; ny = dy / d; depth = r - d;
    } else {
      var left = p.x - b.x, right = b.x + b.w - p.x;
      var top = p.y - b.y, bottom = b.y + b.h - p.y;
      var m = Math.min(left, right, top, bottom);
      if (m === left) { nx = -1; ny = 0; depth = r + left; }
      else if (m === right) { nx = 1; ny = 0; depth = r + right; }
      else if (m === top) { nx = 0; ny = -1; depth = r + top; }
      else { nx = 0; ny = 1; depth = r + bottom; }
    }
    var vn = p.vx * nx + p.vy * ny;
    var impact = Math.abs(vn);
    var def = (p.weapon && WEAPONS[p.weapon]) ? WEAPONS[p.weapon] : null;
    var wtype = def ? def.type : 'ball';
    /* 穿透型武器（飞机/芯片/导弹）：命中后不反弹，穿过继续飞 */
    var piercing = (wtype === 'pierce' || wtype === 'chip' || wtype === 'missile');
    if (piercing && p.hitSet && p.hitSet[G.blocks.indexOf(b)]) {
      p.x += nx * 2; p.y += ny * 2;
      return;
    }
    if (!p.hitSet) p.hitSet = {};
    if (impact > 40 || wtype !== 'ball') {
      var dmg = hitDamage(p, impact);
      if (b.kind === 'lion' || b.kind === 'whitehouse') dmg *= 1.3; /* 大 BOSS 怕韭菜 */
      b.hp -= dmg;
      b.flash = 0.12;
      b.wobble = clamp(impact * 0.0006, 0.04, 0.22) * (vn > 0 ? -1 : 1);
      b.vx += nx * impact * 0.3;
      b.vy += ny * impact * 0.3;
      b.awake = true;
      if (impact > 260) G.shake = Math.min(G.shake + impact * 0.0007, 9);
      if (impact > 150) Sound.hit();
      spawnParticles(p.x, p.y, impact > 420 ? '#ffd75e' : '#ffffff', impact > 420 ? 6 : 3, 160, 'circle');
      addText(p.x, p.y - 14, '-' + Math.round(dmg), b.enemy ? '#ffd75e' : '#ffffff', 12);
      if (b.enemy && wtype === 'split') applySlow(b, 1.5);
      /* 武器特殊命中效果 */
      if (wtype === 'bomb') { explode(p.x, p.y, 72, weaponDmg(p.weapon, p.wlv) * 1.5); p.dead = true; }
      else if (wtype === 'nuke') { nuke(p.x, p.y, p.weapon, p.wlv); p.dead = true; }   /* 脉冲弹/超级炸弹大爆炸 */
      else if (wtype === 'rapid') { spawnBulletSpray(p, 7); p.dead = true; }   /* v7：机关枪弹雨 */
      else if (wtype === 'carrier') {                                            /* v7：恒星弹（轨道轰炸）弹头 */
        if (!p.spawned) {
          explode(p.x, p.y, 96, weaponDmg(p.weapon, p.wlv) * 2);
          spawnDrones(p.x, Math.min(p.y, PEAK_Y + 60), 'carrier');
          spawnDrones(p.x, Math.min(p.y, PEAK_Y + 60), 'drone');
          p.spawned = true;
        }
        p.dead = true;
      } else if (wtype === 'split') {
        spawnSplits(p, 3, 'petal', weaponDmg(p.weapon, p.wlv) * 0.6, 170);
        p.dead = true;
      } else if (wtype === 'cluster') {
        spawnSplits(p, 3, 'dumpling', weaponDmg(p.weapon, p.wlv) * 0.5, 190);
        p.dead = true;
      } else if (wtype === 'carrier' || wtype === 'drone') {
        if (!p.spawned) { spawnDrones(p.x, p.y, wtype); p.spawned = true; }
      } else if (wtype === 'chip' && b.enemy) {
        chainRefract(p, b, weaponDmg(p.weapon, p.wlv));
      }
    }
    if (piercing) {
      p.hitSet[G.blocks.indexOf(b)] = true;
      p.x += nx * depth;
      p.y += ny * depth;
      if (b.hp <= 0 && !b.dead) destroyBlock(b);
      return;
    }
    /* 反射 + 阻尼 */
    var rest = 0.45;
    p.vx = (p.vx - (1 + rest) * vn * nx) * 0.45;
    p.vy = (p.vy - (1 + rest) * vn * ny) * 0.45;
    p.spin = vn * 0.0013 * (Math.random() > 0.5 ? 1 : -1);
    p.x += nx * depth;
    p.y += ny * depth;
    if (b.hp <= 0 && !b.dead) destroyBlock(b);
    if (Math.abs(p.vx) < 40 && Math.abs(p.vy) < 40 && p.y + p.r >= GROUND_Y - 2) settleLeek(p);
  }

  function settleLeek(p) {
    if (p.resting || p.fading) return;
    p.resting = true;
    p.vx = 0; p.vy = 0; p.spin = 0;
  }

  /* ====================== 游戏更新 ====================== */
  var acc = 0;
  var FIXED = 1 / 60;

  function update(dt) {
    G.time += dt;
    G.shake = Math.max(0, G.shake - 42 * dt);
    if (G.whiteFlash > 0) G.whiteFlash = Math.max(0, G.whiteFlash - dt * 0.9);
    if (G.reloadPop > 0) G.reloadPop = Math.max(0, G.reloadPop - dt * 3);
    updateParticles(dt);
    updateCoins(dt);
    updateTexts(dt);
    /* 方块 wobble/flash 衰减 */
    for (var i = 0; i < G.blocks.length; i++) {
      var b = G.blocks[i];
      if (b.dead) continue;
      b.wobble *= 0.92;
      if (b.flash > 0) b.flash -= dt;
    }
    if (G.state === 'PLAY') {
      acc += dt;
      if (acc > 0.1) acc = 0.1;
      while (acc > FIXED) {
        stepPhysics(FIXED / 3);
        acc -= FIXED;
      }
      updatePlay(dt);
    } else if (G.state === 'WIN') {
      G.winTimer += dt;
      if (G.winTimer > 0.9 && G.uiButtons.length === 0) buildOverlayButtons(true);
    } else if (G.state === 'LOSE') {
      G.loseTimer += dt;
      if (G.loseTimer > 0.9 && G.uiButtons.length === 0) buildOverlayButtons(false);
    } else if (G.state === 'FINAL') {
      G.finalT += dt;
      updateFinal(dt);
    }
  }

  /* ====================== 通关结局：抓多头牛 → 冲进城堡 → 欢庆胜利放烟花 ====================== */
  function updateFinal(dt) {
    var t = G.finalT;
    /* 烟花节拍：全程零星绽放，冲进城堡后（4s+）加密齐射 */
    G.fwTimer -= dt;
    if (G.fwTimer <= 0) {
      G.fwTimer = t > 4 ? 0.2 : 0.5;
      spawnFirework();
    }
    if (!G.finaleBoom && t > 4.2) {
      G.finaleBoom = true;
      for (var fi = 0; fi < 7; fi++) spawnFirework();
      Sound.cheer();   /* v7.11：冲进城堡 · 烟花高潮 → 人群欢呼 */
    }
    /* 5s 后出现操作按钮 */
    if (t > 5 && G.uiButtons.length === 0) {
      var bw = 210, bh = 54, cx = W / 2, cy = H * 0.62;
      G.uiButtons = [
        makeButton(cx - bw / 2, cy, bw, bh, '再玩一次', 'replay', 'primary'),
        makeButton(cx - bw / 2, cy + bh + 16, bw, bh, '返回菜单', 'menu', 'ghost')
      ];
    }
  }

  /* 一朵烟花：爆心闪光 + 24 颗彩色星火（fw 粒子不落地、随风消散） */
  function spawnFirework() {
    var x = rand(36, W - 36), y = rand(26, 190);
    var cols = ['#ff4d4d', '#ffd75e', '#7ddb8a', '#6ab7ff', '#ff9ae0', '#ffffff', '#ffb347'];
    for (var i = 0; i < 24; i++) {
      var a = (i / 24) * TAU + rand(-0.15, 0.15);
      var sp = rand(70, 175);
      G.particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(20, 60),
        size: rand(2, 4.5),
        life: rand(0.6, 1.15), maxLife: 1.15,
        color: cols[i % cols.length],
        type: 'circle', rot: 0, vr: 0,
        fw: true
      });
    }
    G.particles.push({
      x: x, y: y, vx: 0, vy: 0, size: 12,
      life: 0.12, maxLife: 0.12, color: '#ffffff',
      type: 'circle', rot: 0, vr: 0, fw: true
    });
  }

  function updatePlay(dt) {
    if (G.hintTimer < 6) G.hintTimer += dt;
    /* 特殊弹丸：导弹制导 */
    if (G.activeLeek && G.activeLeek.guided && !G.activeLeek.dead && !G.activeLeek.fading) {
      var gl = G.activeLeek;
      var tgt = strongestEnemy();
      if (tgt) {
        var tx = tgt.x + tgt.w / 2, ty = tgt.y + tgt.h / 2;
        var curSp = Math.sqrt(gl.vx * gl.vx + gl.vy * gl.vy);
        if (curSp > 1) {
          var wantAng = Math.atan2(ty - gl.y, tx - gl.x);
          var curAng = Math.atan2(gl.vy, gl.vx);
          var dAng = wantAng - curAng;
          while (dAng > Math.PI) dAng -= TAU;
          while (dAng < -Math.PI) dAng += TAU;
          var na = curAng + dAng * Math.min(1, dt * 3.2);
          gl.vx = Math.cos(na) * curSp;
          gl.vy = Math.sin(na) * curSp;
          gl.ang = na + Math.PI / 2;
        }
        /* 制导尾焰 */
        if (Math.random() < 0.5) {
          G.particles.push({
            x: gl.x - Math.cos(Math.atan2(gl.vy, gl.vx)) * 14,
            y: gl.y - Math.sin(Math.atan2(gl.vy, gl.vx)) * 14,
            vx: rand(-20, 20), vy: rand(-20, 20),
            size: rand(3, 5), life: 0.35, maxLife: 0.35,
            color: '#ff9a4f', type: 'circle', rot: 0, vr: 0
          });
        }
      }
    }
    /* 无人机/母舰：定时开火 */
    for (var di = G.drones.length - 1; di >= 0; di--) {
      var d = G.drones[di];
      d.t += dt;
      d.x += Math.sin(G.time * 5 + di) * 22 * dt;   /* 悬停漂移 */
      d.y += Math.cos(G.time * 4 + di * 2) * 14 * dt;
      if (d.t >= d.interval) {
        d.t = 0;
        droneFire(d);
      }
      if (d.life <= 0) G.drones.splice(di, 1);
      else d.life -= dt;
    }
    /* 光束特效衰减 */
    for (var bi = G.beams.length - 1; bi >= 0; bi--) {
      G.beams[bi].life -= dt;
      if (G.beams[bi].life <= 0) G.beams.splice(bi, 1);
    }
    /* v7：敌人挥舞镰刀狂叫（所有敌人）+ 激光攻击（被惊动的敌人）
     * 设计：小怪被惊动后只「咔嚓」一发激光；精英/BOSS 周期性发射。 */
    for (var ei = 0; ei < G.blocks.length; ei++) {
      var eb = G.blocks[ei];
      if (eb.dead || !eb.enemy) continue;
      if (G.hp <= 0) continue;
      var eex = eb.x + eb.w / 2, eey = eb.y + eb.h / 2;
      /* 狂叫气泡（一直都在叫嚣） */
      eb.yellT -= dt;
      if (eb.yellT <= 0) {
        eb.yellT = rand(2.4, 4.5);
        var yells = ['嗷呜!', '哇呀呀!', '杀!', '韭菜受死!', '狂怒!'];
        addText(eex, eb.y - 4, yells[Math.floor(Math.random() * yells.length)], '#ffd75e', 11);
      }
      /* 挥镰动画衰减 */
      if (eb.swingT > 0) eb.swingT -= dt;
      /* 刚被惊动（由睡转醒）：重置攻击倒计时，给主角反应时间 */
      if (eb.awake && !eb.everAwake) {
        eb.everAwake = true;
        if (!eb.firedOnce) eb.attackT = rand(2.2, 3.5);
      }
      if (!eb.awake) continue;                             /* 沉睡的敌人不攻击 */
      if (eb.firedOnce && !isBossEnemy(eb)) continue;      /* 小怪只咔嚓一次 */
      eb.attackT -= dt;
      if (eb.attackT <= 0) {
        eb.attackT = isBossEnemy(eb) ? rand(5, 8) : 999;   /* BOSS 周期性，小怪一次性 */
        eb.firedOnce = true;
        G.enemyFire.push({
          x: eex, y: eey,
          tx: SX, ty: SY - LAUNCH_OFF,
          life: 2.4, maxLife: 2.4, speed: 250,
          dmg: 1
        });
        eb.swingT = 0.35;                                  /* 挥镰动画计时 */
        addText(eex, eb.y - 14, '咔嚓!', '#ff8a5a', 13);
        Sound.laser();
      }
    }
    /* v7：推进敌人激光球 → 打中主角扣血 */
    for (var fi = G.enemyFire.length - 1; fi >= 0; fi--) {
      var fb = G.enemyFire[fi];
      fb.life -= dt;
      if (fb.life <= 0) { G.enemyFire.splice(fi, 1); continue; }
      var dxf = fb.tx - fb.x, dyf = fb.ty - fb.y;
      var df = Math.sqrt(dxf * dxf + dyf * dyf);
      if (df < 14) { G.enemyFire.splice(fi, 1); hitPlayer(fb.dmg); continue; }
      fb.x += dxf / df * fb.speed * dt;
      fb.y += dyf / df * fb.speed * dt;
      /* 激光尾迹 */
      if (Math.random() < 0.6) {
        G.particles.push({
          x: fb.x + rand(-3, 3), y: fb.y + rand(-3, 3),
          vx: rand(-16, 16), vy: rand(-16, 16),
          size: rand(2, 4), life: 0.28, maxLife: 0.28,
          color: '#ff5f6e', type: 'circle', rot: 0, vr: 0
        });
      }
    }
    /* 花粉持续伤害 */
    for (var si = 0; si < G.blocks.length; si++) {
      var sb = G.blocks[si];
      if (sb.dead || !sb.slowT) continue;
      sb.slowT -= dt;
      sb.hp -= 5 * dt;
      if (Math.random() < 0.3) {
        G.particles.push({
          x: sb.x + sb.w / 2 + rand(-8, 8), y: sb.y + rand(0, sb.h),
          vx: rand(-10, 10), vy: rand(-30, -10),
          size: rand(2, 4), life: 0.5, maxLife: 0.5,
          color: '#7ddb8a', type: 'circle', rot: 0, vr: 0
        });
      }
      if (sb.hp <= 0) destroyBlock(sb);
    }
    /* 拖拽 */
    if (G.dragging && !G.activeLeek && G.shotsLeft > 0) {
      /* v7.4：愤怒的小鸟式——dragVec 表示"发射方向"，与手指方向相反
       * （手指放在发射点下方/后方 → 弹射向上/前方） */
      var dx = SX - touchState.x;
      var dy = (SY - LAUNCH_OFF) - touchState.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > MAX_DRAG) { dx = dx / len * MAX_DRAG; dy = dy / len * MAX_DRAG; }
      G.dragVec = { x: dx, y: dy };
    }
    /* 飞行中韭菜 */
    if (G.activeLeek) {
      var p = G.activeLeek;
      if (p.dead) { clearActiveLeek(); return; }
      G.flightTimer += dt;
      /* v7.4：直击命中 / 提前展开判定。carrier/恒星弹弹头在 y<PEAK_Y+130 时自动
       释放无人机群（"恒星弹就位！"），之后撞到敌人也不会再触发 explode（保护分支） */
      if (p.weapon === 'nuke' && !p.spawned && p.y < PEAK_Y + 130) {
        spawnDrones(p.x, Math.min(p.y, PEAK_Y + 60), 'carrier');
        spawnDrones(p.x, Math.min(p.y, PEAK_Y + 60), 'drone');
        p.spawned = true;
        addText(p.x, p.y - 20, '恒星弹就位!', '#7dfa9c', 15);
      }
      /* v7：直线弹丸速度过低直接结算（防止无重力垂直弹跳卡死） */
      if (p.noGrav && G.flightTimer > 0.4 && Math.abs(p.vx) + Math.abs(p.vy) < 100) {
        settleLeek(p);
      }
      if (p.resting && !p.fading) {
        G.settleTimer += dt;
        if (G.settleTimer > 0.22) { p.fading = true; }   /* v7.9：落地更快结算（原 0.4s） */
      }
      if (p.fading) {
        p.alpha = (p.alpha || 1) - dt * 5.5;             /* v7.9：淡出更快（原 3.2/s） */
        if (p.alpha <= 0) { clearActiveLeek(); }
      } else if (G.flightTimer > 1.8) {   /* v7.9：打空更快收场（原 3.0s；最远 500px/1080≈0.5s 必达） */
        p.fading = true; p.alpha = 1;
      }
    } else if (G.shotsLeft > 0) {
      /* 弹弓就绪 */
      if (G.settleTimer > 0.25) { Sound.reload(); G.settleTimer = 0; G.reloadPop = 1; }  /* v7.9：装填音效更快（原 0.5s） */
      G.settleTimer = Math.min(G.settleTimer + dt, 0.3);
    } else if (G.enemiesLeft > 0) {
      G.loseTimer += dt;
      if (G.loseTimer > 1.0) { G.state = 'LOSE'; G.loseTimer = 0; G.uiButtons = []; Sound.lose(); }
    }
    /* v7：主角 HP 耗尽 → 失败（被镰刀激光打死） */
    if (G.hp <= 0 && G.enemiesLeft > 0 && G.state === 'PLAY') {
      G.loseTimer += dt;
      if (G.loseTimer > 0.8) { G.state = 'LOSE'; G.loseTimer = 0; G.uiButtons = []; Sound.lose(); }
    }
  }

  function clearActiveLeek() {
    G.activeLeek = null;
    G.flightTimer = 0;
    G.settleTimer = 0;
  }

  /* v7：主角被敌人激光打中 */
  function hitPlayer(dmg) {
    if (G.hp <= 0 || G.state !== 'PLAY') return;
    G.hp -= dmg;
    G.hurtT = 0.5;
    G.shake = Math.min(G.shake + 5, 12);
    addText(SX, SY - LAUNCH_OFF - 34, '被打中了!', '#ff5f4f', 16);
    spawnParticles(SX, SY - LAUNCH_OFF, '#ff8a5a', 10, 170, 'circle');
    Sound.hurt();
    if (G.hp <= 0) {
      G.hp = 0;
      G.loseTimer = 0;   /* 走统一的 LOSE 流程（累计计时后弹结算） */
    }
  }

  function strongestEnemy() {
    var best = null, bestHp = -1;
    for (var i = 0; i < G.blocks.length; i++) {
      var b = G.blocks[i];
      if (b.dead || !b.enemy) continue;
      if (b.hp > bestHp) { bestHp = b.hp; best = b; }
    }
    return best;
  }

  function launchLeek() {
    var v = G.dragVec;
    var len = Math.sqrt(v.x * v.x + v.y * v.y);
    if (len < MIN_DRAG) { G.dragging = false; return; }
    var px = SX, py = SY - LAUNCH_OFF;                    /* v7：山脚武器阵地发射点 */
    var def = WEAPONS[G.weapon] || WEAPONS.stone;
    var dirX = v.x / len, dirY = v.y / len;               /* v7：瞄准方向 = 直线弹道方向 */
    var leek = {
      x: px, y: py,
      vx: dirX * AIM_SPEED, vy: dirY * AIM_SPEED,         /* v7：无重力直线飞行 */
      r: LEEK_R, ang: Math.atan2(dirY, dirX), spin: 0,
      trail: [], resting: false, fading: false, alpha: 1,
      weapon: G.weapon, wlv: weaponLv(G.weapon),
      hitSet: {}, spawned: false, dead: false,
      noGrav: true
    };
    if (def.type === 'pierce') { leek.vx *= 1.22; leek.vy *= 1.22; }        /* 弓弩：利箭高速直射 */
    if (def.type === 'chip') { leek.vx *= 1.5; leek.vy *= 1.5; }            /* 智子：光速直射 */
    if (def.type === 'missile') leek.guided = true;                          /* 导弹：制导 */
    G.projectiles = [leek];
    G.activeLeek = leek;
    G.shotsLeft--;
    G.dragging = false;
    G.dragVec = { x: 0, y: 0 };
    G.settleTimer = 0;
    G.flightTimer = 0;
    G.hintTimer = 0;
    G.minis = [];
    Sound.launch();
  }

  function computeStars() {
    var s = G.shotsLeft >= 2 ? 3 : (G.shotsLeft === 1 ? 2 : 1);
    G.stars = s;
    G.starAnim = [0, 0, 0];
    var best = G.bestStars[G.level] || 0;
    if (s > best) {
      G.bestStars[G.level] = s;
      storageSet('al_stars', G.bestStars);
    }
    if (G.level + 1 > G.unlock && G.level + 1 <= LEVELS.length) {
      G.unlock = G.level + 1;
      storageSet('al_unlock', G.unlock);
    }
    /* v2：通关收益累加（重炮关双倍） */
    var reward = G.score * (G.nukeDouble ? 2 : 1);
    G.money += reward;
    storageSet('al_money', G.money);
    addText(W / 2, H * 0.32, '+' + reward + ' ¥', '#ffd75e', 26);
    /* v7.7：打得好（三星通关）直接奖励解锁下一把武器（无则跳过） */
    if (s >= 3) {
      var nxt = WEAPON_ORDER[G.level + 1];
      if (nxt && G.owned.indexOf(nxt) < 0) {
        G.owned.push(nxt);
        storageSet('al_owned', G.owned);
        addText(W / 2, H * 0.4, '★ 三星奖励：解锁 ' + WEAPONS[nxt].name + '！', '#ffd75e', 17);
      }
    }
  }

  /* ====================== 粒子 / 金币 / 飘字更新 ====================== */
  function updateParticles(dt) {
    for (var i = G.particles.length - 1; i >= 0; i--) {
      var p = G.particles[i];
      p.life -= dt;
      if (p.life <= 0) { G.particles.splice(i, 1); continue; }
      p.vy += 1200 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (!p.fw && p.y > GROUND_Y) { p.y = GROUND_Y; p.vy *= -0.35; p.vx *= 0.6; }
    }
  }

  function updateCoins(dt) {
    var target = { x: W * 0.55, y: 30 };
    for (var i = G.coins.length - 1; i >= 0; i--) {
      var c = G.coins[i];
      c.t += dt;
      c.rot += dt * 6;
      if (c.phase === 'rise') {
        c.vy += 900 * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        if (c.y > GROUND_Y - 8) { c.y = GROUND_Y - 8; c.vy *= -0.4; c.vx *= 0.7; }
        if (c.t > 0.55) { c.phase = 'fly'; c.t = 0; c.sx = c.x; c.sy = c.y; }
      } else {
        var t = easeInOut(clamp(c.t / 0.45, 0, 1));
        c.x = lerp(c.sx, target.x, t);
        c.y = lerp(c.sy, target.y, t);
        if (t >= 1) {
          G.coins.splice(i, 1);
          G.score += c.val || 10;   /* v7：美元价值更高 */
          Sound.coin();
        }
      }
    }
  }

  function updateTexts(dt) {
    for (var i = G.texts.length - 1; i >= 0; i--) {
      var t = G.texts[i];
      t.life -= dt;
      t.y -= 42 * dt;
      if (t.life <= 0) G.texts.splice(i, 1);
    }
  }

  /* ====================== 输入处理 ====================== */
  function handleDown(x, y) {
    G.pressedBtn = null;
    for (var i = G.uiButtons.length - 1; i >= 0; i--) {
      var b = G.uiButtons[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        G.pressedBtn = b;
        break;
      }
    }
    if (G.state === 'PLAY' && !G.activeLeek && G.shotsLeft > 0 && !G.pressedBtn) {
      /* v7.4：弹弓式发射——按住任意位置开始拖拽，dragVec = 发射方向 = 反向手指位置 */
      var dx = SX - x;
      var dy = (SY - LAUNCH_OFF) - y;
      G.dragging = true;
      G.dragVec = { x: dx, y: dy };
      return;
    }
  }

  function handleMove(x, y) {
    if (G.dragging) { /* 拖拽向量在 updatePlay 中按 touchState 计算 */ }
    /* 按下的按钮若已拖出按钮范围，取消本次点击（防误触） */
    if (G.pressedBtn && !G.dragging) {
      var pb = G.pressedBtn;
      if (x < pb.x - 12 || x > pb.x + pb.w + 12 || y < pb.y - 12 || y > pb.y + pb.h + 12) {
        G.pressedBtn = null;
      }
    }
  }

  function handleUp(x, y) {
    if (G.dragging) { G.dragging = false; launchLeek(); return; }
    /* 松开时的坐标不可靠（微信 onTouchEnd / 浏览器 mouseup 均传 0,0），
     * 因此直接触发按下时命中的按钮，不再依赖松开坐标做命中检测。 */
    var b = G.pressedBtn;
    G.pressedBtn = null;
    if (b) triggerButton(b.action);
  }

  /* ====================== 按钮 ====================== */
  function makeButton(x, y, w, h, label, action, style) {
    return { x: x, y: y, w: w, h: h, label: label, action: action, style: style || 'primary' };
  }

  function triggerButton(action) {
    if (action === 'start') {
      startLevel(firstUnfinished());
    } else if (action === 'restart') {
      startLevel(G.level);
    } else if (action === 'menu') {
      G.state = 'MENU';
      G.uiButtons = [];
    } else if (action === 'genderMale') {
      G.gender = 'male';
      storageSet('al_gender', 'male');
      Sound.coin();
    } else if (action === 'genderFemale') {
      G.gender = 'female';
      storageSet('al_gender', 'female');
      Sound.coin();
    } else if (action === 'avatar') {
      /* v7.4：换头像——微信选相册，浏览器弹出文件选择（压缩到 256×256 JPEG 持久化） */
      if (IS_WX && typeof wx.chooseMedia === 'function') {
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          success: function (res) {
            var tmp = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
            if (tmp) { setAvatar(tmp); addText(W / 2, H * 0.55, '头像已更新！', '#8ef07a', 18); }
          }
        });
      } else if (typeof document !== 'undefined' && document.createElement) {
        /* 浏览器：点击触发隐藏的 <input type=file> */
        var inp = document.getElementById('alAvatarInput');
        if (!inp) {
          inp = document.createElement('input');
          inp.type = 'file';
          inp.accept = 'image/*';
          inp.id = 'alAvatarInput';
          inp.style.display = 'none';
          document.body.appendChild(inp);
          inp.addEventListener('change', function () {
            var f = inp.files && inp.files[0];
            inp.value = '';
            if (!f) return;
            var rd = new FileReader();
            rd.onload = function () {
              /* 压缩到 256×256 JPEG（保持方形 cover），缩小 dataURL 体积以持久化到 localStorage */
              var im = new Image();
              im.onload = function () {
                try {
                  var c = document.createElement('canvas');
                  c.width = 256; c.height = 256;
                  var cx2 = c.getContext('2d');
                  var s = Math.min(im.width, im.height);
                  cx2.drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, 256, 256);
                  var dataUrl = c.toDataURL('image/jpeg', 0.85);
                  setAvatar(dataUrl);
                  addText(W / 2, H * 0.55, '头像已更新！', '#8ef07a', 18);
                } catch (e) { addText(W / 2, H * 0.55, '头像处理失败', '#ff5f4f', 18); }
              };
              im.onerror = function () { addText(W / 2, H * 0.55, '图片读取失败', '#ff5f4f', 18); };
              im.src = rd.result;
            };
            rd.onerror = function () { addText(W / 2, H * 0.55, '文件读取失败', '#ff5f4f', 18); };
            rd.readAsDataURL(f);
          });
        }
        inp.click();
      } else {
        /* 兜底：浏览器无 document（极少见）——粘 URL */
        var avUrl = prompt('粘贴头像图片地址（URL）：\n（留空 = 恢复默认）');
        if (avUrl && avUrl.trim()) {
          setAvatar(avUrl.trim());
          addText(W / 2, H * 0.55, '头像已更新！', '#8ef07a', 18);
        } else if (avUrl !== null) {
          setAvatar('');
          addText(W / 2, H * 0.55, '已恢复默认头像', '#ffd75e', 18);
        }
      }
    } else if (action === 'resetAll') {
      /* v7.9：重置——点击后弹出确认弹窗（提示将重置积分/头像/武器），确定后才执行 */
      G.resetModal = true;
      G.uiButtons = [];
    } else if (action === 'resetConfirm') {
      /* 玩家点了「确定重置」→ 真正清空全部存档 */
      try {
        if (IS_WX && typeof wx.clearStorageSync === 'function') wx.clearStorageSync();
        else if (typeof localStorage !== 'undefined') localStorage.clear();
      } catch (e) { /* ignore */ }
      G.money = 0;
      G.owned = ['stone'];
      G.weapon = 'stone';
      G.weaponLv = {};
      G.unlock = 1;
      G.bestStars = {};
      G.gender = 'male';
      G.muted = false;
      Sound.muted = false;
      setAvatar('');      /* 清头像（内部同步清 IMG['avatar'] + CUSTOM_AVATAR_ACTIVE） */
      G.resetModal = false;
      G.state = 'MENU';
      G.uiButtons = [];
      Sound.coin();
      addText(W / 2, H * 0.42, '✅ 已全部重置，全新开局！积分清零、回到第 1 关', '#8ef07a', 16);
    } else if (action === 'resetCancel') {
      /* 玩家点了「取消」→ 关闭弹窗，什么都不做 */
      G.resetModal = false;
      G.uiButtons = [];
    } else if (action === 'shop') {
      G.state = 'SHOP';
      G.uiButtons = [];
    } else if (action === 'shopClose') {
      G.state = 'MENU';
      G.uiButtons = [];
    } else if (action === 'next') {
      startLevel(G.level + 1);
    } else if (action === 'replay') {
      startLevel(G.level);
    } else if (action === 'mute') {
      Sound.muted = !Sound.muted;
      G.muted = Sound.muted;
      storageSet('al_muted', G.muted);
    } else if (action.indexOf('buy_') === 0) {
      /* v7.7：积分兑换武器——花费积分把武器加入 owned 并自动装备 */
      var bid = action.slice(4);
      var bdef = WEAPONS[bid];
      if (bdef && G.owned.indexOf(bid) < 0) {
        var bcost = bdef.cost;
        if (G.money >= bcost) {
          G.money -= bcost;
          G.owned.push(bid);
          storageSet('al_money', G.money);
          storageSet('al_owned', G.owned);
          G.weapon = bid;
          storageSet('al_weapon', G.weapon);
          Sound.coin();
          addText(W / 2, H * 0.3, '兑换成功：' + bdef.name + '！', '#8ef07a', 20);
        } else {
          addText(W / 2, H * 0.3, '积分不足，再打几关赚积分！', '#ff8a70', 18);
        }
      }
    } else if (action.indexOf('sel_') === 0) {
      var wid = action.slice(4);
      if (isUnlocked(wid)) {
        G.weapon = wid;
        storageSet('al_weapon', G.weapon);
        Sound.coin();
      }
    } else if (action.indexOf('up_') === 0) {
      var uid = action.slice(3);
      if (isUnlocked(uid)) {
        var lv = weaponLv(uid);
        if (lv < LV_MAX) {
          var cost = LV_COST[lv];
          if (G.money >= cost) {
            G.money -= cost;
            G.weaponLv[uid] = lv + 1;
            storageSet('al_wlv', G.weaponLv);
            storageSet('al_money', G.money);
            Sound.coin();
            addText(W / 2, H * 0.3, WEAPONS[uid].name + ' 升到 Lv' + (lv + 1) + '！', '#8ef07a', 20);
          } else {
            addText(W / 2, H * 0.3, '收益不足！', '#ff8a70', 18);
          }
        }
      }
    } else if (action.indexOf('level') === 0) {
      var idx = parseInt(action.slice(5), 10);
      if (idx < G.unlock) startLevel(idx);
    }
  }

  function firstUnfinished() {
    /* v7.5：「开始游戏」永远从第 1 关开始（用户明确要求；选关用菜单圆点） */
    return 0;
  }

  function buildOverlayButtons(win) {
    var bw = 210, bh = 54;
    var cx = W / 2;
    var cy = H * 0.62;
    var list = [];
    if (win) {
      if (!G.isLast) {
        list.push(makeButton(cx - bw / 2, cy, bw, bh, '下一关', 'next', 'primary'));
        list.push(makeButton(cx - bw / 2, cy + bh + 16, bw, bh, '返回菜单', 'menu', 'ghost'));
      } else {
        list.push(makeButton(cx - bw / 2, cy, bw, bh, '再玩一次', 'replay', 'primary'));
        list.push(makeButton(cx - bw / 2, cy + bh + 16, bw, bh, '返回菜单', 'menu', 'ghost'));
      }
    } else {
      list.push(makeButton(cx - bw / 2, cy, bw, bh, '重试', 'restart', 'primary'));
      list.push(makeButton(cx - bw / 2, cy + bh + 16, bw, bh, '返回菜单', 'menu', 'ghost'));
    }
    G.uiButtons = list;
  }

  /* ====================== 渲染：基础 ====================== */
  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function ellipse(x, y, rx, ry) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, TAU);
    ctx.restore();
  }

  /* 带旋转的椭圆（微信小游戏不支持 ctx.ellipse，用 scale+arc 实现） */
  function lellipse(x, y, rx, ry, rot) {
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    ctx.scale(1, ry / rx);
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, TAU);
    ctx.restore();
  }

  /* ====================== 渲染：背景（v4 山体战场，程序化绘制） ====================== */
  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#4aa3e8');
    g.addColorStop(0.35, '#8ed0f5');
    g.addColorStop(0.62, '#d5f0e8');
    g.addColorStop(1, '#ffedc4');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    /* 太阳：光晕 + 光芒 + 本体 */
    var sx = W * 0.82, sy = H * 0.13;
    var sg = ctx.createRadialGradient(sx, sy, 8, sx, sy, 90);
    sg.addColorStop(0, 'rgba(255,248,214,0.98)');
    sg.addColorStop(0.3, 'rgba(255,232,150,0.6)');
    sg.addColorStop(1, 'rgba(255,232,150,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(sx - 90, sy - 90, 180, 180);
    /* 光芒射线 */
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(G.time * 0.06);
    for (var ri = 0; ri < 10; ri++) {
      ctx.rotate(TAU / 10);
      ctx.fillStyle = 'rgba(255,240,180,0.18)';
      ctx.beginPath();
      ctx.moveTo(26, -4);
      ctx.lineTo(52, -1.6);
      ctx.lineTo(52, 1.6);
      ctx.lineTo(26, 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#fff6cf';
    ctx.beginPath(); ctx.arc(sx, sy, 26, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.arc(sx - 7, sy - 7, 8, 0, TAU); ctx.fill();
    /* 云（立体双层） */
    drawCloud(W * 0.16, H * 0.2, 1);
    drawCloud(W * 0.63, H * 0.28, 0.8);
    drawCloud(W * 0.4, H * 0.12, 0.55);
    drawCloud(W * 0.85, H * 0.38, 0.65);
    /* 漂浮光尘 */
    for (var i = 0; i < 12; i++) {
      var ddx = (hash01(i * 7.7) * W + G.time * (6 + hash01(i) * 12)) % W;
      var ddy = H * 0.1 + ((hash01(i * 3.3) * 320 + Math.sin(G.time * 0.7 + i * 2.1) * 22 + H * 0.35) % 360);
      var da = 0.12 + 0.1 * Math.sin(G.time * 1.5 + i * 1.3);
      ctx.fillStyle = 'rgba(255,255,240,' + da + ')';
      ctx.beginPath(); ctx.arc(ddx, ddy, 1.5 + hash01(i * 5.5) * 1.6, 0, TAU); ctx.fill();
    }
  }

  function drawCloud(x, y, s) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(x, y, 18 * s, 0, TAU);
    ctx.arc(x + 20 * s, y - 8 * s, 14 * s, 0, TAU);
    ctx.arc(x + 38 * s, y, 16 * s, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(x - 6 * s, y + 10 * s, 12 * s, 0, TAU);
    ctx.arc(x + 24 * s, y + 12 * s, 10 * s, 0, TAU);
    ctx.fill();
  }

  /* ====================== 渲染：山体战场（v4 自下而上打上山顶） ======================
   * 山脚 = 绿油油的韭菜地（弹弓中置），梯田一层层升高，
   * 关卡越高敌人站得越高，山顶平台就是城堡。 */
  function drawGround(showHouse) {
    if (showHouse === undefined) showHouse = true;
    var cx = W / 2;
    /* ===== 山脚：韭菜地（一排排绿油油的韭菜） ===== */
    var g = ctx.createLinearGradient(0, GROUND_Y - 10, 0, H);
    g.addColorStop(0, '#7ed25a');
    g.addColorStop(0.25, '#57a83f');
    g.addColorStop(0.6, '#428f33');
    g.addColorStop(1, '#2f6e24');
    ctx.fillStyle = g;
    rr(0, GROUND_Y - 10, W, H - GROUND_Y + 10, 12);
    ctx.fill();
    /* 泥土带 */
    ctx.fillStyle = '#8a5a33';
    ctx.fillRect(0, GROUND_Y + 24, W, H - GROUND_Y - 24);
    /* 韭菜地：v7.4 加密度 5 排 × 12 株，均匀分布（每株 3 根细长叶）。扰动仅 4px */
    for (var row = 0; row < 5; row++) {
      var ry = GROUND_Y + 6 + row * 22;
      for (var pi = 0; pi < 12; pi++) {
        var px = 18 + pi * ((W - 36) / 11) + hash01(pi * 3 + row * 7) * 4;
        ctx.strokeStyle = row % 2 === 0 ? '#3f9b30' : '#4aae3c';
        ctx.lineWidth = 2;
        for (var leaf = 0; leaf < 3; leaf++) {
          ctx.beginPath();
          ctx.moveTo(px, ry + 6);
          ctx.quadraticCurveTo(px + (leaf - 1) * 5, ry - 9, px + (leaf - 1) * 8 - 3, ry - 17 - hash01(leaf * 7 + row) * 5);
          ctx.stroke();
        }
      }
    }
    /* ===== 山脚两侧土坡（把山体与韭菜地衔接起来） ===== */
    ctx.fillStyle = '#4a9638';
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(cx - TERRACE_HALF[0] - 4, GROUND_Y);
    ctx.lineTo(cx - TERRACE_HALF[0] - 4, GROUND_Y - 46);
    ctx.lineTo(0, GROUND_Y - 76);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(W, GROUND_Y);
    ctx.lineTo(cx + TERRACE_HALF[0] + 4, GROUND_Y);
    ctx.lineTo(cx + TERRACE_HALF[0] + 4, GROUND_Y - 46);
    ctx.lineTo(W, GROUND_Y - 76);
    ctx.closePath(); ctx.fill();
    /* ===== 山顶平台（城堡所在地） ===== */
    var platHw = 44;
    ctx.fillStyle = '#3f8f2e';
    rr(cx - platHw, PEAK_Y, platHw * 2, TERRACE_TOPS[5] - PEAK_Y, 6);
    ctx.fill();
    /* 城堡（决战空头熊后，抓住多头牛冲进去） */
    if (showHouse) drawPeakHouse(G.state === 'FINAL' && G.finalT > 3.4);
    /* v7.3：城堡受击闪白（弹头命中时整栋建筑闪白光） */
    if (showHouse && G.whiteFlash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (G.whiteFlash * 0.55).toFixed(3) + ')';
      rr(cx - 46, PEAK_Y - 48, 92, 50, 4);
      ctx.fill();
    }
    /* ===== 梯田山体（从高到低逐级叠高） ===== */
    for (var k = TERRACE_HALF.length - 1; k >= 0; k--) {
      var topY = TERRACE_TOPS[k];
      /* v7.8：最低一层台面底部抬离地面 46px——山体与山脚韭菜地之间留出黄土空隙，
       * 弹弓居中插在黄土上，与梯田明显拉开距离（视觉"离梯田远一点"） */
      var bottomY = k === 0 ? GROUND_Y - 46 : TERRACE_TOPS[k - 1];
      var hw = TERRACE_HALF[k];
      var tg = ctx.createLinearGradient(0, topY, 0, bottomY);
      tg.addColorStop(0, '#6fcf54');
      tg.addColorStop(0.35, '#4da83c');
      tg.addColorStop(1, '#35792b');
      ctx.fillStyle = tg;
      rr(cx - hw, topY, hw * 2, bottomY - topY, 8);
      ctx.fill();
      /* 台面草皮亮边 */
      ctx.fillStyle = 'rgba(190,255,150,0.35)';
      rr(cx - hw + 3, topY + 2, hw * 2 - 6, 6, 3);
      ctx.fill();
      /* 右侧阴影，增加立体感 */
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      rr(cx + hw - 14, topY + 6, 14, bottomY - topY - 6, 6);
      ctx.fill();
      /* 台面边缘小草 */
      ctx.strokeStyle = 'rgba(70,150,60,0.8)';
      ctx.lineWidth = 1.4;
      for (var gi = 0; gi < 5; gi++) {
        var gx = cx - hw + 12 + gi * ((hw * 2 - 24) / 5) + hash01(gi + k) * 6;
        ctx.beginPath();
        ctx.moveTo(gx, topY + 2);
        ctx.quadraticCurveTo(gx - 2, topY - 5, gx - 4, topY - 9);
        ctx.stroke();
      }
    }
    /* v7.8：山体底部（悬空 46px）画投影阴影，让"黄土空隙"更真实 */
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    rr(cx - TERRACE_HALF[0] + 6, GROUND_Y - 46, TERRACE_HALF[0] * 2 - 12, 5, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    rr(cx - TERRACE_HALF[0] + 10, GROUND_Y - 40, TERRACE_HALF[0] * 2 - 20, 4, 3);
    ctx.fill();
  }

  /* 山顶城堡（v7：美式纯白——白墙白顶三角楣 + 门廊柱 + 女儿墙，红旗无 logo） */
  function drawPeakHouse(glow) {
    var cx = W / 2, baseY = PEAK_Y;
    /* 台基 */
    ctx.fillStyle = '#e6e2d8';
    rr(cx - 44, baseY - 8, 88, 8, 2);
    ctx.fill();
    /* 两翼（左右矮楼：白墙 + 翼窗） */
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var wx2 = cx + sgn * 27, ww = 18, wh = 24;
      var wg = ctx.createLinearGradient(wx2 - ww, 0, wx2 + ww, 0);
      wg.addColorStop(0, '#e3ded2');
      wg.addColorStop(0.5, '#f8f5ee');
      wg.addColorStop(1, '#d8d2c4');
      ctx.fillStyle = wg;
      rr(wx2 - ww / 2, baseY - wh, ww, wh, 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,115,100,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = glow ? '#ffe9a8' : '#bfe3ff';
      ctx.fillRect(wx2 - 3.5, baseY - wh + 6, 7, 9);
    }
    /* 中央主体（纯白墙） */
    var cw = 40, ch = 30;
    var cg = ctx.createLinearGradient(cx - cw, 0, cx + cw, 0);
    cg.addColorStop(0, '#e6e1d5');
    cg.addColorStop(0.5, '#fbf8f1');
    cg.addColorStop(1, '#dad4c6');
    ctx.fillStyle = cg;
    rr(cx - cw / 2, baseY - ch, cw, ch, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,115,100,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    /* 中央窗（胜利时金光） */
    ctx.fillStyle = glow ? '#ffe9a8' : '#bfe3ff';
    ctx.fillRect(cx - 8, baseY - ch + 5, 7, 9);
    ctx.fillRect(cx + 1, baseY - ch + 5, 7, 9);
    /* 三角楣（pediment：主体上方的白色山花） */
    var pTop = baseY - ch - 16;
    var pG = ctx.createLinearGradient(cx - 23, 0, cx + 23, 0);
    pG.addColorStop(0, '#e9e4d9');
    pG.addColorStop(0.5, '#fdfaf3');
    pG.addColorStop(1, '#dcd6c8');
    ctx.fillStyle = pG;
    ctx.beginPath();
    ctx.moveTo(cx - 23, baseY - ch);
    ctx.lineTo(cx, pTop);
    ctx.lineTo(cx + 23, baseY - ch);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,115,100,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    /* 门廊柱（4 根白色圆柱，撑起三角楣） */
    for (var c2 = 0; c2 < 4; c2++) {
      var px = cx - 12 + c2 * 8;
      var colG = ctx.createLinearGradient(px, 0, px + 4.5, 0);
      colG.addColorStop(0, '#d9d3c5');
      colG.addColorStop(0.5, '#faf7f0');
      colG.addColorStop(1, '#cfc8ba');
      ctx.fillStyle = colG;
      ctx.fillRect(px, baseY - 22, 4.5, 22);
      ctx.strokeStyle = 'rgba(120,115,100,0.4)';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(px, baseY - 22, 4.5, 22);
    }
    /* 正门 */
    ctx.fillStyle = '#5a4632';
    ctx.fillRect(cx - 5, baseY - 15, 10, 15);
    /* 女儿墙（balustrade：屋顶上一排小立柱） */
    ctx.fillStyle = '#efeae0';
    for (var b2 = 0; b2 < 7; b2++) {
      ctx.fillRect(cx - 17 + b2 * 5.6, pTop - 5, 2.8, 5);
    }
    ctx.fillStyle = '#f5f2ea';
    rr(cx - 19, pTop - 6, 38, 2, 1);
    ctx.fill();
    /* 旗杆 + 纯红旗（无 logo） */
    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + 22, pTop - 1);
    ctx.lineTo(cx + 22, pTop - 21);
    ctx.stroke();
    var wave = Math.sin(G.time * 4) * 2;
    ctx.fillStyle = '#e03131';
    ctx.beginPath();
    ctx.moveTo(cx + 22, pTop - 21);
    ctx.quadraticCurveTo(cx + 34, pTop - 19 + wave, cx + 44, pTop - 17 + wave);
    ctx.lineTo(cx + 44, pTop - 10 + wave);
    ctx.quadraticCurveTo(cx + 32, pTop - 12, cx + 22, pTop - 11);
    ctx.closePath();
    ctx.fill();
  }

  /* ====================== 渲染：山脚武器阵地（v7.6：经典 Y 型木弹弓，回归第一版） ====================== */
  function drawSlingshot(loadedPos) {
    var bx = SX, by = GROUND_Y;
    var topY = SY - LAUNCH_OFF;
    /* 装载点（主角/弹兜位置）：PLAY 时=手指位置，未拖拽=发射点；菜单=叉下默认位 */
    var lp = loadedPos || { x: bx, y: topY + 6 };
    /* Y 叉几何（v7.7：分叉更宽 ±46、分叉点更低，弹弓整体矮壮） */
    var rootY = topY + 42;
    var fL = { x: bx - 46, y: topY - 20 };
    var fR = { x: bx + 46, y: topY - 20 };
    /* 阴影 */
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    lellipse(bx + 3, by + 3, 34, 5, 0);
    ctx.fill();
    ctx.lineCap = 'round';
    /* —— 木质主干 + Y 叉（第一版经典弹弓：底部插入黄土、上端宽分叉） —— */
    ctx.strokeStyle = '#8a5a33';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(bx, by + 14);       /* 主干插入黄土（向下延伸 14px） */
    ctx.lineTo(bx, rootY);
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(bx, rootY);
    ctx.lineTo(fL.x, fL.y);
    ctx.moveTo(bx, rootY);
    ctx.lineTo(fR.x, fR.y);
    ctx.stroke();
    /* 木纹高光 */
    ctx.strokeStyle = 'rgba(255,215,160,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx + 2, by + 14);
    ctx.lineTo(bx + 2, rootY - 2);
    ctx.moveTo(bx - 5, rootY + 6);
    ctx.lineTo(fL.x + 4, fL.y + 1);
    ctx.moveTo(bx + 5, rootY + 6);
    ctx.lineTo(fR.x - 4, fR.y + 1);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(60,30,10,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx - 2, by + 14);
    ctx.lineTo(bx - 2, rootY - 2);
    ctx.stroke();
    /* 叉尖球（防皮筋滑脱） */
    ctx.fillStyle = '#6b3f1e';
    ctx.strokeStyle = '#4a2a12';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(fL.x, fL.y, 5, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(fR.x, fR.y, 5, 0, TAU); ctx.fill(); ctx.stroke();
    /* 主干根部土堆（弹弓插在黄土里的视觉：根部堆一圈土） */
    ctx.fillStyle = 'rgba(122,74,38,0.85)';
    lellipse(bx, by + 12, 22, 9, 0);
    ctx.fill();
    ctx.fillStyle = 'rgba(158,98,52,0.6)';
    lellipse(bx - 4, by + 9, 12, 4, 0);
    ctx.fill();
    /* —— 皮筋：装载点 → 左右叉尖（拖拽时跟随拉伸） —— */
    ctx.strokeStyle = 'rgba(150,52,36,0.95)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(lp.x, lp.y); ctx.lineTo(fL.x, fL.y);
    ctx.moveTo(lp.x, lp.y); ctx.lineTo(fR.x, fR.y);
    ctx.stroke();
    /* 皮筋高光 */
    ctx.strokeStyle = 'rgba(255,190,160,0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(lp.x + 1, lp.y + 1); ctx.lineTo(fL.x + 1, fL.y + 1);
    ctx.moveTo(lp.x + 1, lp.y + 1); ctx.lineTo(fR.x + 1, fR.y + 1);
    ctx.stroke();
    /* —— 弹兜（装载点衬垫，PLAY 装填时） —— */
    if (G.state === 'PLAY' && !G.activeLeek && G.shotsLeft > 0) {
      ctx.fillStyle = 'rgba(96,56,28,0.92)';
      ctx.strokeStyle = 'rgba(50,26,10,0.8)';
      ctx.lineWidth = 1.5;
      lellipse(lp.x, lp.y + 4, 10, 5, 0);
      ctx.fill(); ctx.stroke();
    }
    /* 就绪提示圈 */
    if (G.state === 'PLAY' && !G.activeLeek && G.shotsLeft > 0) {
      var pulse = 0.5 + 0.5 * Math.sin(G.time * 4);
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.25 + pulse * 0.3) + ')';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(bx, topY, 46 + pulse * 6, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + (0.06 + pulse * 0.08) + ')';
      ctx.beginPath();
      ctx.arc(bx, topY, 34 + pulse * 4, 0, TAU);
      ctx.fill();
    }
  }

  /* v7：武器 id → 素材 key（与 IMG_DEF 映射一致） */
  function imgKeyOfWeapon(id) {
    var map = { stone: 'stone', knife: 'knife', grenade: 'grenade', gun: 'gun', cannon: 'cannon', nuke: 'nuke' };
    return map[id] || null;
  }

  /* ====================== 渲染：韭菜主角（v2 重绘） ======================
   * 夸张造型：大头圆身 + 头顶一大丛绿油油韭菜叶 / 女性开花；
   * 时代外观：冷兵器人形 → 热兵器背炮弹 → 现代战争机翼 → 重火力导弹 → 智能智子。
   */
  /* v5 圆形大头：默认用大头特写素材（表情清晰），可换成玩家自定义头像。
   * forced：'male'/'female' 强制用某性别默认头（菜单双卡并列时用） */
  function drawHeadFace(R, forced) {
    var cy = -R * 0.43;
    var img = null;
    if (IMG['avatar'] && IMG['avatar'].width > 0) img = IMG['avatar'];
    else if (forced === 'female') img = IMG['heroFemaleHead'];
    else if (forced === 'male') img = IMG['heroMaleHead'];
    else img = (G.gender === 'female') ? IMG['heroFemaleHead'] : IMG['heroMaleHead'];
    ctx.save();
    ctx.beginPath(); ctx.arc(0, cy, R, 0, TAU); ctx.clip();
    if (img && img.width > 0) {
      /* cover：取源图居中正方形（略偏上取脸），撑满圆 */
      var s = Math.min(img.width, img.height);
      var sx = (img.width - s) / 2;
      var sy = (img.height - s) * 0.18;
      ctx.drawImage(img, sx, sy, s, s, -R, cy - R, R * 2, R * 2);
    } else {
      /* 兜底：绿色圆脸 + 简单表情 */
      var grad = ctx.createRadialGradient(-R * 0.3, cy - R * 0.35, R * 0.2, 0, cy, R * 1.15);
      grad.addColorStop(0, '#7ed957');
      grad.addColorStop(1, '#2c7a30');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(0, cy, R, 0, TAU); ctx.fill();
      ctx.fillStyle = '#20242c';
      ctx.beginPath(); ctx.arc(-R * 0.32, cy + R * 0.05, R * 0.09, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(R * 0.32, cy + R * 0.05, R * 0.09, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#1c2a20';
      ctx.lineWidth = Math.max(1.5, R * 0.08);
      ctx.beginPath();
      ctx.moveTo(-R * 0.5, cy - R * 0.32); ctx.lineTo(-R * 0.12, cy - R * 0.14);
      ctx.moveTo(R * 0.5, cy - R * 0.32); ctx.lineTo(R * 0.12, cy - R * 0.14);
      ctx.stroke();
    }
    ctx.restore();
    /* 描边 + 高光 */
    ctx.strokeStyle = 'rgba(30,80,35,0.65)';
    ctx.lineWidth = Math.max(1.5, R * 0.09);
    ctx.beginPath(); ctx.arc(0, cy, R, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    lellipse(-R * 0.35, cy - R * 0.45, R * 0.22, R * 0.13, -0.6);
    ctx.fill();
  }

  /* v5 小手（手套）：从两侧握住武器 */
  function drawHand(x, y, R, tilt) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    var hg = ctx.createRadialGradient(-R * 0.2, -R * 0.25, R * 0.15, 0, 0, R * 1.1);
    hg.addColorStop(0, '#f4fce8');
    hg.addColorStop(1, '#b8d494');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(70,110,60,0.55)';
    ctx.lineWidth = Math.max(1, R * 0.12);
    ctx.stroke();
    /* 指节线 */
    ctx.strokeStyle = 'rgba(120,160,100,0.45)';
    ctx.lineWidth = Math.max(1, R * 0.1);
    ctx.beginPath();
    ctx.moveTo(-R * 0.28, -R * 0.35); ctx.lineTo(-R * 0.28, R * 0.3);
    ctx.moveTo(R * 0.05, -R * 0.4); ctx.lineTo(R * 0.05, R * 0.32);
    ctx.moveTo(R * 0.38, -R * 0.32); ctx.lineTo(R * 0.38, R * 0.22);
    ctx.stroke();
    ctx.restore();
  }

  /* ====================== v7.5 弹丸造型：每把武器独立 Canvas 精绘 ======================
   * 弹丸 = 武器本体 + 愤怒韭菜脸点睛（保持主角感）。
   *    stone   石头    → 灰色圆石
   *    knife   炸弹    → 扫雷黑地雷（红色引线+火花）
   *    grenade 火箭弹  → 红白箭体+尾翼+动态尾焰
   *    gun     超级炸弹  → 超级炸弹（瘦长弹体+尾翼+黄黑警示带）
   *    cannon  脉冲弹  → 能量核心+旋转电磁环
   *    nuke    恒星弹  → 火太阳（旋转光芒+火焰球）
   * 所有绘制以 (0,0) 为中心、r 为基准半径，调用前已 translate/rotate。 */
  function ammoFace(r, cx, cy, s) {
    /* 愤怒韭菜脸：白眼+黑瞳+倒八字怒眉+龇牙（s=缩放） */
    ctx.fillStyle = '#ffffff';
    lellipse(cx - r * 0.3 * s, cy - r * 0.02 * s, r * 0.2 * s, r * 0.22 * s, 0); ctx.fill();
    lellipse(cx + r * 0.3 * s, cy - r * 0.02 * s, r * 0.2 * s, r * 0.22 * s, 0); ctx.fill();
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(cx - r * 0.28 * s, cy + r * 0.02 * s, r * 0.085 * s, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.32 * s, cy + r * 0.02 * s, r * 0.085 * s, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(cx - r * 0.31 * s, cy - r * 0.05 * s, r * 0.028 * s, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.29 * s, cy - r * 0.05 * s, r * 0.028 * s, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#1c2a20';
    ctx.lineWidth = Math.max(1.2, r * 0.09 * s);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.52 * s, cy - r * 0.36 * s); ctx.lineTo(cx - r * 0.12 * s, cy - r * 0.16 * s);
    ctx.moveTo(cx + r * 0.52 * s, cy - r * 0.36 * s); ctx.lineTo(cx + r * 0.12 * s, cy - r * 0.16 * s);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1c2a20';
    ctx.lineWidth = Math.max(0.8, r * 0.05 * s);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.18 * s, cy + r * 0.3 * s);
    ctx.quadraticCurveTo(cx, cy + r * 0.48 * s, cx + r * 0.18 * s, cy + r * 0.3 * s);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  /* ① 石头：灰色圆石 + 裂纹 + 愤怒脸 */
  function drawAmmoStone(r) {
    var g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r * 1.05);
    g.addColorStop(0, '#d7dde2');
    g.addColorStop(0.55, '#98a2ad');
    g.addColorStop(1, '#525c66');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.98, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(30,40,50,0.6)';
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(45,55,65,0.45)';
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.beginPath();
    ctx.moveTo(-r * 0.55, -r * 0.3); ctx.lineTo(-r * 0.28, -r * 0.05); ctx.lineTo(-r * 0.42, r * 0.38);
    ctx.moveTo(r * 0.42, -r * 0.42); ctx.lineTo(r * 0.68, -r * 0.18);
    ctx.moveTo(-r * 0.1, r * 0.6); ctx.lineTo(r * 0.18, r * 0.78);
    ctx.stroke();
    ammoFace(r, 0, 0, 1);
    /* 头顶小绿叶 */
    ctx.strokeStyle = '#3f9b30';
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.85);
    ctx.quadraticCurveTo(-r * 0.05, -r * 1.2, -r * 0.22, -r * 1.35);
    ctx.moveTo(0, -r * 0.85);
    ctx.quadraticCurveTo(r * 0.08, -r * 1.22, r * 0.25, -r * 1.3);
    ctx.stroke();
  }

  /* ② 炸弹：扫雷黑地雷（黑色圆球 + 顶部红色引线 + 火花 + 底部圆环底座） */
  function drawAmmoMine(r) {
    var g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.12, 0, 0, r * 1.0);
    g.addColorStop(0, '#4c515a');
    g.addColorStop(0.5, '#262a30');
    g.addColorStop(1, '#0b0d10');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.95, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.stroke();
    /* 高光 */
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    lellipse(-r * 0.32, -r * 0.42, r * 0.26, r * 0.14, -0.6); ctx.fill();
    /* 顶部插销（红色引线） */
    ctx.strokeStyle = '#e03a2f';
    ctx.lineWidth = Math.max(2, r * 0.13);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.85);
    ctx.quadraticCurveTo(r * 0.14, -r * 1.25, -r * 0.05, -r * 1.52);
    ctx.stroke();
    /* 引线火花（闪烁） */
    var sp = 0.65 + 0.35 * Math.sin(G.time * 18);
    ctx.fillStyle = 'rgba(255,210,90,' + sp.toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(-r * 0.05, -r * 1.58, r * 0.15, 0, TAU); ctx.fill();
    /* 底部圆环底座 */
    ctx.fillStyle = '#3a3f46';
    lellipse(0, r * 0.78, r * 0.62, r * 0.26, 0); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
    /* 愤怒脸（黑球上显白） */
    ammoFace(r, 0, 0, 0.92);
  }

  /* ③ 火箭弹：红白箭体 + 红色锥头 + 尾翼 + 动态尾焰 */
  function drawAmmoRocket(r) {
    /* 尾焰（动态伸缩） */
    var fl = 0.7 + 0.3 * Math.sin(G.time * 30);
    var fg = ctx.createLinearGradient(0, r * 0.8, 0, r * 2.1);
    fg.addColorStop(0, 'rgba(255,200,90,0.95)');
    fg.addColorStop(0.5, 'rgba(255,120,40,0.75)');
    fg.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-r * 0.22, r * 0.8);
    ctx.lineTo(-r * 0.12, r * (1.25 + fl * 0.55));
    ctx.lineTo(0, r * (0.95 + fl * 0.35));
    ctx.lineTo(r * 0.12, r * (1.25 + fl * 0.55));
    ctx.lineTo(r * 0.22, r * 0.8);
    ctx.closePath(); ctx.fill();
    /* 尾翼（左右两片） */
    ctx.fillStyle = '#c0392b';
    for (var k = 0; k < 2; k++) {
      var sx = k === 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(sx * r * 0.16, r * 0.5);
      ctx.lineTo(sx * r * 0.62, r * 0.92);
      ctx.lineTo(sx * r * 0.5, r * 1.0);
      ctx.lineTo(sx * r * 0.1, r * 0.72);
      ctx.closePath(); ctx.fill();
    }
    /* 箭体（银白圆柱） */
    var body = ctx.createLinearGradient(-r * 0.3, 0, r * 0.3, 0);
    body.addColorStop(0, '#aebccb');
    body.addColorStop(0.4, '#f4f8fb');
    body.addColorStop(0.55, '#c9d4de');
    body.addColorStop(1, '#5a6470');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.45);
    ctx.lineTo(r * 0.22, -r * 0.95);
    ctx.lineTo(r * 0.2, r * 0.72);
    ctx.lineTo(-r * 0.2, r * 0.72);
    ctx.lineTo(-r * 0.22, -r * 0.95);
    ctx.closePath(); ctx.fill();
    /* 红色锥头 */
    ctx.fillStyle = '#d9534f';
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.72);
    ctx.quadraticCurveTo(r * 0.23, -r * 1.22, r * 0.2, -r * 0.95);
    ctx.lineTo(-r * 0.2, -r * 0.95);
    ctx.quadraticCurveTo(-r * 0.23, -r * 1.22, 0, -r * 1.72);
    ctx.closePath(); ctx.fill();
    /* 箭身高光条 */
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    rr(-r * 0.09, -r * 0.9, r * 0.1, r * 1.45, r * 0.05); ctx.fill();
    /* 愤怒脸（弹体中部） */
    ammoFace(r, 0, 0, 0.85);
  }

  /* ④ 超级炸弹：黑色"巨型弹体"（黑色细长弹体 + 圆鼻头 + 4 片方形尾翼 + 顶部引信 + 黄黑警示带） */
  function drawAmmoAtomic(r) {
    /* 弹体（黑色金属，两侧暗、中线略亮） */
    var body = ctx.createLinearGradient(-r * 0.3, 0, r * 0.3, 0);
    body.addColorStop(0, '#15171b');
    body.addColorStop(0.42, '#4a4f57');
    body.addColorStop(0.55, '#2e3238');
    body.addColorStop(1, '#0a0c0f');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.78);
    ctx.quadraticCurveTo(r * 0.27, -r * 1.42, r * 0.24, -r * 0.82);
    ctx.lineTo(r * 0.2, r * 0.85);
    ctx.lineTo(-r * 0.2, r * 0.85);
    ctx.lineTo(-r * 0.24, -r * 0.82);
    ctx.quadraticCurveTo(-r * 0.27, -r * 1.42, 0, -r * 1.78);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = Math.max(1, r * 0.045);
    ctx.stroke();
    /* 顶部引信（小圆柱 + 红色尖端） */
    ctx.fillStyle = '#3a3f46';
    rr(-r * 0.05, -r * 1.98, r * 0.1, r * 0.24, r * 0.02); ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.moveTo(0, -r * 2.12);
    ctx.lineTo(r * 0.07, -r * 1.96);
    ctx.lineTo(-r * 0.07, -r * 1.96);
    ctx.closePath(); ctx.fill();
    /* 中段黄黑警示斜纹 */
    ctx.save();
    ctx.beginPath();
    ctx.rect(-r * 0.185, -r * 0.08, r * 0.37, r * 0.34);
    ctx.clip();
    ctx.fillStyle = '#f2c14e';
    ctx.fillRect(-r * 0.185, -r * 0.08, r * 0.37, r * 0.34);
    ctx.fillStyle = '#20242c';
    ctx.lineWidth = r * 0.085;
    ctx.beginPath();
    for (var b = -3; b <= 3; b++) {
      ctx.moveTo(-r * 0.3 + b * r * 0.2, r * 0.32);
      ctx.lineTo(r * 0.3 + b * r * 0.2, -r * 0.32);
    }
    ctx.stroke();
    ctx.restore();
    /* 4 片方形尾翼（十字排布，尾端带凹口） */
    ctx.fillStyle = '#1a1d22';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = Math.max(0.8, r * 0.03);
    for (var k = 0; k < 4; k++) {
      ctx.save();
      ctx.rotate(k * Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(r * 0.1, r * 0.58);
      ctx.lineTo(r * 0.52, r * 0.8);
      ctx.lineTo(r * 0.52, r * 1.3);
      ctx.lineTo(r * 0.3, r * 1.3);
      ctx.lineTo(r * 0.24, r * 1.02);
      ctx.lineTo(r * 0.1, r * 0.98);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    /* 尾盖 */
    ctx.fillStyle = '#0c0e11';
    lellipse(0, r * 0.92, r * 0.2, r * 0.12, 0); ctx.fill();
    /* 弹体高光竖条 */
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    rr(-r * 0.1, -r * 1.55, r * 0.07, r * 2.2, r * 0.035); ctx.fill();
    /* 愤怒脸（弹体上半，黑底白脸醒目） */
    ammoFace(r, 0, -r * 0.3, 0.74);
  }

  /* ⑤ 脉冲弹：能量核心 + 双旋转电磁环 + 电火花（EMP 智能武器，无需脸） */
  function drawAmmoPulse(r) {
    var t = G.time;
    /* 外圈光晕 */
    var halo = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.45);
    halo.addColorStop(0, 'rgba(120,220,255,0.5)');
    halo.addColorStop(1, 'rgba(120,220,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.45, 0, TAU); ctx.fill();
    /* 双电磁环（反向旋转） */
    ctx.strokeStyle = 'rgba(140,230,255,0.9)';
    ctx.lineWidth = Math.max(1.5, r * 0.09);
    ctx.save();
    ctx.rotate(t * 3);
    lellipse(0, 0, r * 0.98, r * 0.42, 0); ctx.stroke();
    ctx.rotate(-t * 6);
    lellipse(0, 0, r * 0.98, r * 0.42, Math.PI / 2); ctx.stroke();
    ctx.restore();
    /* 能量核心 */
    var core = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.05, 0, 0, r * 0.6);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.55, '#a8ecff');
    core.addColorStop(1, '#3aa7d8');
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, TAU); ctx.fill();
    /* 电火花 */
    var sp = 0.55 + 0.45 * Math.sin(t * 12);
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.4 + sp * 0.4).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, r * 0.07);
    for (var k = 0; k < 4; k++) {
      var a = k * Math.PI / 2 + t * 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6);
      ctx.quadraticCurveTo(Math.cos(a + 0.45) * r * 0.95, Math.sin(a + 0.45) * r * 0.95, Math.cos(a + 0.75) * r * 0.7, Math.sin(a + 0.75) * r * 0.7);
      ctx.stroke();
    }
    /* 中心小愤怒眼（智能体有意识） */
    ctx.fillStyle = '#ffffff';
    lellipse(-r * 0.13, -r * 0.02, r * 0.09, r * 0.1, 0); ctx.fill();
    lellipse(r * 0.13, -r * 0.02, r * 0.09, r * 0.1, 0); ctx.fill();
    ctx.fillStyle = '#0e3a5e';
    ctx.beginPath(); ctx.arc(-r * 0.11, 0, r * 0.04, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.15, 0, r * 0.04, 0, TAU); ctx.fill();
  }

  /* ⑥ 恒星弹：火太阳（旋转光芒 + 燃烧火焰球 + 亮核 + 愤怒脸） */
  function drawAmmoSun(r) {
    var t = G.time;
    /* 光芒射线（旋转） */
    ctx.fillStyle = 'rgba(255,170,60,0.85)';
    ctx.save();
    ctx.rotate(t * 2.2);
    for (var k = 0; k < 10; k++) {
      var a = k * TAU / 10;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72);
      ctx.lineTo(Math.cos(a + 0.16) * r * 1.38, Math.sin(a + 0.16) * r * 1.38);
      ctx.lineTo(Math.cos(a + 0.3) * r * 1.38, Math.sin(a + 0.3) * r * 1.38);
      ctx.lineTo(Math.cos(a + 0.5) * r * 0.82, Math.sin(a + 0.5) * r * 0.82);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    /* 火球 */
    var fg = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.0);
    fg.addColorStop(0, '#fff8d0');
    fg.addColorStop(0.45, '#ffd04e');
    fg.addColorStop(0.75, '#ff7a2f');
    fg.addColorStop(1, '#e0361e');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.88, 0, TAU); ctx.fill();
    /* 动态火焰尖 */
    var fl = 0.6 + 0.4 * Math.sin(t * 14);
    ctx.fillStyle = 'rgba(255,120,40,0.9)';
    for (var j = 0; j < 8; j++) {
      var fa = j * TAU / 8 + t * 1.5;
      var fr2 = r * (1.02 + fl * 0.3);
      ctx.beginPath();
      ctx.moveTo(Math.cos(fa - 0.22) * r * 0.78, Math.sin(fa - 0.22) * r * 0.78);
      ctx.quadraticCurveTo(Math.cos(fa) * fr2 * 1.15, Math.sin(fa) * fr2 * 1.15, Math.cos(fa + 0.22) * r * 0.78, Math.sin(fa + 0.22) * r * 0.78);
      ctx.closePath(); ctx.fill();
    }
    /* 亮核 */
    ctx.fillStyle = 'rgba(255,252,210,0.95)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.42, 0, TAU); ctx.fill();
    /* 愤怒脸 */
    ammoFace(r, 0, 0, 0.62);
  }

  /* 弹丸分派表：武器 id → 造型函数 */
  var AMMO_DRAW = {
    stone: drawAmmoStone,
    knife: drawAmmoMine,
    grenade: drawAmmoRocket,
    gun: drawAmmoAtomic,
    cannon: drawAmmoPulse,
    nuke: drawAmmoSun
  };

  function drawLeek(x, y, r, ang, squash, alpha, opts) {
    opts = opts || {};
    /* v7.6：主角不丢——弹丸 = 主角手持武器整体飞行（不再直接画武器本体） */
    /* v5：主角造型 = 大头（清晰表情/可换头像）+ 双手握武器，无身体腿脚 */
    if (!opts.noPhoto) {
      ctx.save();
      ctx.globalAlpha = alpha === undefined ? 1 : alpha;
      ctx.translate(x, y);
      ctx.rotate(ang || 0);
      var sq = squash === undefined ? 1 : squash;
      ctx.scale(sq, 2 - sq);
      var small = r < 11;
      if (small) {
        /* 极小尺寸（HUD 小头像）：只画头 */
        drawHeadFace(r * 0.95);
      } else {
        var wKey = opts.weapon || null;
        var handR = r * 0.36, hy = r * 0.85, hx = r * 1.05;
        /* 武器：斜握在两手中（略朝上，指向山上），尺寸加大明显大于头 */
        if (hasImg(wKey)) {
          var ws = r * 2.3;
          var wh = (wKey === 'nuke') ? ws * 1.5 : ws;  /* 重炮=导弹造型：纵向更长 */
          ctx.save();
          ctx.translate(0, r * 1.25);
          ctx.rotate(-0.32);
          drawImg(wKey, -ws / 2, -wh / 2, ws, wh);
          ctx.restore();
        } else if (wKey && AMMO_DRAW[wKey]) {
          /* v7.6：Canvas 精绘武器拿在手里（扫雷地雷/火箭弹/黑色超级炸弹/脉冲弹/恒星弹） */
          ctx.save();
          ctx.translate(0, r * 1.25);
          ctx.rotate(-0.32);
          AMMO_DRAW[wKey](r * 1.05);
          ctx.restore();
        }
        /* 双手握持（武器端部在手范围内） */
        drawHand(-hx, hy, handR, -0.5);
        drawHand(hx, hy, handR, 0.5);
        /* 大头 */
        drawHeadFace(r * 1.05);
        /* 头顶装饰（男韭菜叶 / 女韭菜花）—— 自定义头像时跳过，避免叠加混乱 */
        if (!CUSTOM_AVATAR_ACTIVE) {
          if (opts.flower) drawFlowerTop(r * 0.95, false);
          else drawLeafTop(r * 0.95, false);
        }
      }
      ctx.restore();
      return;
    }
    var def = opts.weapon ? (WEAPONS[opts.weapon] || null) : null;
    var wtype = def ? def.type : 'ball';
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.translate(x, y);
    ctx.rotate(ang || 0);
    var sq = squash === undefined ? 1 : squash;
    ctx.scale(sq, 2 - sq);
    /* 时代整体造型 */
    if (wtype === 'pierce') { drawWPlane(r); ctx.restore(); return; }
    if (wtype === 'missile') { drawWMissile(r); ctx.restore(); return; }
    if (wtype === 'nuke') { drawWNuke(r); ctx.restore(); return; }
    if (wtype === 'chip') { drawWChip(r); ctx.restore(); return; }
    var small = r < 11;
    /* --- 头部（圆润大头） --- */
    var headR = r * (small ? 0.95 : 1.05);
    var grad = ctx.createRadialGradient(-headR * 0.3, -headR * 0.35, headR * 0.2, 0, 0, headR * 1.15);
    grad.addColorStop(0, '#7ed957');
    grad.addColorStop(0.7, '#3f9b3d');
    grad.addColorStop(1, '#2c7a30');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, -headR * 0.15, headR, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(30,90,35,0.55)';
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.stroke();
    /* 高光 */
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    lellipse(-headR * 0.38, -headR * 0.5, headR * 0.3, headR * 0.18, -0.6);
    ctx.fill();
    /* --- 头顶绿叶丛（男）或韭菜花（女） --- */
    if (opts.flower) {
      drawFlowerTop(r, small);
    } else {
      drawLeafTop(r, small);
    }
    /* --- 韭白身体 --- */
    ctx.fillStyle = '#f7f2e4';
    ctx.strokeStyle = '#d9cfb8';
    ctx.lineWidth = Math.max(1, r * 0.06);
    lellipse(0, headR * 1.05, r * 0.62, r * 0.55, 0);
    ctx.fill(); ctx.stroke();
    /* --- 表情（愤怒倒八字眉 + 大眼 + 龇牙） --- */
    var ex = 0, ey = headR * 0.18;
    ctx.fillStyle = '#ffffff';
    lellipse(ex - r * 0.3, ey - r * 0.02, r * 0.2, r * 0.22, 0);
    ctx.fill();
    lellipse(ex + r * 0.3, ey - r * 0.02, r * 0.2, r * 0.22, 0);
    ctx.fill();
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(ex - r * 0.28, ey + r * 0.02, r * 0.085, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + r * 0.32, ey + r * 0.02, r * 0.085, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(ex - r * 0.31, ey - r * 0.05, r * 0.028, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + r * 0.29, ey - r * 0.05, r * 0.028, 0, TAU); ctx.fill();
    /* 怒眉 */
    ctx.strokeStyle = '#1c2a20';
    ctx.lineWidth = Math.max(1.5, r * 0.09);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ex - r * 0.52, ey - r * 0.36);
    ctx.lineTo(ex - r * 0.12, ey - r * 0.16);
    ctx.moveTo(ex + r * 0.52, ey - r * 0.36);
    ctx.lineTo(ex + r * 0.12, ey - r * 0.16);
    ctx.stroke();
    /* 龇牙 */
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1c2a20';
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.beginPath();
    ctx.moveTo(ex - r * 0.18, ey + r * 0.3);
    ctx.quadraticCurveTo(ex, ey + r * 0.48, ex + r * 0.18, ey + r * 0.3);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#1c2a20';
    ctx.beginPath();
    ctx.moveTo(ex - r * 0.08, ey + r * 0.28);
    ctx.lineTo(ex - r * 0.08, ey + r * 0.42);
    ctx.moveTo(ex, ey + r * 0.3);
    ctx.lineTo(ex, ey + r * 0.46);
    ctx.moveTo(ex + r * 0.08, ey + r * 0.28);
    ctx.lineTo(ex + r * 0.08, ey + r * 0.42);
    ctx.stroke();
    /* --- 时代装饰 --- */
    if (wtype === 'bomb') drawBombPack(r);
    else if (wtype === 'cluster') drawDumplingHat(r);
    else if (wtype === 'carrier' || wtype === 'drone') drawWingPack(r);
    ctx.restore();
  }

  /* 头顶绿叶丛：一大丛绿油油（6~9 根，带高光条纹） */
  function drawLeafTop(r, small) {
    var n = small ? 5 : 8;
    var sway = Math.sin(G.time * 3.2) * 0.06;
    for (var i = 0; i < n; i++) {
      var a = -Math.PI * 0.72 + (i / (n - 1)) * Math.PI * 0.44 + sway;
      var len = r * (1.25 + hash01(i * 3.3) * 0.5);
      var x2 = Math.cos(a) * r * 0.85;
      var y2 = -r * 0.9 + Math.sin(a) * r * 0.35;
      var tipX = x2 + Math.cos(a) * len;
      var tipY = y2 + Math.sin(a) * len * 0.55 - r * 0.2;
      /* 叶身（深绿） */
      ctx.strokeStyle = i % 3 === 0 ? '#2c7a30' : '#35923c';
      ctx.lineWidth = r * 0.26;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.quadraticCurveTo((x2 + tipX) / 2 + Math.cos(a + 0.5) * r * 0.25, (y2 + tipY) / 2 - r * 0.35, tipX, tipY);
      ctx.stroke();
      /* 叶中高光条纹 */
      ctx.strokeStyle = 'rgba(150,235,120,0.5)';
      ctx.lineWidth = r * 0.07;
      ctx.beginPath();
      ctx.moveTo(x2 + Math.cos(a + Math.PI / 2) * r * 0.03, y2 + Math.sin(a + Math.PI / 2) * r * 0.03);
      ctx.quadraticCurveTo((x2 + tipX) / 2 + Math.cos(a + 0.5) * r * 0.22, (y2 + tipY) / 2 - r * 0.32, tipX, tipY);
      ctx.stroke();
    }
  }

  /* 韭菜花：白色伞形花簇（中心 + 放射小花瓣），花下有绿茎 */
  function drawFlowerTop(r, small) {
    var n = small ? 5 : 9;
    var sway = Math.sin(G.time * 2.6) * 0.05;
    /* 花茎 */
    ctx.strokeStyle = '#35923c';
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.75);
    ctx.quadraticCurveTo(r * 0.1 + sway * r, -r * 1.25, 0, -r * 1.6);
    ctx.stroke();
    /* 花簇 */
    var fx = sway * r * 0.5, fy = -r * 1.62;
    var fr = r * (small ? 0.42 : 0.6);
    ctx.fillStyle = '#ffffff';
    for (var i = 0; i < n; i++) {
      var a = (i / n) * TAU;
      lellipse(fx + Math.cos(a) * fr * 0.7, fy + Math.sin(a) * fr * 0.7, fr * 0.42, fr * 0.3, a);
      ctx.fill();
    }
    ctx.fillStyle = '#ffe27a';
    ctx.beginPath(); ctx.arc(fx, fy, fr * 0.28, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(200,180,120,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(fx, fy, fr * 0.8, 0, TAU); ctx.stroke();
  }

  /* 热兵器：腰上炸药包 */
  function drawBombPack(r) {
    ctx.save();
    ctx.translate(0, r * 0.9);
    ctx.fillStyle = '#8a5a33';
    rr(-r * 0.55, -r * 0.3, r * 1.1, r * 0.7, r * 0.15);
    ctx.fill();
    ctx.strokeStyle = '#5f3b18';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#4e2e14';
    ctx.fillRect(-r * 0.55, -r * 0.08, r * 1.1, r * 0.16);
    /* 引线 */
    ctx.strokeStyle = '#d98e2b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r * 0.4, -r * 0.3);
    ctx.quadraticCurveTo(r * 0.6, -r * 0.5, r * 0.45, -r * 0.62);
    ctx.stroke();
    var spark = 0.7 + 0.3 * Math.sin(G.time * 20);
    ctx.fillStyle = 'rgba(255,190,80,' + spark + ')';
    ctx.beginPath(); ctx.arc(r * 0.45, -r * 0.66, 2.6, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /* 热兵器：饺子帽 */
  function drawDumplingHat(r) {
    ctx.save();
    ctx.translate(0, -r * 0.75);
    ctx.fillStyle = '#fff3dc';
    lellipse(0, 0, r * 0.6, r * 0.34, 0);
    ctx.fill();
    ctx.strokeStyle = '#d9b381';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = '#c9a06a';
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, -r * 0.05);
    ctx.quadraticCurveTo(0, r * 0.3, r * 0.5, -r * 0.05);
    ctx.stroke();
    ctx.restore();
  }

  /* 现代战争：背后机翼 */
  function drawWingPack(r) {
    ctx.save();
    ctx.translate(0, -r * 0.1);
    ctx.fillStyle = '#5a6470';
    ctx.beginPath();
    ctx.moveTo(-r * 1.1, -r * 0.25);
    ctx.lineTo(-r * 0.35, -r * 0.5);
    ctx.lineTo(-r * 0.35, -r * 0.15);
    ctx.lineTo(-r * 1.1, r * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(r * 1.1, -r * 0.25);
    ctx.lineTo(r * 0.35, -r * 0.5);
    ctx.lineTo(r * 0.35, -r * 0.15);
    ctx.lineTo(r * 1.1, r * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d9534f';
    ctx.fillRect(-r * 0.12, -r * 0.4, r * 0.24, r * 0.3);
    ctx.restore();
  }

  /* 时代造型：飞机（高速直线） */
  /* 写实韭菜冠：从 (cx,cy) 向上长出一簇韭菜叶（"逼真武器头上长韭菜"的统一元素） */
  function leekCrown(cx, cy, s) {
    var n = 6;
    /* 韭白茎基 */
    var g0 = ctx.createLinearGradient(cx - s * 0.12, 0, cx + s * 0.12, 0);
    g0.addColorStop(0, '#c9c2ae');
    g0.addColorStop(0.5, '#f2edda');
    g0.addColorStop(1, '#b9b294');
    ctx.fillStyle = g0;
    rr(cx - s * 0.12, cy - s * 0.16, s * 0.24, s * 0.2, s * 0.06);
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,80,50,0.35)';
    ctx.lineWidth = 1;
    rr(cx - s * 0.12, cy - s * 0.16, s * 0.24, s * 0.2, s * 0.06);
    ctx.stroke();
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1) - 0.5;
      var at = Math.abs(t);
      var spread = t * s * 1.05;
      var len = s * (1.15 + at * 0.55);
      var bend = t * t * t * s * 0.5;
      var tipX = cx + spread + bend;
      var tipY = cy - s * 0.18 - len;
      var baseX = cx + spread;
      var g = ctx.createLinearGradient(baseX - s * 0.1, 0, baseX + s * 0.1, 0);
      g.addColorStop(0, '#2c7a30');
      g.addColorStop(0.5, '#4dab44');
      g.addColorStop(1, '#245f28');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(baseX - s * 0.13, cy - s * 0.08);
      ctx.quadraticCurveTo(baseX - s * 0.24, cy - len * 0.45, tipX - s * 0.06, tipY);
      ctx.quadraticCurveTo(baseX + s * 0.16, cy - len * 0.35, baseX + s * 0.13, cy - s * 0.08);
      ctx.closePath();
      ctx.fill();
      /* 叶脉 */
      ctx.strokeStyle = 'rgba(215,255,185,0.55)';
      ctx.lineWidth = Math.max(0.8, s * 0.045);
      ctx.beginPath();
      ctx.moveTo(baseX, cy - s * 0.1);
      ctx.quadraticCurveTo(baseX + t * s * 0.15, cy - len * 0.5, tipX, tipY);
      ctx.stroke();
    }
  }

  /* 时代造型：写实喷气战斗机（金属机身·座舱·挂架·头顶长韭菜） */
  function drawWPlane(r) {
    var wing = ctx.createLinearGradient(-r * 0.5, 0, r * 0.5, 0);
    wing.addColorStop(0, '#8b9aac');
    wing.addColorStop(0.4, '#e8eef4');
    wing.addColorStop(0.55, '#aebccb');
    wing.addColorStop(1, '#5a6470');
    /* 主翼（后掠） */
    ctx.fillStyle = wing;
    ctx.beginPath();
    ctx.moveTo(-r * 0.05, -r * 0.18);
    ctx.lineTo(-r * 1.3, r * 0.18);
    ctx.lineTo(-r * 1.12, r * 0.42);
    ctx.lineTo(-r * 0.02, r * 0.3);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(r * 0.05, -r * 0.18);
    ctx.lineTo(r * 1.3, r * 0.18);
    ctx.lineTo(r * 1.12, r * 0.42);
    ctx.lineTo(r * 0.02, r * 0.3);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(45,55,72,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    /* 翼下挂架 */
    ctx.fillStyle = '#5a6470';
    ctx.fillRect(-r * 1.22, r * 0.3, r * 0.14, r * 0.05);
    ctx.fillRect(r * 1.08, r * 0.3, r * 0.14, r * 0.05);
    /* 水平尾翼 */
    ctx.fillStyle = wing;
    ctx.beginPath();
    ctx.moveTo(-r * 0.05, r * 0.62);
    ctx.lineTo(-r * 0.6, r * 1.0);
    ctx.lineTo(-r * 0.45, r * 1.08);
    ctx.lineTo(-r * 0.02, r * 0.78);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(r * 0.05, r * 0.62);
    ctx.lineTo(r * 0.6, r * 1.0);
    ctx.lineTo(r * 0.45, r * 1.08);
    ctx.lineTo(r * 0.02, r * 0.78);
    ctx.closePath(); ctx.fill();
    /* 机身（梭形金属） */
    var body = ctx.createLinearGradient(-r * 0.45, 0, r * 0.45, 0);
    body.addColorStop(0, '#6b7683');
    body.addColorStop(0.32, '#c9d4de');
    body.addColorStop(0.5, '#f2f6f9');
    body.addColorStop(0.7, '#aebccb');
    body.addColorStop(1, '#4a5568');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.4);
    ctx.bezierCurveTo(r * 0.3, -r * 1.0, r * 0.46, -r * 0.15, r * 0.42, r * 0.55);
    ctx.quadraticCurveTo(r * 0.38, r * 1.05, r * 0.22, r * 1.25);
    ctx.quadraticCurveTo(0, r * 1.35, -r * 0.22, r * 1.25);
    ctx.quadraticCurveTo(-r * 0.38, r * 1.05, -r * 0.42, r * 0.55);
    ctx.bezierCurveTo(-r * 0.46, -r * 0.15, -r * 0.3, -r * 1.0, 0, -r * 1.4);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(45,55,72,0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    /* 机头雷达罩 */
    var nose = ctx.createLinearGradient(-r * 0.2, 0, r * 0.2, 0);
    nose.addColorStop(0, '#8b9aac');
    nose.addColorStop(0.45, '#e3eaf0');
    nose.addColorStop(1, '#6b7683');
    ctx.fillStyle = nose;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.52);
    ctx.quadraticCurveTo(r * 0.2, -r * 1.2, r * 0.21, -r * 1.0);
    ctx.lineTo(-r * 0.21, -r * 1.0);
    ctx.quadraticCurveTo(-r * 0.2, -r * 1.2, 0, -r * 1.52);
    ctx.closePath(); ctx.fill();
    /* 座舱盖 */
    var canopy = ctx.createLinearGradient(0, 0, r * 0.2, 0);
    canopy.addColorStop(0, '#4a7a94');
    canopy.addColorStop(0.5, '#9fd8e8');
    canopy.addColorStop(1, '#3a5a70');
    ctx.fillStyle = canopy;
    ctx.beginPath();
    ctx.moveTo(-r * 0.15, -r * 0.82);
    ctx.quadraticCurveTo(-r * 0.17, -r * 0.6, 0, -r * 0.44);
    ctx.quadraticCurveTo(r * 0.17, -r * 0.6, r * 0.15, -r * 0.82);
    ctx.quadraticCurveTo(0, -r * 0.9, -r * 0.15, -r * 0.82);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-r * 0.12, -r * 0.78);
    ctx.quadraticCurveTo(-r * 0.12, -r * 0.62, 0, -r * 0.5);
    ctx.stroke();
    /* 垂直尾翼 */
    var fin = ctx.createLinearGradient(-r * 0.05, 0, r * 0.2, 0);
    fin.addColorStop(0, '#c9d4de');
    fin.addColorStop(1, '#5a6470');
    ctx.fillStyle = fin;
    ctx.beginPath();
    ctx.moveTo(r * 0.04, r * 0.7);
    ctx.quadraticCurveTo(r * 0.3, r * 0.6, r * 0.42, r * 0.35);
    ctx.lineTo(r * 0.1, r * 0.55);
    ctx.closePath(); ctx.fill();
    /* 喷口 + 尾焰 */
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(-r * 0.14, r * 1.3, r * 0.12, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.14, r * 1.3, r * 0.12, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(140,200,255,0.85)';
    ctx.beginPath(); ctx.arc(-r * 0.14, r * 1.42, r * 0.07, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.14, r * 1.42, r * 0.07, 0, TAU); ctx.fill();
    /* 蒙皮线 */
    ctx.strokeStyle = 'rgba(45,55,72,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-r * 0.28, -r * 0.6);
    ctx.quadraticCurveTo(-r * 0.32, r * 0.1, -r * 0.26, r * 0.9);
    ctx.moveTo(r * 0.28, -r * 0.6);
    ctx.quadraticCurveTo(r * 0.32, r * 0.1, r * 0.26, r * 0.9);
    ctx.stroke();
    /* 头顶长韭菜 */
    leekCrown(0, -r * 1.5, r * 0.55);
  }

  /* 时代造型：导弹（制导） */
  /* 时代造型：写实弹道火箭（红白箭体·尾翼喷管·头顶长韭菜） */
  function drawWMissile(r) {
    var body = ctx.createLinearGradient(-r * 0.3, 0, r * 0.3, 0);
    body.addColorStop(0, '#8b9aac');
    body.addColorStop(0.35, '#eef2f6');
    body.addColorStop(0.55, '#c9d4de');
    body.addColorStop(1, '#5a6470');
    ctx.fillStyle = body;
    /* 箭体圆柱 */
    ctx.beginPath();
    ctx.moveTo(-r * 0.3, -r * 0.75);
    ctx.lineTo(-r * 0.3, r * 0.95);
    ctx.quadraticCurveTo(0, r * 1.08, r * 0.3, r * 0.95);
    ctx.lineTo(r * 0.3, -r * 0.75);
    ctx.quadraticCurveTo(0, -r * 0.88, -r * 0.3, -r * 0.75);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(45,55,72,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    /* 红白条纹 */
    ctx.fillStyle = '#d9534f';
    ctx.beginPath();
    ctx.moveTo(-r * 0.29, r * 0.1);
    ctx.lineTo(-r * 0.29, r * 0.42);
    ctx.quadraticCurveTo(0, r * 0.5, r * 0.29, r * 0.42);
    ctx.lineTo(r * 0.29, r * 0.1);
    ctx.quadraticCurveTo(0, r * 0.02, -r * 0.29, r * 0.1);
    ctx.closePath(); ctx.fill();
    /* 整流罩（红色锥） */
    var nose = ctx.createLinearGradient(-r * 0.2, 0, r * 0.2, 0);
    nose.addColorStop(0, '#a8322e');
    nose.addColorStop(0.4, '#f0785e');
    nose.addColorStop(0.7, '#d9534f');
    nose.addColorStop(1, '#8a2a24');
    ctx.fillStyle = nose;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.6);
    ctx.quadraticCurveTo(r * 0.24, -r * 1.1, r * 0.28, -r * 0.8);
    ctx.lineTo(-r * 0.28, -r * 0.8);
    ctx.quadraticCurveTo(-r * 0.24, -r * 1.1, 0, -r * 1.6);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(90,40,35,0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    /* 级间焊缝环 */
    ctx.strokeStyle = 'rgba(45,55,72,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-r * 0.3, r * 0.55);
    ctx.lineTo(r * 0.3, r * 0.55);
    ctx.moveTo(-r * 0.3, r * 0.72);
    ctx.lineTo(r * 0.3, r * 0.72);
    ctx.stroke();
    /* 尾翼（十字：前后两片可见） */
    var fin = ctx.createLinearGradient(-r * 0.6, 0, r * 0.6, 0);
    fin.addColorStop(0, '#a8322e');
    fin.addColorStop(0.5, '#f0785e');
    fin.addColorStop(1, '#8a2a24');
    ctx.fillStyle = fin;
    ctx.beginPath();
    ctx.moveTo(-r * 0.26, r * 0.62);
    ctx.lineTo(-r * 0.78, r * 1.05);
    ctx.lineTo(-r * 0.68, r * 1.16);
    ctx.lineTo(-r * 0.22, r * 0.85);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(r * 0.26, r * 0.62);
    ctx.lineTo(r * 0.78, r * 1.05);
    ctx.lineTo(r * 0.68, r * 1.16);
    ctx.lineTo(r * 0.22, r * 0.85);
    ctx.closePath(); ctx.fill();
    /* 喷管 */
    var nozzle = ctx.createLinearGradient(-r * 0.2, 0, r * 0.2, 0);
    nozzle.addColorStop(0, '#2d3748');
    nozzle.addColorStop(0.5, '#5a6470');
    nozzle.addColorStop(1, '#20242c');
    ctx.fillStyle = nozzle;
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, r * 0.95);
    ctx.lineTo(-r * 0.26, r * 1.18);
    ctx.lineTo(r * 0.26, r * 1.18);
    ctx.lineTo(r * 0.2, r * 0.95);
    ctx.closePath(); ctx.fill();
    /* 喷口火焰 */
    var fl = ctx.createLinearGradient(0, r * 1.2, 0, r * 2.1);
    fl.addColorStop(0, 'rgba(255,245,200,0.95)');
    fl.addColorStop(0.4, 'rgba(255,180,80,0.8)');
    fl.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.fillStyle = fl;
    ctx.beginPath();
    ctx.moveTo(-r * 0.18, r * 1.16);
    ctx.quadraticCurveTo(-r * 0.4, r * 1.7, 0, r * 2.1);
    ctx.quadraticCurveTo(r * 0.4, r * 1.7, r * 0.18, r * 1.16);
    ctx.closePath(); ctx.fill();
    /* 箭体标字 */
    ctx.fillStyle = 'rgba(45,55,72,0.75)';
    ctx.font = 'bold ' + Math.round(r * 0.3) + 'px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('韭', 0, r * 0.26);
    ctx.textBaseline = 'alphabetic';
    /* 头顶长韭菜 */
    leekCrown(0, -r * 1.55, r * 0.5);
  }

  /* 时代造型：重炮 */
  function drawWNuke(r) {
    /* 弹体 */
    ctx.fillStyle = '#4a5568';
    rr(-r * 0.62, -r * 0.5, r * 1.24, r * 1.15, r * 0.25);
    ctx.fill();
    ctx.strokeStyle = '#2d3748';
    ctx.lineWidth = 2;
    ctx.stroke();
    /* 辐射标志 */
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath(); ctx.arc(0, r * 0.05, r * 0.42, 0, TAU); ctx.fill();
    ctx.fillStyle = '#4a5568';
    for (var i = 0; i < 3; i++) {
      var a = i * TAU / 3 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(0, r * 0.05);
      ctx.lineTo(Math.cos(a) * r * 0.62, r * 0.05 + Math.sin(a) * r * 0.62);
      ctx.lineTo(Math.cos(a + 0.5) * r * 0.3, r * 0.05 + Math.sin(a + 0.5) * r * 0.3);
      ctx.closePath();
      ctx.fill();
    }
    /* 顶盖 */
    ctx.fillStyle = '#2d3748';
    ctx.fillRect(-r * 0.3, -r * 0.75, r * 0.6, r * 0.3);
    ctx.fillStyle = '#ff8a4f';
    ctx.fillRect(-r * 0.18, -r * 0.85, r * 0.36, r * 0.14);
    var blink = 0.6 + 0.4 * Math.sin(G.time * 14);
    ctx.fillStyle = 'rgba(255,240,160,' + blink + ')';
    ctx.beginPath(); ctx.arc(0, -r * 0.78, r * 0.1, 0, TAU); ctx.fill();
    /* 表情 */
    drawAngryMini(r);
  }

  /* 时代造型：智子（激光粒子） */
  function drawWChip(r) {
    var pulse = 0.5 + 0.5 * Math.sin(G.time * 10);
    /* 光晕 */
    var glow = ctx.createRadialGradient(0, 0, 1, 0, 0, r * 1.9);
    glow.addColorStop(0, 'rgba(125,250,156,' + (0.55 + pulse * 0.35) + ')');
    glow.addColorStop(1, 'rgba(125,250,156,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.9, 0, TAU); ctx.fill();
    /* 智子核心：旋转的发光八面体 */
    ctx.save();
    ctx.rotate(G.time * 2.4);
    ctx.fillStyle = '#eafff0';
    ctx.beginPath();
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2;
      var px = Math.cos(a) * r * 0.62, py = Math.sin(a) * r * 0.62;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#7dfa9c';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.42, 0, TAU); ctx.fill();
    ctx.restore();
    /* 环绕电子 */
    ctx.strokeStyle = 'rgba(125,250,156,0.75)';
    ctx.lineWidth = 1.6;
    ctx.save();
    ctx.rotate(-G.time * 5);
    lellipse(0, 0, r * 1.25, r * 0.4, 0);
    ctx.stroke();
    ctx.fillStyle = '#d9ffe4';
    ctx.beginPath(); ctx.arc(r * 1.25, 0, r * 0.13, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /* 小型愤怒表情（时代造型用） */
  function drawAngryMini(r) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.05, r * 0.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.3, -r * 0.05, r * 0.2, 0, TAU); ctx.fill();
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.02, r * 0.09, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.3, -r * 0.02, r * 0.09, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#1c2a20';
    ctx.lineWidth = Math.max(1.5, r * 0.09);
    ctx.beginPath();
    ctx.moveTo(-r * 0.52, -r * 0.38);
    ctx.lineTo(-r * 0.12, -r * 0.18);
    ctx.moveTo(r * 0.52, -r * 0.38);
    ctx.lineTo(r * 0.12, -r * 0.18);
    ctx.stroke();
  }

  /* ====================== 渲染：方块 ====================== */
  function drawBlock(b) {
    ctx.save();
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (b.wobble !== 0) {
      ctx.translate(cx, cy);
      ctx.rotate(b.wobble);
      ctx.translate(-cx, -cy);
    }
    switch (b.kind) {
      case 'plank': case 'leg': drawWood(b); break;
      case 'brick': drawBrick(b); break;
      case 'stone': drawStone(b); break;
      default: if (isEnemy(b.kind)) drawEnemy(b);
    }
    /* 精英怪金色描边 */
    if (b.enemy && b.elite) {
      ctx.strokeStyle = 'rgba(255,215,94,0.9)';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#ffd75e';
      ctx.shadowBlur = 6;
      rr(b.x - 1, b.y - 1, b.w + 2, b.h + 2, 6);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (b.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + clamp(b.flash * 4, 0, 0.8) + ')';
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    if (isEnemy(b.kind)) drawHpBar(b);
    ctx.restore();
  }

  function drawWood(b) {
    ctx.fillStyle = '#c08a4e';
    rr(b.x, b.y, b.w, b.h, 3); ctx.fill();
    ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = 'rgba(138,90,43,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(b.x + 4, b.y + b.h * 0.3);
    ctx.lineTo(b.x + b.w - 4, b.y + b.h * 0.3);
    ctx.moveTo(b.x + 4, b.y + b.h * 0.7);
    ctx.lineTo(b.x + b.w - 4, b.y + b.h * 0.7);
    ctx.stroke();
  }

  function drawBrick(b) {
    ctx.fillStyle = '#c75b4a';
    rr(b.x, b.y, b.w, b.h, 2); ctx.fill();
    ctx.strokeStyle = '#8a2f26';
    ctx.lineWidth = 1.5;
    var rowH = 9;
    var rows = Math.max(1, Math.round(b.h / rowH));
    for (var r = 0; r <= rows; r++) {
      var yy = b.y + r * (b.h / rows);
      ctx.beginPath(); ctx.moveTo(b.x, yy); ctx.lineTo(b.x + b.w, yy); ctx.stroke();
    }
    for (r = 0; r < rows; r++) {
      var off = (r % 2) * (b.w / 2);
      for (var x = off; x < b.w; x += b.w / 2) {
        ctx.beginPath();
        ctx.moveTo(b.x + x, b.y + r * (b.h / rows));
        ctx.lineTo(b.x + x, b.y + (r + 1) * (b.h / rows));
        ctx.stroke();
      }
    }
    ctx.strokeStyle = '#6e2019';
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }

  function drawStone(b) {
    ctx.fillStyle = '#9aa5b1';
    rr(b.x, b.y, b.w, b.h, 3); ctx.fill();
    ctx.strokeStyle = '#6d7681'; ctx.lineWidth = 2; ctx.stroke();
    /* 裂纹随损坏程度 */
    var dmg = 1 - b.hp / b.maxHp;
    if (dmg > 0.15) {
      ctx.strokeStyle = 'rgba(60,66,74,' + (0.35 + dmg * 0.4) + ')';
      ctx.lineWidth = 1.5;
      var s = hash01(b.x * 7.7 + b.y * 13.3);
      ctx.beginPath();
      ctx.moveTo(b.x + b.w * s, b.y);
      ctx.lineTo(b.x + b.w * (s + 0.2 * dmg), b.y + b.h * 0.5);
      ctx.lineTo(b.x + b.w * (s - 0.15), b.y + b.h);
      ctx.stroke();
    }
  }

  function angryEyes(cx, cy, s, color) {
    /* 白色眼白 + 愤怒眉毛 */
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(cx - s * 0.34, cy, s * 0.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + s * 0.34, cy, s * 0.2, 0, TAU); ctx.fill();
    ctx.fillStyle = color || '#c0392b';
    ctx.beginPath(); ctx.arc(cx - s * 0.34, cy + s * 0.04, s * 0.09, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + s * 0.34, cy + s * 0.04, s * 0.09, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#20242c';
    ctx.lineWidth = Math.max(2, s * 0.09);
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.62, cy - s * 0.34);
    ctx.lineTo(cx - s * 0.12, cy - s * 0.1);
    ctx.moveTo(cx + s * 0.62, cy - s * 0.34);
    ctx.lineTo(cx + s * 0.12, cy - s * 0.1);
    ctx.stroke();
    /* 嘴（怒） */
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.16, cy + s * 0.34);
    ctx.quadraticCurveTo(cx, cy + s * 0.22, cx + s * 0.16, cy + s * 0.34);
    ctx.stroke();
  }

  /* ====================== 渲染：敌人（割韭菜产业链坏蛋图鉴） ====================== */
  function drawEnemy(b) {
    /* v3：优先用真实图片素材 */
    if (hasImg(b.kind)) {
      var ix = b.x + b.w / 2, iy = b.y + b.h / 2;
      var iw = b.w * 1.25, ih = b.h * 1.25;
      drawImg(b.kind, ix - iw / 2, iy - ih / 2, iw, ih);
      /* v7：挥舞镰刀 + 蓄力发光覆盖层 */
      drawScytheSwing(b);
      return;
    }
    switch (b.kind) {
      case 'whitehouse': drawWhiteHouse(b); break;
      case 'bear': drawBear(b, false); break;
      default: drawAnimalFallback(b); break;
    }
  }

  /* v7：敌人挥镰动画——蓄力时镰刀红光闪烁，挥下时一道弧形白光斩向主角方向 */
  function drawScytheSwing(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    /* 蓄力（attackT 快归零）：红色脉冲轮廓，提示即将开火 */
    if (b.attackT < 0.5 && b.attackT > 0) {
      var pu = 0.5 + 0.5 * Math.sin(G.time * 14);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,70,60,' + (0.35 + pu * 0.4) + ')';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#ff4040';
      ctx.shadowBlur = 8 + pu * 8;
      lellipse(cx, cy, b.w * 0.62 + pu * 3, b.h * 0.62 + pu * 3, 0);
      ctx.stroke();
      ctx.restore();
    }
    /* 挥下瞬间：白色弧形刀光 + 命中闪光 */
    if (b.swingT > 0) {
      var k = 1 - b.swingT / 0.35;               /* 0→1 挥下进度 */
      var sx = cx + (SX - cx) * 0.55;            /* 刀光终点（朝主角方向） */
      var sy = cy + (SY - LAUNCH_OFF - cy) * 0.55;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.95 * (1 - k)) + ')';
      ctx.lineWidth = 5 - k * 2;
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(cx + (sx - cx) * (k - 0.25), cy + (sy - cy) * (k - 0.25));
      ctx.quadraticCurveTo(
        cx + (sx - cx) * k - (sy - cy) * 0.22, cy + (sy - cy) * k + (sx - cx) * 0.22,
        sx, sy
      );
      ctx.stroke();
      ctx.restore();
    }
  }

  /* 无真实图片时的简易兜底（正常游戏不会触发，仅测试/加载失败用） */
  function drawAnimalFallback(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.fillStyle = 'rgba(90,60,40,0.85)';
    rr(b.x + 2, b.y + 2, b.w - 4, b.h - 4, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.max(10, b.w * 0.22) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(enemyName(b.kind), cx, cy);
  }

  /* 镰刀：写实农夫·戴草帽手持大镰刀 */
  function drawScythe(b) {
    var cx = b.x + b.w / 2;
    var bot = b.y + b.h;
    var s = Math.min(b.w, b.h);
    /* —— 镰刀（先画，位于身后侧） —— */
    var handX = cx - s * 0.14, handY = bot - s * 0.6;
    var gripTopX = cx + s * 0.2, gripTopY = bot - s * 1.05;
    var hg = ctx.createLinearGradient(gripTopX, gripTopY, handX, handY);
    hg.addColorStop(0, '#8a5a33');
    hg.addColorStop(0.5, '#c8945a');
    hg.addColorStop(1, '#7a4a26');
    ctx.strokeStyle = hg;
    ctx.lineWidth = s * 0.09;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(gripTopX, gripTopY);
    ctx.lineTo(handX, handY);
    ctx.stroke();
    /* 金属箍 */
    ctx.strokeStyle = '#aebccb';
    ctx.lineWidth = s * 0.1;
    ctx.beginPath();
    ctx.moveTo(gripTopX, gripTopY);
    ctx.lineTo(gripTopX - s * 0.06, gripTopY + s * 0.07);
    ctx.stroke();
    /* 弯月铁刃（银灰渐变 + 刃口高光） */
    var bx = gripTopX - s * 0.05, by = gripTopY + s * 0.06;
    var bg = ctx.createLinearGradient(bx, by, bx + s * 0.9, by + s * 0.5);
    bg.addColorStop(0, '#e8eef4');
    bg.addColorStop(0.5, '#c9d4de');
    bg.addColorStop(1, '#8b9aac');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + s * 0.5, by - s * 0.3, bx + s * 0.85, by - s * 0.16);
    ctx.quadraticCurveTo(bx + s * 0.95, by + s * 0.08, bx + s * 0.6, by + s * 0.26);
    ctx.quadraticCurveTo(bx + s * 0.3, by + s * 0.32, bx, by);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(70,80,92,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(bx + s * 0.06, by - s * 0.05);
    ctx.quadraticCurveTo(bx + s * 0.5, by - s * 0.26, bx + s * 0.82, by - s * 0.14);
    ctx.stroke();
    /* —— 人物 —— */
    /* 靴子 */
    ctx.fillStyle = '#3a2a1a';
    rr(cx - s * 0.3, bot - s * 0.15, s * 0.26, s * 0.15, 4); ctx.fill();
    rr(cx + s * 0.04, bot - s * 0.15, s * 0.26, s * 0.15, 4); ctx.fill();
    /* 裤腿（背带裤靛蓝） */
    var pants = ctx.createLinearGradient(cx - s * 0.3, 0, cx + s * 0.3, 0);
    pants.addColorStop(0, '#3a4a6a');
    pants.addColorStop(0.5, '#5a7294');
    pants.addColorStop(1, '#2c3a52');
    ctx.fillStyle = pants;
    rr(cx - s * 0.3, bot - s * 0.54, s * 0.26, s * 0.42, 3); ctx.fill();
    rr(cx + s * 0.04, bot - s * 0.54, s * 0.26, s * 0.42, 3); ctx.fill();
    /* 衬衫（米黄粗布） */
    var shirt = ctx.createLinearGradient(cx - s * 0.3, 0, cx + s * 0.3, 0);
    shirt.addColorStop(0, '#c9b894');
    shirt.addColorStop(0.5, '#e8dcc0');
    shirt.addColorStop(1, '#b3a27e');
    ctx.fillStyle = shirt;
    rr(cx - s * 0.3, bot - s * 0.98, s * 0.6, s * 0.5, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(90,75,50,0.5)';
    ctx.lineWidth = 1;
    rr(cx - s * 0.3, bot - s * 0.98, s * 0.6, s * 0.5, 6); ctx.stroke();
    /* 背带 */
    ctx.strokeStyle = '#4a5a7a';
    ctx.lineWidth = s * 0.055;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.18, bot - s * 0.97);
    ctx.lineTo(cx - s * 0.16, bot - s * 0.64);
    ctx.moveTo(cx + s * 0.18, bot - s * 0.97);
    ctx.lineTo(cx + s * 0.16, bot - s * 0.64);
    ctx.stroke();
    /* 衣褶 */
    ctx.strokeStyle = 'rgba(120,100,65,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.24, bot - s * 0.82);
    ctx.quadraticCurveTo(cx, bot - s * 0.74, cx + s * 0.24, bot - s * 0.82);
    ctx.moveTo(cx - s * 0.26, bot - s * 0.62);
    ctx.quadraticCurveTo(cx, bot - s * 0.55, cx + s * 0.26, bot - s * 0.62);
    ctx.stroke();
    /* 头（写实，肤色渐变） */
    var headR = s * 0.2;
    var headY = bot - s * 1.14;
    var skin = ctx.createRadialGradient(cx - headR * 0.3, headY - headR * 0.4, headR * 0.2, cx, headY, headR * 1.2);
    skin.addColorStop(0, '#f0c8a0');
    skin.addColorStop(0.6, '#dca87a');
    skin.addColorStop(1, '#b07a4e');
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(cx, headY, headR, 0, TAU); ctx.fill();
    /* 草帽 */
    var hatY = headY - headR * 0.5;
    ctx.fillStyle = '#c9a06a';
    ctx.beginPath(); ctx.arc(cx, hatY, headR * 1.18, 0, TAU); ctx.fill();
    var hat2 = ctx.createLinearGradient(cx - headR, hatY - headR * 0.3, cx + headR, hatY + headR * 0.3);
    hat2.addColorStop(0, '#d9b87e');
    hat2.addColorStop(1, '#a87e4a');
    ctx.fillStyle = hat2;
    ctx.beginPath();
    ctx.moveTo(cx - headR * 0.9, hatY + headR * 0.05);
    ctx.quadraticCurveTo(cx, hatY - headR * 0.98, cx + headR * 0.9, hatY + headR * 0.05);
    ctx.quadraticCurveTo(cx, hatY + headR * 0.32, cx - headR * 0.9, hatY + headR * 0.05);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(90,60,25,0.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, hatY, headR * 1.18, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(90,60,25,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, hatY, headR * 1.18, -0.4, 0.4); ctx.stroke();
    /* 面部：写实眼眉鼻口 */
    ctx.fillStyle = '#ffffff';
    lellipse(cx - headR * 0.38, headY + headR * 0.05, headR * 0.15, headR * 0.13, 0); ctx.fill();
    lellipse(cx + headR * 0.38, headY + headR * 0.05, headR * 0.15, headR * 0.13, 0); ctx.fill();
    ctx.fillStyle = '#3a2a1a';
    ctx.beginPath(); ctx.arc(cx - headR * 0.36, headY + headR * 0.06, headR * 0.065, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + headR * 0.4, headY + headR * 0.06, headR * 0.065, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(cx - headR * 0.34, headY + headR * 0.02, headR * 0.024, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + headR * 0.42, headY + headR * 0.02, headR * 0.024, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#5a3a1a';
    ctx.lineWidth = headR * 0.09;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - headR * 0.5, headY - headR * 0.24);
    ctx.quadraticCurveTo(cx - headR * 0.35, headY - headR * 0.34, cx - headR * 0.2, headY - headR * 0.26);
    ctx.moveTo(cx + headR * 0.5, headY - headR * 0.24);
    ctx.quadraticCurveTo(cx + headR * 0.35, headY - headR * 0.34, cx + headR * 0.2, headY - headR * 0.26);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(140,90,50,0.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx + headR * 0.02, headY + headR * 0.16);
    ctx.quadraticCurveTo(cx - headR * 0.05, headY + headR * 0.28, cx + headR * 0.05, headY + headR * 0.33);
    ctx.stroke();
    ctx.strokeStyle = '#8a5a3a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx - headR * 0.2, headY + headR * 0.52);
    ctx.quadraticCurveTo(cx, headY + headR * 0.6, cx + headR * 0.2, headY + headR * 0.52);
    ctx.stroke();
    /* 右臂（握镰刀）+ 手 */
    ctx.strokeStyle = '#dca87a';
    ctx.lineWidth = s * 0.095;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.24, bot - s * 0.88);
    ctx.quadraticCurveTo(cx + s * 0.36, bot - s * 0.74, handX, handY);
    ctx.stroke();
    ctx.fillStyle = '#dca87a';
    ctx.beginPath(); ctx.arc(handX, handY, s * 0.07, 0, TAU); ctx.fill();
    ctx.fillStyle = '#c8945a';
    ctx.beginPath(); ctx.arc(handX, handY, s * 0.045, 0, TAU); ctx.fill();
    /* 左臂（自然下垂） */
    ctx.strokeStyle = '#c9b894';
    ctx.lineWidth = s * 0.11;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.27, bot - s * 0.9);
    ctx.quadraticCurveTo(cx - s * 0.42, bot - s * 0.72, cx - s * 0.36, bot - s * 0.52);
    ctx.stroke();
  }

  /* 锄头：老锄头 + 苦瓜脸 */
  function drawHoe(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    /* 木柄 */
    ctx.fillStyle = '#a3743c';
    rr(b.x + b.w * 0.42, b.y, b.w * 0.16, b.h, 4);
    ctx.fill();
    ctx.strokeStyle = '#7a4a26';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    /* 锄刃 */
    ctx.fillStyle = '#7a8794';
    ctx.beginPath();
    ctx.moveTo(b.x + b.w * 0.2, b.y + b.h * 0.52);
    ctx.quadraticCurveTo(b.x + b.w * 0.16, b.y + b.h * 0.18, b.x + b.w * 0.44, b.y + b.h * 0.16);
    ctx.quadraticCurveTo(b.x + b.w * 0.3, b.y + b.h * 0.3, b.x + b.w * 0.44, b.y + b.h * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#5a6470';
    ctx.lineWidth = 2;
    ctx.stroke();
    /* 苦瓜脸 */
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(cx - 8, b.y + 9, 5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 8, b.y + 9, 5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(cx - 8, b.y + 10, 2.4, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 8, b.y + 10, 2.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#20242c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 14, b.y + 3); ctx.lineTo(cx - 4, b.y + 5);
    ctx.moveTo(cx + 14, b.y + 3); ctx.lineTo(cx + 4, b.y + 5);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, b.y + 18, 5, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
  }

  /* 割草机：红色割草机，移动快冲撞建筑 */
  function drawMower(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    /* 车身 */
    ctx.fillStyle = '#d9534f';
    rr(b.x + 3, b.y + 6, b.w - 6, b.h * 0.58, 8);
    ctx.fill();
    ctx.strokeStyle = '#a8322e';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    rr(b.x + 7, b.y + 9, b.w - 14, 8, 4);
    ctx.fill();
    /* 刀片滚筒 */
    ctx.fillStyle = '#4a5568';
    rr(b.x + b.w * 0.1, b.y + b.h * 0.58, b.w * 0.8, b.h * 0.16, 4);
    ctx.fill();
    /* 轮子 */
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(b.x + 14, b.y + b.h * 0.78, 8, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(b.x + b.w - 14, b.y + b.h * 0.78, 8, 0, TAU); ctx.fill();
    ctx.fillStyle = '#9aa5b1';
    ctx.beginPath(); ctx.arc(b.x + 14, b.y + b.h * 0.78, 3.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(b.x + b.w - 14, b.y + b.h * 0.78, 3.5, 0, TAU); ctx.fill();
    /* 前灯 + 愤怒眼 */
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath(); ctx.arc(b.x + b.w - 8, b.y + 16, 3.5, 0, TAU); ctx.fill();
    angryEyes(cx, b.y + 16, b.w * 0.2, '#ffd75e');
    /* 把手 */
    ctx.strokeStyle = '#5a6470';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(b.x + b.w * 0.2, b.y + 8);
    ctx.lineTo(b.x + b.w * 0.04, b.y - 4);
    ctx.stroke();
  }

  /* 内幕猫：戴墨镜的西装猫，躲建筑后偷袭 */
  function drawCat(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var s = Math.min(b.w, b.h);
    /* 尖耳朵 */
    ctx.fillStyle = '#6b7280';
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.34, b.y + 4);
    ctx.lineTo(cx - s * 0.42, b.y - 9);
    ctx.lineTo(cx - s * 0.13, b.y + 2);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.34, b.y + 4);
    ctx.lineTo(cx + s * 0.42, b.y - 9);
    ctx.lineTo(cx + s * 0.13, b.y + 2);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffb6c1';
    ctx.beginPath(); ctx.arc(cx - s * 0.28, b.y - 2, 2.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + s * 0.28, b.y - 2, 2.5, 0, TAU); ctx.fill();
    /* 头 */
    ctx.fillStyle = '#6b7280';
    ellipse(cx, b.y + b.h * 0.16, s * 0.36, s * 0.32);
    ctx.fill();
    /* 身体 */
    ctx.fillStyle = '#585e66';
    ellipse(cx, b.y + b.h * 0.46, s * 0.42, s * 0.34);
    ctx.fill();
    /* 墨镜 */
    ctx.fillStyle = '#1c2230';
    rr(cx - s * 0.4, b.y + b.h * 0.1, s * 0.34, s * 0.15, 3); ctx.fill();
    rr(cx + s * 0.06, b.y + b.h * 0.1, s * 0.34, s * 0.15, 3); ctx.fill();
    ctx.strokeStyle = '#1c2230';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.06, b.y + b.h * 0.17);
    ctx.lineTo(cx + s * 0.06, b.y + b.h * 0.17);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(cx - s * 0.36, b.y + b.h * 0.12, 5, 2.5);
    ctx.fillRect(cx + s * 0.1, b.y + b.h * 0.12, 5, 2.5);
    /* 红领带 */
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.moveTo(cx, b.y + b.h * 0.36);
    ctx.lineTo(cx - 5, b.y + b.h * 0.42);
    ctx.lineTo(cx, b.y + b.h * 0.56);
    ctx.lineTo(cx + 5, b.y + b.h * 0.42);
    ctx.closePath(); ctx.fill();
    /* 尾巴 */
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x + b.w - 2, b.y + b.h * 0.5);
    ctx.quadraticCurveTo(b.x + b.w + 8, b.y + b.h * 0.3, b.x + b.w - 4, b.y + b.h * 0.2);
    ctx.stroke();
  }

  /* 量化狗：写实犬·前爪捧着量化电脑（K线屏） */
  function drawDog(b) {
    var cx = b.x + b.w / 2;
    var bot = b.y + b.h;
    var s = Math.min(b.w, b.h);
    /* —— 笔记本电脑（狗身前） —— */
    var lapW = s * 0.92, lapH = s * 0.3;
    var lapX = cx - lapW / 2, lapY = bot - s * 0.36;
    /* 屏幕边框 */
    var scr = ctx.createLinearGradient(lapX, lapY, lapX + lapW, lapY);
    scr.addColorStop(0, '#2a3a52');
    scr.addColorStop(0.5, '#4a6a92');
    scr.addColorStop(1, '#2a3a52');
    ctx.fillStyle = scr;
    rr(lapX, lapY, lapW, lapH, 3); ctx.fill();
    ctx.strokeStyle = '#1c2634';
    ctx.lineWidth = 1.5;
    rr(lapX, lapY, lapW, lapH, 3); ctx.stroke();
    /* 屏内白底 */
    ctx.fillStyle = '#f2f5f8';
    rr(lapX + 3, lapY + 3, lapW - 6, lapH - 8, 2); ctx.fill();
    /* K 线（A股红涨绿跌） */
    var ky = lapY + 4, kh = lapH - 12;
    var candles = [
      { x: 0.08, o: 0.68, c: 0.5, up: 1 }, { x: 0.2, o: 0.5, c: 0.62, up: -1 },
      { x: 0.32, o: 0.62, c: 0.42, up: 1 }, { x: 0.44, o: 0.42, c: 0.55, up: -1 },
      { x: 0.56, o: 0.55, c: 0.35, up: 1 }, { x: 0.68, o: 0.35, c: 0.48, up: -1 },
      { x: 0.8, o: 0.48, c: 0.28, up: 1 }
    ];
    candles.forEach(function (cd) {
      var cxx = lapX + cd.x * (lapW - 8) + 4;
      var oy = ky + cd.o * kh, cyy = ky + cd.c * kh;
      ctx.strokeStyle = cd.up ? '#d9534f' : '#3f9b3d';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cxx, ky + 2); ctx.lineTo(cxx, ky + kh - 2);
      ctx.stroke();
      ctx.fillStyle = cd.up ? '#d9534f' : '#3f9b3d';
      ctx.fillRect(cxx - 2.4, Math.min(oy, cyy), 4.8, Math.abs(oy - cyy) || 1.5);
    });
    /* 均线 */
    ctx.strokeStyle = 'rgba(255,180,40,0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(lapX + 5, ky + 0.5 * kh);
    ctx.quadraticCurveTo(lapX + lapW * 0.35, ky + 0.28 * kh, lapX + lapW * 0.65, ky + 0.45 * kh);
    ctx.quadraticCurveTo(lapX + lapW * 0.85, ky + 0.55 * kh, lapX + lapW - 5, ky + 0.3 * kh);
    ctx.stroke();
    /* 键盘底座 */
    ctx.fillStyle = '#3a434d';
    rr(lapX - 3, lapY + lapH - 1, lapW + 6, s * 0.13, 2); ctx.fill();
    ctx.fillStyle = '#4a5568';
    for (var kc = 0; kc < 6; kc++) {
      ctx.fillRect(lapX + 5 + kc * ((lapW - 10) / 6), lapY + lapH + 3, (lapW - 16) / 6, s * 0.06);
    }
    /* —— 狗 —— */
    /* 后腿 */
    ctx.fillStyle = '#4a4038';
    rr(cx - s * 0.34, bot - s * 0.28, s * 0.15, s * 0.28, 4); ctx.fill();
    rr(cx + s * 0.19, bot - s * 0.28, s * 0.15, s * 0.28, 4); ctx.fill();
    /* 身体（背深腹浅的毛色渐变） */
    var bodyG = ctx.createLinearGradient(0, bot - s * 0.95, 0, bot - s * 0.3);
    bodyG.addColorStop(0, '#544a42');
    bodyG.addColorStop(0.5, '#7a6e62');
    bodyG.addColorStop(1, '#b0a496');
    ctx.fillStyle = bodyG;
    rr(cx - s * 0.36, bot - s * 0.95, s * 0.72, s * 0.66, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(40,35,30,0.4)';
    ctx.lineWidth = 1;
    rr(cx - s * 0.36, bot - s * 0.95, s * 0.72, s * 0.66, 10); ctx.stroke();
    /* 皮毛纹理（短毛走向） */
    ctx.strokeStyle = 'rgba(40,35,30,0.3)';
    ctx.lineWidth = 1;
    for (var f = 0; f < 6; f++) {
      var fx = cx - s * 0.28 + f * s * 0.1;
      ctx.beginPath();
      ctx.moveTo(fx, bot - s * 0.9);
      ctx.quadraticCurveTo(fx + s * 0.03, bot - s * 0.6, fx - s * 0.02, bot - s * 0.36);
      ctx.stroke();
    }
    /* 前腿（搭在电脑两侧） */
    ctx.fillStyle = '#6a5f52';
    rr(cx - s * 0.3, bot - s * 0.5, s * 0.14, s * 0.26, 4); ctx.fill();
    rr(cx + s * 0.16, bot - s * 0.5, s * 0.14, s * 0.26, 4); ctx.fill();
    /* 爪 */
    ctx.fillStyle = '#3a342e';
    rr(cx - s * 0.3, bot - s * 0.27, s * 0.14, s * 0.05, 2); ctx.fill();
    rr(cx + s * 0.16, bot - s * 0.27, s * 0.14, s * 0.05, 2); ctx.fill();
    /* 头（写实犬头，侧向） */
    var hx = cx + s * 0.42, hy = bot - s * 0.94;
    var headG = ctx.createLinearGradient(hx - s * 0.2, 0, hx + s * 0.25, 0);
    headG.addColorStop(0, '#544a42');
    headG.addColorStop(1, '#8a7e70');
    ctx.fillStyle = headG;
    ctx.beginPath(); ctx.arc(hx, hy, s * 0.21, 0, TAU); ctx.fill();
    /* 吻部 */
    ctx.fillStyle = '#a89c8c';
    rr(hx + s * 0.01, hy + s * 0.03, s * 0.24, s * 0.15, 5); ctx.fill();
    /* 鼻头 */
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(hx + s * 0.25, hy + s * 0.06, s * 0.05, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.arc(hx + s * 0.235, hy + s * 0.035, s * 0.015, 0, TAU); ctx.fill();
    /* 嘴线 */
    ctx.strokeStyle = 'rgba(60,45,35,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx + s * 0.2, hy + s * 0.13);
    ctx.lineTo(hx + s * 0.02, hy + s * 0.13);
    ctx.stroke();
    /* 眼睛（写实） */
    ctx.fillStyle = '#ffffff';
    lellipse(hx + s * 0.02, hy - s * 0.05, s * 0.07, s * 0.06, 0); ctx.fill();
    ctx.fillStyle = '#2a1c10';
    ctx.beginPath(); ctx.arc(hx + s * 0.045, hy - s * 0.05, s * 0.032, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(hx + s * 0.05, hy - s * 0.065, s * 0.012, 0, TAU); ctx.fill();
    /* 立耳 */
    ctx.fillStyle = '#544a42';
    ctx.beginPath();
    ctx.moveTo(hx - s * 0.13, hy - s * 0.15);
    ctx.lineTo(hx - s * 0.12, hy - s * 0.36);
    ctx.lineTo(hx + s * 0.02, hy - s * 0.17);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#7a6e62';
    ctx.beginPath();
    ctx.moveTo(hx - s * 0.1, hy - s * 0.17);
    ctx.lineTo(hx - s * 0.09, hy - s * 0.3);
    ctx.lineTo(hx - s * 0.01, hy - s * 0.18);
    ctx.closePath(); ctx.fill();
    /* 项圈 */
    ctx.strokeStyle = '#a83a2a';
    ctx.lineWidth = s * 0.06;
    ctx.beginPath();
    ctx.moveTo(hx - s * 0.19, hy + s * 0.13);
    ctx.quadraticCurveTo(hx, hy + s * 0.23, hx + s * 0.21, hy + s * 0.15);
    ctx.stroke();
    /* 尾巴（上翘） */
    ctx.strokeStyle = '#544a42';
    ctx.lineWidth = s * 0.1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.34, bot - s * 0.74);
    ctx.quadraticCurveTo(cx - s * 0.54, bot - s * 0.86, cx - s * 0.5, bot - s * 1.02);
    ctx.stroke();
  }

  /* 游资大鳄：西装鳄鱼，血厚吐子弹 */
  function drawCaiman(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var s = Math.min(b.w, b.h);
    /* 长吻 */
    ctx.fillStyle = '#2f8f5b';
    rr(cx - s * 0.5, b.y + b.h * 0.18, s * 1.0, s * 0.2, 6);
    ctx.fill();
    /* 牙齿 */
    ctx.fillStyle = '#ffffff';
    for (var i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.38 + i * s * 0.19, b.y + b.h * 0.38);
      ctx.lineTo(cx - s * 0.33 + i * s * 0.19, b.y + b.h * 0.38 + 5);
      ctx.lineTo(cx - s * 0.28 + i * s * 0.19, b.y + b.h * 0.38);
      ctx.closePath();
      ctx.fill();
    }
    /* 身体 */
    ctx.fillStyle = '#2f8f5b';
    ellipse(cx, b.y + b.h * 0.5, s * 0.4, s * 0.32);
    ctx.fill();
    ctx.strokeStyle = '#1e5a38';
    ctx.lineWidth = 2;
    ctx.stroke();
    /* 背刺 */
    ctx.fillStyle = '#256e46';
    ctx.beginPath();
    ctx.moveTo(cx - 6, b.y + b.h * 0.24);
    ctx.lineTo(cx, b.y + b.h * 0.16);
    ctx.lineTo(cx + 6, b.y + b.h * 0.24);
    ctx.closePath(); ctx.fill();
    /* 眼睛 */
    angryEyes(cx, b.y + b.h * 0.14, s * 0.18, '#ff5f4f');
    /* 西装领 + 领带 */
    ctx.fillStyle = '#20242c';
    ctx.beginPath();
    ctx.moveTo(cx - 10, b.y + b.h * 0.38);
    ctx.lineTo(cx, b.y + b.h * 0.52);
    ctx.lineTo(cx + 10, b.y + b.h * 0.38);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(cx - 3, b.y + b.h * 0.44, 6, 12);
    /* 公文包 */
    ctx.fillStyle = '#5a3a1e';
    rr(b.x + b.w - 24, b.y + b.h * 0.66, 18, 14, 3);
    ctx.fill();
    ctx.strokeStyle = '#3d2613';
    ctx.lineWidth = 1.5;
    rr(b.x + b.w - 24, b.y + b.h * 0.66, 18, 14, 3);
    ctx.stroke();
  }

  /* 量化庄：八爪机械章鱼，触手拆建筑 */
  function drawQuant(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var s = Math.min(b.w, b.h);
    /* 触手 */
    ctx.strokeStyle = '#7c5cbf';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (var i = 0; i < 6; i++) {
      var a = -Math.PI * 0.8 + (i / 5) * Math.PI * 1.6;
      var tx = cx + Math.cos(a) * s * 0.5;
      var ty = b.y + b.h * 0.82 + Math.sin(G.time * 3 + i * 2) * 3;
      ctx.beginPath();
      ctx.moveTo(cx, b.y + b.h * 0.55);
      ctx.quadraticCurveTo(cx + Math.cos(a) * s * 0.28, b.y + b.h * 0.72, tx, ty);
      ctx.stroke();
    }
    /* 穹顶头部 */
    ctx.fillStyle = '#7c5cbf';
    ellipse(cx, b.y + b.h * 0.38, s * 0.42, s * 0.36);
    ctx.fill();
    ctx.strokeStyle = '#5a3f96';
    ctx.lineWidth = 2;
    ctx.stroke();
    /* 机械贴片 */
    ctx.fillStyle = '#5a3f96';
    ctx.beginPath(); ctx.arc(cx, b.y + b.h * 0.2, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = '#9a7cdb';
    ctx.beginPath(); ctx.arc(cx, b.y + b.h * 0.2, 3, 0, TAU); ctx.fill();
    /* 眼睛 */
    angryEyes(cx, b.y + b.h * 0.34, s * 0.18, '#ff5f4f');
    /* 胸口迷你 K 线屏 */
    ctx.fillStyle = '#1c2230';
    rr(cx - 10, b.y + b.h * 0.52, 20, 12, 3);
    ctx.fill();
    ctx.strokeStyle = '#7dfa9c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 7, b.y + b.h * 0.58);
    ctx.lineTo(cx - 2, b.y + b.h * 0.55);
    ctx.lineTo(cx + 2, b.y + b.h * 0.58);
    ctx.lineTo(cx + 7, b.y + b.h * 0.52);
    ctx.stroke();
  }

  /* 山顶老怪：会移动的西式庄园，戴高礼帽举金色镰刀权杖 */
  function drawWhiteHouse(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var s = Math.min(b.w, b.h);
    var bob = Math.sin(G.time * 1.4) * 2;   /* 缓慢逼近的呼吸感 */
    ctx.save();
    ctx.translate(0, bob);
    /* 铜板地基 */
    ctx.fillStyle = '#8a6a3a';
    rr(b.x + 2, b.y + b.h * 0.84, b.w - 4, b.h * 0.16, 3);
    ctx.fill();
    ctx.fillStyle = '#c9a06a';
    for (var c2 = 0; c2 < 6; c2++) {
      ctx.beginPath();
      ctx.arc(b.x + 10 + c2 * (b.w - 20) / 5, b.y + b.h * 0.9, 3, 0, TAU);
      ctx.fill();
    }
    /* 墙体 */
    ctx.fillStyle = '#f5f1e8';
    rr(b.x + 6, b.y + b.h * 0.22, b.w - 12, b.h * 0.64, 4);
    ctx.fill();
    ctx.strokeStyle = '#c9c2b2';
    ctx.lineWidth = 2;
    ctx.stroke();
    /* 砖线 */
    ctx.strokeStyle = 'rgba(201,194,178,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(b.x + 8, b.y + b.h * 0.42);
    ctx.lineTo(b.x + b.w - 8, b.y + b.h * 0.42);
    ctx.moveTo(b.x + 8, b.y + b.h * 0.62);
    ctx.lineTo(b.x + b.w - 8, b.y + b.h * 0.62);
    ctx.stroke();
    /* 三角屋顶 */
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.moveTo(b.x + 2, b.y + b.h * 0.24);
    ctx.lineTo(cx, b.y + 2);
    ctx.lineTo(b.x + b.w - 2, b.y + b.h * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#8a2f26';
    ctx.lineWidth = 2;
    ctx.stroke();
    /* 金门柱 */
    ctx.fillStyle = '#ffd75e';
    ctx.fillRect(cx - 15, b.y + b.h * 0.6, 11, b.h * 0.26);
    ctx.fillRect(cx + 4, b.y + b.h * 0.6, 11, b.h * 0.26);
    /* 窗户脸 */
    ctx.fillStyle = '#fff8ec';
    rr(cx - 23, b.y + b.h * 0.3, 19, 19, 4); ctx.fill();
    rr(cx + 4, b.y + b.h * 0.3, 19, 19, 4); ctx.fill();
    ctx.strokeStyle = '#a89a80';
    ctx.lineWidth = 2;
    rr(cx - 23, b.y + b.h * 0.3, 19, 19, 4); ctx.stroke();
    rr(cx + 4, b.y + b.h * 0.3, 19, 19, 4); ctx.stroke();
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(cx - 13.5, b.y + b.h * 0.34, 3.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 13.5, b.y + b.h * 0.34, 3.2, 0, TAU); ctx.fill();
    /* 愤怒窗眉 */
    ctx.strokeStyle = '#20242c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - 25, b.y + b.h * 0.24);
    ctx.lineTo(cx - 13, b.y + b.h * 0.31);
    ctx.moveTo(cx + 25, b.y + b.h * 0.24);
    ctx.lineTo(cx + 13, b.y + b.h * 0.31);
    ctx.stroke();
    /* 嘴（大门） */
    ctx.fillStyle = '#8a2f26';
    rr(cx - 9, b.y + b.h * 0.52, 18, 13, 5);
    ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath(); ctx.arc(cx, b.y + b.h * 0.62, 2.5, 0, TAU); ctx.fill();
    /* 高礼帽 */
    ctx.fillStyle = '#20242c';
    rr(cx - 17, b.y + 2, 34, 22, 3);
    ctx.fill();
    ctx.fillStyle = '#2d3748';
    rr(cx - 25, b.y + 20, 50, 6, 3);
    ctx.fill();
    ctx.fillStyle = '#ffd75e';
    rr(cx - 17, b.y + 13, 34, 4, 2);
    ctx.fill();
    /* 金色镰刀权杖 */
    ctx.strokeStyle = '#d4a017';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(b.x + b.w - 10, b.y + b.h * 0.84);
    ctx.lineTo(b.x + b.w - 2, b.y + b.h * 0.3);
    ctx.stroke();
    ctx.strokeStyle = '#e8c24a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(b.x + b.w - 13, b.y + b.h * 0.27, 12, Math.PI * 0.75, Math.PI * 1.95);
    ctx.stroke();
    ctx.restore();
  }

  /* 召唤单位：无人机 / 小战机 */
  function drawDroneUnit(d) {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.translate(0, Math.sin(G.time * 8 + d.x * 0.2) * 1.5);
    ctx.globalAlpha = clamp(d.life / d.maxLife, 0, 1);
    if (d.kind === 'drone') {
      /* 空天母舰无人机：菱形机身 + 旋转旋翼 */
      ctx.fillStyle = '#c8d4e0';
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(8, 0);
      ctx.lineTo(0, 7);
      ctx.lineTo(-8, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#5a6470';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#ff5f4f';
      ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, TAU); ctx.fill();
      ctx.save();
      ctx.translate(0, -7);
      ctx.rotate(G.time * 18);
      ctx.strokeStyle = 'rgba(200,212,224,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-9, 0); ctx.lineTo(9, 0);
      ctx.stroke();
      ctx.restore();
    } else {
      /* 航母小战机 */
      ctx.fillStyle = '#d9534f';
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(7, 4);
      ctx.lineTo(0, 1);
      ctx.lineTo(-7, 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffd75e';
      ctx.beginPath(); ctx.arc(0, -1, 2, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function drawBear(b, isBoss) {
    var cx = b.x + b.w / 2;
    var cy = b.y + b.h / 2;
    var bodyR = b.w * 0.42;
    var bodyC = isBoss ? '#7a4c22' : '#8b5a2b';
    var edgeC = isBoss ? '#4e2f12' : '#5f3b18';
    /* 耳朵 */
    ctx.fillStyle = bodyC;
    ctx.beginPath(); ctx.arc(cx - bodyR * 0.55, b.y + bodyR * 0.28, bodyR * 0.28, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + bodyR * 0.55, b.y + bodyR * 0.28, bodyR * 0.28, 0, TAU); ctx.fill();
    ctx.fillStyle = '#d9b381';
    ctx.beginPath(); ctx.arc(cx - bodyR * 0.55, b.y + bodyR * 0.28, bodyR * 0.13, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + bodyR * 0.55, b.y + bodyR * 0.28, bodyR * 0.13, 0, TAU); ctx.fill();
    /* 身体 */
    ellipse(cx, cy + bodyR * 0.08, bodyR, bodyR * 1.06);
    ctx.fillStyle = bodyC; ctx.fill();
    ctx.strokeStyle = edgeC; ctx.lineWidth = 2.5; ctx.stroke();
    /* 肚皮徽章 */
    ctx.fillStyle = '#fff8ec';
    ctx.beginPath(); ctx.arc(cx, cy + bodyR * 0.45, bodyR * 0.42, 0, TAU); ctx.fill();
    ctx.strokeStyle = edgeC; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = isBoss ? '#b3352b' : '#d33';
    ctx.font = 'bold ' + Math.max(12, bodyR * 0.42) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(isBoss ? '庄' : '空', cx, cy + bodyR * 0.45 + 1);
    /* 脸 */
    var fy = b.y + bodyR * 0.62;
    ctx.fillStyle = '#d9b381';
    ellipse(cx, fy, bodyR * 0.5, bodyR * 0.4); ctx.fill();
    ctx.fillStyle = '#20242c';
    ellipse(cx, fy - bodyR * 0.06, bodyR * 0.16, bodyR * 0.12); ctx.fill();
    /* 眼睛 + 怒眉 */
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(cx - bodyR * 0.34, fy - bodyR * 0.34, bodyR * 0.17, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + bodyR * 0.34, fy - bodyR * 0.34, bodyR * 0.17, 0, TAU); ctx.fill();
    ctx.fillStyle = '#20242c';
    ctx.beginPath(); ctx.arc(cx - bodyR * 0.34, fy - bodyR * 0.3, bodyR * 0.07, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + bodyR * 0.34, fy - bodyR * 0.3, bodyR * 0.07, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#20242c';
    ctx.lineWidth = Math.max(2, bodyR * 0.09);
    ctx.beginPath();
    ctx.moveTo(cx - bodyR * 0.6, fy - bodyR * 0.62);
    ctx.lineTo(cx - bodyR * 0.12, fy - bodyR * 0.4);
    ctx.moveTo(cx + bodyR * 0.6, fy - bodyR * 0.62);
    ctx.lineTo(cx + bodyR * 0.12, fy - bodyR * 0.4);
    ctx.stroke();
    /* 嘴 */
    ctx.beginPath();
    ctx.moveTo(cx - bodyR * 0.14, fy + bodyR * 0.26);
    ctx.quadraticCurveTo(cx, fy + bodyR * 0.14, cx + bodyR * 0.14, fy + bodyR * 0.26);
    ctx.stroke();
    if (isBoss) {
      /* 皇冠 */
      ctx.fillStyle = '#ffd75e';
      ctx.strokeStyle = '#c98a1f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - bodyR * 0.42, b.y + bodyR * 0.22);
      ctx.lineTo(cx - bodyR * 0.42, b.y - 4);
      ctx.lineTo(cx - bodyR * 0.14, b.y + bodyR * 0.1);
      ctx.lineTo(cx, b.y - 7);
      ctx.lineTo(cx + bodyR * 0.14, b.y + bodyR * 0.1);
      ctx.lineTo(cx + bodyR * 0.42, b.y - 4);
      ctx.lineTo(cx + bodyR * 0.42, b.y + bodyR * 0.22);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.arc(cx, b.y - 4, 3.4, 0, TAU); ctx.fill();
      /* 雪茄 */
      ctx.strokeStyle = '#5a3a1e';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + bodyR * 0.3, fy + bodyR * 0.18);
      ctx.lineTo(cx + bodyR * 0.72, fy + bodyR * 0.18);
      ctx.stroke();
      var smoke = 0.5 + 0.5 * Math.sin(G.time * 5);
      ctx.fillStyle = 'rgba(200,200,210,' + (0.25 + smoke * 0.3) + ')';
      ctx.beginPath(); ctx.arc(cx + bodyR * 0.76, fy + bodyR * 0.1, 2 + smoke * 2, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + bodyR * 0.85, fy + bodyR * 0.02, 1.5 + smoke * 1.5, 0, TAU); ctx.fill();
    }
  }

  function drawHpBar(b) {
    var w = Math.min(b.w, 52);
    var x = b.x + b.w / 2 - w / 2;
    var y = b.y - 12;
    ctx.fillStyle = 'rgba(20,24,32,0.55)';
    rr(x, y, w, 6, 3); ctx.fill();
    var p = clamp(b.hp / b.maxHp, 0, 1);
    ctx.fillStyle = p > 0.5 ? '#5ee06e' : (p > 0.25 ? '#ffd75e' : '#ff5f4f');
    if (p > 0) { rr(x + 1, y + 1, (w - 2) * p, 4, 2); ctx.fill(); }
  }

  /* ====================== 渲染：世界 ====================== */
  function drawWorld() {
    /* 方块（先画非敌人的，再画敌人） */
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < G.blocks.length; i++) {
        var b = G.blocks[i];
        if (b.dead) continue;
        if ((pass === 0 && !b.enemy) || (pass === 1 && b.enemy)) drawBlock(b);
      }
    }
    /* 弹弓 + 装填韭菜 */
    var loaded = null;
    if (G.state === 'PLAY' && !G.activeLeek && G.shotsLeft > 0) {
      loaded = { x: SX - G.dragVec.x, y: SY - LAUNCH_OFF - G.dragVec.y };
    }
    drawSlingshot(loaded);
    if (loaded) {
      var squash = G.dragging ? 1.08 : 1;
      var pop = 1 + G.reloadPop * 0.25;
      drawLeek(loaded.x, loaded.y, LEEK_R * pop, G.dragging ? -0.35 : 0, squash, 1, { weapon: G.weapon, flower: G.gender === 'female' });
    }
    /* 飞行韭菜 */
    for (i = 0; i < G.projectiles.length; i++) {
      var p = G.projectiles[i];
      if (p.dead) continue;
      if (p.trail.length > 1) {
        for (var t2 = 0; t2 < p.trail.length; t2++) {
          var tr = p.trail[t2];
          ctx.fillStyle = 'rgba(255,255,255,' + (0.28 * (t2 / p.trail.length)) + ')';
          ctx.beginPath();
          ctx.arc(tr.x, tr.y, LEEK_R * (t2 / p.trail.length) * 0.8, 0, TAU);
          ctx.fill();
        }
      }
      if (!p.fading) drawLeek(p.x, p.y, p.r, p.ang, 1, 1, { weapon: p.weapon, flower: G.gender === 'female' });
      else drawLeek(p.x, p.y, p.r, p.ang, 1, p.alpha, { weapon: p.weapon, flower: G.gender === 'female' });
    }
    /* 分裂弹 */
    for (i = 0; i < G.minis.length; i++) {
      var mn = G.minis[i];
      ctx.save();
      ctx.translate(mn.x, mn.y);
      ctx.globalAlpha = clamp(mn.life / mn.maxLife, 0, 1);
      if (mn.kind === 'petal') {
        ctx.fillStyle = '#7ddb8a';
        ctx.beginPath();
        for (var pk = 0; pk < 5; pk++) {
          var pa = pk * TAU / 5 + G.time;
          var pr = 5;
          if (pk === 0) ctx.moveTo(Math.cos(pa) * pr, Math.sin(pa) * pr);
          else ctx.lineTo(Math.cos(pa) * pr, Math.sin(pa) * pr);
        }
        ctx.closePath(); ctx.fill();
      } else if (mn.kind === 'bullet') {
        /* v7：机关枪弹雨——黄色曳光弹 */
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath(); ctx.arc(0, 0, mn.r, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#ff9d3a';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(0, 0, mn.r + 1.5, 0, TAU); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.arc(-mn.r * 0.3, -mn.r * 0.3, mn.r * 0.35, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = '#fff3dc';
        ctx.beginPath(); ctx.arc(0, 0, mn.r, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#d9b381';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }
    /* 无人机/母舰 */
    for (i = 0; i < G.drones.length; i++) {
      var dn = G.drones[i];
      drawDroneUnit(dn);
    }
    /* 激光光束 */
    for (i = 0; i < G.beams.length; i++) {
      var bm = G.beams[i];
      var ba = clamp(bm.life / bm.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = ba;
      ctx.strokeStyle = bm.color;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = bm.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(bm.x1, bm.y1);
      ctx.lineTo(bm.x2, bm.y2);
      ctx.stroke();
      ctx.restore();
    }
    /* v7：敌人镰刀激光球 */
    for (i = 0; i < G.enemyFire.length; i++) {
      var fb2 = G.enemyFire[i];
      var fa = clamp(fb2.life / fb2.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = fa;
      /* 外圈红光 */
      ctx.fillStyle = 'rgba(255,70,90,0.28)';
      ctx.beginPath(); ctx.arc(fb2.x, fb2.y, 13, 0, TAU); ctx.fill();
      /* 弹核 */
      var fg = ctx.createRadialGradient(fb2.x - 3, fb2.y - 3, 1, fb2.x, fb2.y, 8);
      fg.addColorStop(0, '#ffffff');
      fg.addColorStop(0.5, '#ff8a9a');
      fg.addColorStop(1, '#ff3b52');
      ctx.fillStyle = fg;
      ctx.beginPath(); ctx.arc(fb2.x, fb2.y, 6.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(fb2.x, fb2.y, 6.5, 0, TAU); ctx.stroke();
      ctx.restore();
    }
    /* 金币 */
    for (i = 0; i < G.coins.length; i++) {
      var c = G.coins[i];
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = '#ffd54a';
      ctx.beginPath(); ctx.arc(0, 0, 7.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#c98a1f'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#a05a10';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('¥', 0, 0.5);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(-2.4, -2.4, 1.8, 0, TAU); ctx.fill();
      ctx.restore();
    }
    /* 粒子 */
    for (i = 0; i < G.particles.length; i++) {
      var pa = G.particles[i];
      ctx.globalAlpha = clamp(pa.life / pa.maxLife, 0, 1);
      ctx.fillStyle = pa.color;
      if (pa.type === 'circle') {
        ctx.beginPath(); ctx.arc(pa.x, pa.y, pa.size * 0.6, 0, TAU); ctx.fill();
      } else {
        ctx.save();
        ctx.translate(pa.x, pa.y);
        ctx.rotate(pa.rot);
        ctx.fillRect(-pa.size / 2, -pa.size / 2, pa.size, pa.size);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    /* 轨迹预览 */
    if (G.dragging && G.state === 'PLAY') drawTrajectory();
    /* 飘字 */
    for (i = 0; i < G.texts.length; i++) {
      var t = G.texts[i];
      ctx.globalAlpha = clamp(t.life / t.maxLife, 0, 1);
      ctx.font = 'bold ' + t.size + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 4;
      ctx.strokeText(t.txt, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.txt, t.x, t.y);
      ctx.globalAlpha = 1;
    }
    /* 休息的韭菜残留 */
    for (i = 0; i < G.projectiles.length; i++) {
      var rp2 = G.projectiles[i];
      if (rp2.fading) {
        ctx.globalAlpha = clamp(rp2.alpha, 0, 1) * 0.4;
        drawLeek(rp2.x, rp2.y, rp2.r * 0.9, 0.1, 1, 1, { weapon: rp2.weapon, noPhoto: true });
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawTrajectory() {
    var v = G.dragVec;
    var len = Math.sqrt(v.x * v.x + v.y * v.y);
    if (len < 1) return;
    /* v7：直线弹道预览（无重力，与 launchLeek 完全一致） */
    var vx = v.x / len * AIM_SPEED, vy = v.y / len * AIM_SPEED;
    var x = SX, y = SY - LAUNCH_OFF;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    var r = LEEK_R;
    var DT = 1 / 34;
    for (var i = 0; i < 60; i++) {
      x += vx * DT;
      y += vy * DT;
      /* 命中检测（含半径）：让轨迹提示与实际飞行一致 */
      var blocked = false;
      for (var j = 0; j < G.blocks.length; j++) {
        var b = G.blocks[j];
        if (b.dead) continue;
        var ccx = clamp(x, b.x, b.x + b.w);
        var ccy = clamp(y, b.y, b.y + b.h);
        var ddx = x - ccx, ddy = y - ccy;
        if (ddx * ddx + ddy * ddy < r * r) { blocked = true; break; }
      }
      if (blocked) { drawImpactMark(x, y); break; }
      /* v7.7：轨迹点加密——每个采样点都画（原 i%2 隔一个），点距更小更密集 */
      ctx.beginPath();
      ctx.arc(x, y, 2.8, 0, TAU);
      ctx.fill();
      if (y > GROUND_Y - 6 || x < -20 || x > W + 20 || y < -320) break;
    }
  }

  function drawImpactMark(x, y) {
    ctx.strokeStyle = 'rgba(255,215,94,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6);
    ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6);
    ctx.stroke();
  }

  /* ====================== 渲染：HUD（v2 质感升级） ====================== */
  function drawHud() {
    /* 毛玻璃顶栏 */
    ctx.fillStyle = 'rgba(16,24,36,0.55)';
    rr(0, 0, W, 62, 0);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, 58, W, 4);
    /* 关卡名 */
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 4;
    ctx.fillText(G.levelName, 14, 20);
    ctx.shadowBlur = 0;
    /* 当前武器小图标 */
    var wdef = WEAPONS[G.weapon];
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath(); ctx.arc(24, 43, 11, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((wdef ? wdef.name.charAt(0) : '韭'), 24, 44);
    /* 剩余发射图标 */
    for (var i = 0; i < G.shotsLeft; i++) {
      drawLeek(46 + i * 17, 43, 7, 0, 1, 1, { weapon: G.weapon, noPhoto: true });
    }
    /* 收益（金币徽章） */
    ctx.fillStyle = 'rgba(255,215,94,0.18)';
    ctx.beginPath(); ctx.arc(W * 0.55 - 42, 29, 12, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,215,94,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(W * 0.55 - 42, 29, 12, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#ffd75e';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('¥', W * 0.55 - 42, 30);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('' + G.score, W * 0.55 - 26, 30);
    /* v7：主角 HP 心形条（12 颗，受伤时闪烁） */
    for (var hi = 0; hi < 12; hi++) {
      var hx = W * 0.55 + 30 + hi * 13.5;
      var hy = 50;
      var full = hi < G.hp;
      ctx.save();
      ctx.translate(hx, hy);
      ctx.scale(0.6, 0.6);
      ctx.rotate(Math.sin(G.time * 2 + hi) * 0.05);
      ctx.fillStyle = full ? '#ff5f6e' : 'rgba(255,255,255,0.18)';
      if (full && G.hurtT > 0 && hi >= G.hp - 1) {
        var pulseH = 0.5 + 0.5 * Math.sin(G.time * 22);
        ctx.globalAlpha = 0.55 + pulseH * 0.45;
      }
      ctx.beginPath();
      ctx.moveTo(0, 4.5);
      ctx.bezierCurveTo(-6.5, -2.5, -3.5, -8.5, 0, -4);
      ctx.bezierCurveTo(3.5, -8.5, 6.5, -2.5, 0, 4.5);
      ctx.fill();
      if (full) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.arc(-1.6, -3.2, 1.5, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
    /* 按钮：静音 / 菜单 / 重开（仅游戏进行中；结算面板用面板自己的按钮） */
    if (G.state === 'PLAY') {
      var btns = [];
      btns.push(makeButton(W - 100, 16, 28, 28, '', 'mute', 'icon'));
      btns.push(makeButton(W - 62, 16, 28, 28, '', 'menu', 'icon'));
      btns.push(makeButton(W - 24, 16, 28, 28, '', 'restart', 'icon'));
      G.uiButtons = btns;
      drawIconBtn(W - 86, 30, 10, 'mute');
      drawIconBtn(W - 48, 30, 10, 'menu');
      drawIconBtn(W - 10, 30, 10, 'restart');
    }
    /* 提示 */
    if (G.hintTimer < 2.5 && G.level === 0) {
      var a = 0.6 + 0.4 * Math.sin(G.time * 3);
      ctx.globalAlpha = clamp(1 - G.hintTimer / 2.5, 0, 1) * a;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 6;
      ctx.fillText(LEVELS[0].hint, W / 2, H - 96);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  function drawIconBtn(x, y, r, type) {
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.arc(x, y, r + 4, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    if (type === 'mute') {
      ctx.beginPath();
      ctx.moveTo(x - r * 0.55, y - 2);
      ctx.lineTo(x - r * 0.2, y - 2);
      ctx.lineTo(x + r * 0.15, y - r * 0.5);
      ctx.lineTo(x + r * 0.15, y + r * 0.5);
      ctx.lineTo(x - r * 0.2, y + 2);
      ctx.lineTo(x - r * 0.55, y + 2);
      ctx.closePath();
      ctx.stroke();
      if (G.muted) {
        ctx.beginPath();
        ctx.moveTo(x - r * 0.55, y - r * 0.55);
        ctx.lineTo(x + r * 0.55, y + r * 0.55);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x + r * 0.15, y, r * 0.4, -0.7, 0.7);
        ctx.stroke();
      }
    } else if (type === 'menu') {
      ctx.beginPath();
      ctx.moveTo(x - r * 0.6, y - r * 0.35);
      ctx.lineTo(x, y - r * 0.7);
      ctx.lineTo(x + r * 0.6, y - r * 0.35);
      ctx.moveTo(x - r * 0.6, y - r * 0.05);
      ctx.lineTo(x + r * 0.6, y - r * 0.05);
      ctx.moveTo(x - r * 0.6, y + r * 0.25);
      ctx.lineTo(x + r * 0.6, y + r * 0.25);
      ctx.moveTo(x - r * 0.6, y + r * 0.55);
      ctx.lineTo(x + r * 0.6, y + r * 0.55);
      ctx.stroke();
    } else if (type === 'restart') {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.62, -1.2, Math.PI * 1.1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + r * 0.62, y - r * 0.15);
      ctx.lineTo(x + r * 0.62, y + r * 0.28);
      ctx.lineTo(x + r * 0.28, y + r * 0.28);
      ctx.stroke();
    }
  }

  /* ====================== 渲染：菜单（v2 质感升级） ====================== */
  function drawMenu() {
    drawSky();
    drawGround(false);
    drawSlingshot(null);
    /* 飘落韭菜叶粒子 */
    for (var li = 0; li < 9; li++) {
      var lx = (hash01(li * 9.1) * W + G.time * (14 + hash01(li) * 20)) % W;
      var ly = (hash01(li * 4.7) * H * 0.8 + G.time * (30 + hash01(li * 2) * 26)) % (H * 0.85);
      var lr = 3 + hash01(li * 6.3) * 3;
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(G.time * 1.4 + li);
      ctx.fillStyle = 'rgba(80,170,70,0.35)';
      lellipse(0, 0, lr, lr * 0.45, 0);
      ctx.fill();
      ctx.restore();
    }
    /* 标题（艺术字：描边 + 渐变 + 光晕） */
    ctx.save();
    ctx.translate(W / 2, H * 0.11);
    ctx.rotate(Math.sin(G.time * 1.2) * 0.015);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(30,80,30,0.8)';
    ctx.shadowBlur = 18;
    ctx.font = 'bold 48px sans-serif';
    ctx.strokeStyle = 'rgba(35,70,20,0.95)';
    ctx.lineWidth = 10;
    ctx.strokeText('愤怒的韭菜', 0, 0);
    var tg = ctx.createLinearGradient(0, -28, 0, 28);
    tg.addColorStop(0, '#b8ff9a');
    tg.addColorStop(0.45, '#6ee25c');
    tg.addColorStop(1, '#1f8a3a');
    ctx.fillStyle = tg;
    ctx.fillText('愤怒的韭菜', 0, 0);
    ctx.shadowBlur = 0;
    /* 高光描边 */
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.strokeText('愤怒的韭菜', 0, 1);
    ctx.font = 'bold 17px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(40,70,30,0.7)';
    ctx.lineWidth = 4;
    ctx.strokeText('从山脚韭菜地，一路打到山顶城堡！', 0, 40);
    ctx.fillText('从山脚韭菜地，一路打到山顶城堡！', 0, 40);
    ctx.restore();
    /* ===== 选择战士（男 / 女） ===== */
    var pickY = H * 0.30, pickH = H * 0.19;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(40,70,30,0.6)';
    ctx.lineWidth = 3;
    ctx.font = 'bold 15px sans-serif';
    ctx.strokeText('选择你的战士', W / 2, pickY - 30);
    ctx.fillText('选择你的战士', W / 2, pickY - 30);
    var cardW = W * 0.36, cardH = pickH;
    var maleX = W / 2 - cardW - 14, femaleX = W / 2 + 14;
    var maleBtn = makeButton(maleX, pickY, cardW, cardH, '', 'genderMale', 'gender');
    var femaleBtn = makeButton(femaleX, pickY, cardW, cardH, '', 'genderFemale', 'gender');
    /* 换头像按钮（标题右侧：微信选相册 / 浏览器粘贴 URL） */
    var avBtnW = 92, avBtnH = 24;
    var avBtnX = W / 2 + 68, avBtnY = pickY - 42;
    var avBtn = makeButton(avBtnX, avBtnY, avBtnW, avBtnH, '', 'avatar', 'ghost');
    ctx.fillStyle = 'rgba(20,40,24,0.55)';
    rr(avBtnX, avBtnY, avBtnW, avBtnH, 12); ctx.fill();
    ctx.strokeStyle = 'rgba(160,230,140,0.6)';
    ctx.lineWidth = 1.5;
    rr(avBtnX, avBtnY, avBtnW, avBtnH, 12); ctx.stroke();
    ctx.fillStyle = '#d6ffc8';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('📷 换头像', avBtnX + avBtnW / 2, avBtnY + avBtnH / 2 + 1);
    /* 男卡 */
    var mSel = G.gender !== 'female';
    ctx.fillStyle = 'rgba(18,36,52,0.82)';
    rr(maleX, pickY, cardW, cardH, 12); ctx.fill();
    ctx.strokeStyle = mSel ? '#ffd75e' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = mSel ? 3 : 1.5;
    rr(maleX, pickY, cardW, cardH, 12); ctx.stroke();
    if (hasImg('heroMaleHead')) {
      /* v5 大头卡：圆形大头 + 韭菜叶，与战斗造型一致 */
      ctx.save();
      ctx.translate(maleX + cardW / 2, pickY + cardH * 0.44);
      drawHeadFace(cardH * 0.28, 'male');
      if (!CUSTOM_AVATAR_ACTIVE) drawLeafTop(cardH * 0.25, false);
      ctx.restore();
    } else if (hasImg('heroMale')) {
      var mh = cardH - 26, mw = mh * (IMG.heroMale.width / IMG.heroMale.height);
      drawImg('heroMale', maleX + cardW / 2 - mw / 2, pickY + 2, mw, mh);
    }
    ctx.fillStyle = '#a8e6b8';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('🧑 韭菜', maleX + cardW / 2, pickY + cardH - 9);
    /* 女卡 */
    var fSel = G.gender === 'female';
    ctx.fillStyle = 'rgba(52,18,40,0.82)';
    rr(femaleX, pickY, cardW, cardH, 12); ctx.fill();
    ctx.strokeStyle = fSel ? '#ffd75e' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = fSel ? 3 : 1.5;
    rr(femaleX, pickY, cardW, cardH, 12); ctx.stroke();
    if (hasImg('heroFemaleHead')) {
      /* v5 大头卡：圆形大头 + 韭菜花 */
      ctx.save();
      ctx.translate(femaleX + cardW / 2, pickY + cardH * 0.44);
      drawHeadFace(cardH * 0.28, 'female');
      if (!CUSTOM_AVATAR_ACTIVE) drawFlowerTop(cardH * 0.25, false);
      ctx.restore();
    } else if (hasImg('heroFemale')) {
      var fh = cardH - 26, fw = fh * (IMG.heroFemale.width / IMG.heroFemale.height);
      drawImg('heroFemale', femaleX + cardW / 2 - fw / 2, pickY + 2, fw, fh);
    }
    ctx.fillStyle = '#ffb8d8';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('👩 韭菜花', femaleX + cardW / 2, pickY + cardH - 9);
    /* ===== 关卡武器条（6 关 6 种武器，v7.6 时代版：石头/炸弹/火箭弹/超级炸弹/脉冲弹/恒星弹） ===== */
    var wpY = pickY + cardH + 16, wpH = 30;
    var wKeys = ['stone', 'knife', 'grenade', 'gun', 'cannon', 'nuke'];
    var wNames = wKeys.map(function (k) { var d = WEAPONS[k]; return d ? d.name : k; });
    var wpGap = W * 0.16;
    var wpX0 = W / 2 - wpGap * (wKeys.length - 1) / 2;
    for (var wi = 0; wi < wKeys.length; wi++) {
      var wx = wpX0 + wi * wpGap;
      var wimg = wKeys[wi];
      /* v7.7：未兑换武器 → 半透明 + 🔒 锁定标记（石头默认拥有） */
      var ownedFlag = G.owned.indexOf(wimg) >= 0;
      ctx.fillStyle = ownedFlag ? 'rgba(20,40,24,0.6)' : 'rgba(28,28,32,0.55)';
      rr(wx - wpGap / 2 + 3, wpY, wpGap - 6, wpH, 15); ctx.fill();
      ctx.fillStyle = ownedFlag ? '#ffd75e' : 'rgba(170,170,180,0.9)';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = ownedFlag ? 1 : 0.55;
      /* v7.6：石头用真实素材；其余武器 = Canvas 精绘造型 */
      if (hasImg(wimg)) {
        drawImg(wimg, wx - 13, wpY + wpH / 2 - 13, 26, 26);
        ctx.fillText(wNames[wi], wx + 17, wpY + wpH / 2 + 1);
      } else if (AMMO_DRAW[wimg]) {
        ctx.save();
        ctx.translate(wx, wpY + wpH / 2);
        AMMO_DRAW[wimg](12);
        ctx.restore();
        ctx.fillText(wNames[wi], wx + 17, wpY + wpH / 2 + 1);
      } else {
        ctx.fillText((wi + 1) + '·' + wNames[wi], wx, wpY + wpH / 2 + 1);
      }
      ctx.globalAlpha = 1;
      /* v7.7：未兑换武器右上角 🔒 */
      if (!ownedFlag) {
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText('🔒', wx + wpGap / 2 - 12, wpY + 12);
      }
    }
    /* 开始按钮 */
    var bw = 230, bh = 52;
    var bx = W / 2 - bw / 2, by = wpY + wpH + 14;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    rr(bx + 2, by + 4, bw, bh, 28);
    ctx.fill();
    var bg = ctx.createLinearGradient(0, by, 0, by + bh);
    bg.addColorStop(0, '#a2f78a');
    bg.addColorStop(0.5, '#58d048');
    bg.addColorStop(1, '#2f9e45');
    ctx.fillStyle = bg;
    rr(bx, by, bw, bh, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    rr(bx, by, bw, bh, 28);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,80,0,0.45)';
    ctx.shadowBlur = 4;
    ctx.fillText('开 始 游 戏', W / 2, by + bh / 2 + 1);
    ctx.shadowBlur = 0;
    /* 武器库按钮 */
    var sbw = 130, sbh = 40;
    var sbx = W / 2 - sbw / 2, sby = by + bh + 18;
    ctx.fillStyle = 'rgba(30,52,38,0.7)';
    rr(sbx, sby, sbw, sbh, 20);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,215,94,0.5)';
    ctx.lineWidth = 1.5;
    rr(sbx, sby, sbw, sbh, 20);
    ctx.stroke();
    ctx.fillStyle = '#ffd75e';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('🧰 韭菜武器库', W / 2, sby + sbh / 2 + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('余额 ¥' + G.money, W / 2, sby + sbh + 16);
    /* 关卡选择 */
    var dotY = sby + sbh + 42;
    var dotR = 19;
    var totalW = LEVELS.length * 56 - 16;
    var startX = W / 2 - totalW / 2;
    var dots = [];
    for (var i = 0; i < LEVELS.length; i++) {
      var dx = startX + i * 56 + dotR;
      var unlocked = i < G.unlock;
      dots.push(makeButton(dx - dotR, dotY - dotR, dotR * 2, dotR * 2, '' + (i + 1), 'level' + i, 'dot'));
      /* 圆点底 */
      ctx.fillStyle = unlocked ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.32)';
      ctx.beginPath(); ctx.arc(dx, dotY, dotR, 0, TAU); ctx.fill();
      ctx.strokeStyle = unlocked ? '#ffffff' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
      /* 彩蛋关皇冠 */
      if (i === LEVELS.length - 1 && unlocked) {
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath();
        ctx.moveTo(dx - 8, dotY - dotR - 2);
        ctx.lineTo(dx - 8, dotY - dotR - 12);
        ctx.lineTo(dx - 3, dotY - dotR - 7);
        ctx.lineTo(dx, dotY - dotR - 14);
        ctx.lineTo(dx + 3, dotY - dotR - 7);
        ctx.lineTo(dx + 8, dotY - dotR - 12);
        ctx.lineTo(dx + 8, dotY - dotR - 2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#c98a1f';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = unlocked ? '#ffffff' : 'rgba(255,255,255,0.4)';
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('' + (i + 1), dx, dotY + 1);
      if (!unlocked) {
        /* 小锁 */
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(dx - 4, dotY + 5, 8, 7);
        ctx.beginPath();
        ctx.arc(dx, dotY + 5, 3.4, Math.PI, 0);
        ctx.stroke();
      } else {
        var st = G.bestStars[i] || 0;
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#ffd75e';
        ctx.fillText(st > 0 ? '★'.repeat(st) : '·', dx, dotY + dotR + 11);
      }
    }
    /* v7.9：重置按钮（右下角，点击弹出确认弹窗；中心与底部提示文字 H-26 水平对齐） */
    var rw = 84, rh = 26;
    var rbx = W - rw - 6, rby = H - rh - 13;
    var resetBtn = makeButton(rbx, rby, rw, rh, '', 'resetAll', 'ghost');
    ctx.fillStyle = 'rgba(30,52,38,0.55)';
    rr(rbx, rby, rw, rh, 13); ctx.fill();
    ctx.strokeStyle = 'rgba(255,140,110,0.45)';
    ctx.lineWidth = 1.2;
    rr(rbx, rby, rw, rh, 13); ctx.stroke();
    ctx.fillStyle = 'rgba(255,180,150,0.85)';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🔄 重置', rbx + rw / 2, rby + rh / 2 + 1);
    G.uiButtons = dots.concat([maleBtn, femaleBtn, avBtn,
      makeButton(bx, by, bw, bh, '开始游戏', 'start', 'primary'),
      makeButton(sbx, sby, sbw, sbh, '武器库', 'shop', 'shop'),
      resetBtn
    ]);
    /* 底部提示 */
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 3;
    ctx.fillText('拖动弹弓瞄准 · 松手发射 · 击败庄家堡垒', W / 2, H - 26);
    ctx.shadowBlur = 0;
    /* v7.9：重置确认弹窗（点击「重置」后弹出，确定才执行；弹窗期间仅弹窗按钮可点） */
    if (G.resetModal) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      var mw = 300, mh = 168;
      var mx = W / 2 - mw / 2, my = H / 2 - mh / 2;
      ctx.fillStyle = 'rgba(18,32,24,0.96)';
      rr(mx, my, mw, mh, 16); ctx.fill();
      ctx.strokeStyle = 'rgba(255,170,120,0.55)';
      ctx.lineWidth = 2;
      rr(mx, my, mw, mh, 16); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = '#ffd75e';
      ctx.fillText('⚠️ 重置确认', W / 2, my + 32);
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#f2e6d8';
      ctx.fillText('将重置游戏所有：', W / 2, my + 58);
      ctx.fillStyle = '#ffb38a';
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText('积分 · 头像 · 武器', W / 2, my + 80);
      var okBtn = makeButton(W / 2 + 12, my + mh - 46, 78, 30, '确定重置', 'resetConfirm', 'danger');
      var noBtn = makeButton(W / 2 - 90, my + mh - 46, 78, 30, '取消', 'resetCancel', 'ghost');
      ctx.fillStyle = '#c8321e';
      rr(okBtn.x, okBtn.y, okBtn.w, okBtn.h, 10); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('确定重置', okBtn.x + okBtn.w / 2, okBtn.y + okBtn.h / 2 + 1);
      ctx.fillStyle = 'rgba(90,90,100,0.7)';
      rr(noBtn.x, noBtn.y, noBtn.w, noBtn.h, 10); ctx.fill();
      ctx.fillStyle = '#eee';
      ctx.fillText('取消', noBtn.x + noBtn.w / 2, noBtn.y + noBtn.h / 2 + 1);
      G.uiButtons = [okBtn, noBtn];   /* 弹窗期间覆盖：背后按钮不可点 */
    }
  }

  /* ====================== 渲染：武器库（升级 + 选择） ====================== */
  function drawShop() {
    drawSky();
    drawGround();
    /* 深色面板 */
    ctx.fillStyle = 'rgba(12,20,32,0.72)';
    ctx.fillRect(0, 0, W, H);
    /* 标题 */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 28px sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#8ef07a';
    ctx.fillText('🧰 韭菜武器库', W / 2, 46);
    ctx.shadowBlur = 0;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = '#ffd75e';
    ctx.fillText('积分 ¥' + G.money, W / 2, 74);
    /* 提示 */
    ctx.font = '12px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('用积分兑换武器 · 点卡片装备 · 点按钮升级（Lv 每级 +25% 伤害）', W / 2, 96);
    /* 武器卡片网格：2 列 */
    var cw = 204, ch = 92;
    var gapX = 12, gapY = 10;
    var gx0 = (W - cw * 2 - gapX) / 2;
    var gy0 = 116;
    var btns = [];
    for (var i = 0; i < WEAPON_ORDER.length; i++) {
      var id = WEAPON_ORDER[i];
      var def = WEAPONS[id];
      var col = i % 2, row = Math.floor(i / 2);
      var x = gx0 + col * (cw + gapX);
      /* 末行单张居中 */
      if (i === WEAPON_ORDER.length - 1 && WEAPON_ORDER.length % 2 === 1) x = W / 2 - cw / 2;
      var y = gy0 + row * (ch + gapY);
      var unlocked = isUnlocked(id);
      var lv = weaponLv(id);
      var equipped = G.weapon === id;
      /* 卡片底 */
      ctx.fillStyle = unlocked ? (equipped ? 'rgba(46,88,52,0.92)' : 'rgba(30,42,58,0.92)') : 'rgba(20,26,38,0.8)';
      rr(x, y, cw, ch, 12);
      ctx.fill();
      ctx.strokeStyle = equipped ? '#ffd75e' : (unlocked ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)');
      ctx.lineWidth = equipped ? 2.5 : 1.5;
      rr(x, y, cw, ch, 12);
      ctx.stroke();
      if (equipped) {
        ctx.fillStyle = 'rgba(255,215,94,0.12)';
        rr(x + 3, y + 3, cw - 6, ch - 6, 10);
        ctx.fill();
      }
      /* 武器图标 */
      drawWeaponIcon(id, x + 46, y + ch / 2, unlocked ? 1 : 0.4);
      if (!unlocked) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath(); ctx.arc(x + 46, y + ch / 2, 24, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText('🔒', x + 46, y + ch / 2);
        ctx.font = '9px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText('兑换 ' + def.cost + ' 积分', x + 46, y + ch / 2 + 16);
      }
      /* 名称 + 信息 */
      ctx.textAlign = 'left';
      ctx.fillStyle = unlocked ? '#ffffff' : 'rgba(255,255,255,0.4)';
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText(def.name, x + 74, y + 22);
      ctx.fillStyle = unlocked ? 'rgba(255,215,94,0.9)' : 'rgba(255,255,255,0.3)';
      ctx.font = '11px sans-serif';
      ctx.fillText(ERA_NAMES[def.era] + ' · Lv' + lv, x + 74, y + 40);
      ctx.fillStyle = unlocked ? '#ff8a70' : 'rgba(255,255,255,0.3)';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('伤害 ' + Math.round(weaponDmg(id, lv)), x + 74, y + 58);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '10px sans-serif';
      ctx.fillText(def.desc, x + 74, y + 74);
      /* 选中标记 */
      if (equipped) {
        ctx.fillStyle = '#ffd75e';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('✔ 装备中', x + cw - 8, y + 18);
      }
      /* 选择按钮 + 兑换按钮 + 升级按钮 */
      btns.push(makeButton(x, y, cw, ch, def.name, 'sel_' + id, 'card'));
      if (!unlocked) {
        /* v7.7：未拥有 → 显示"兑换"按钮（花积分购买，成功后自动装备） */
        var bcost = def.cost;
        var canBuy = G.money >= bcost;
        btns.push(makeButton(x + cw - 84, y + ch - 22, 80, 20, '兑换 ¥' + bcost, 'buy_' + id, 'buy', canBuy));
        ctx.fillStyle = canBuy ? '#ffb63e' : 'rgba(90,90,100,0.6)';
        rr(x + cw - 84, y + ch - 22, 80, 20, 10);
        ctx.fill();
        ctx.fillStyle = canBuy ? '#3a2408' : '#ffffff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('兑换 ¥' + bcost, x + cw - 44, y + ch - 12);
      } else if (lv < LV_MAX) {
        var cost = LV_COST[lv];
        var canAfford = G.money >= cost;
        var by = y + ch - 2;
        btns.push(makeButton(x + cw - 74, by - 20, 68, 20, '升Lv' + (lv + 1) + ' ¥' + cost, 'up_' + id, 'upgrade', canAfford));
        ctx.fillStyle = canAfford ? '#58d048' : 'rgba(90,90,100,0.6)';
        rr(x + cw - 74, by - 20, 68, 20, 10);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('升Lv' + (lv + 1) + ' ¥' + cost, x + cw - 40, by - 9);
      } else if (unlocked) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('已满级', x + cw - 10, y + ch - 12);
      }
    }
    /* 返回按钮 */
    var bw2 = 160, bh2 = 46;
    btns.push(makeButton(W / 2 - bw2 / 2, H - 64, bw2, bh2, '返回菜单', 'shopClose', 'primary'));
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    rr(W / 2 - bw2 / 2, H - 64, bw2, bh2, bh2 / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    rr(W / 2 - bw2 / 2, H - 64, bw2, bh2, bh2 / 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('返回菜单', W / 2, H - 41);
    G.uiButtons = btns;
  }

  /* 武器小图标 */
  function drawWeaponIcon(id, cx, cy, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.translate(cx, cy);
    var def = WEAPONS[id];
    var type = def ? def.type : 'ball';
    /* 圆底 */
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(0, 0, 24, 0, TAU); ctx.fill();
    /* v7.6：石头优先真实素材（Canvas 圆石不像石头）；其余武器用 Canvas 精绘 */
    if (hasImg(id)) {
      drawImg(id, -21, -21, 42, 42);
      ctx.restore();
      return;
    }
    /* v7.5：武器图标 = 新 Canvas 精绘造型（地雷/火箭弹/黑色超级炸弹/脉冲弹/恒星弹） */
    if (def && AMMO_DRAW[id]) {
      AMMO_DRAW[id](21);
      ctx.restore();
      return;
    }
    if (type === 'ball') {
      drawLeek(0, 0, 13, 0, 1, 1, { weapon: 'stone', noPhoto: true });
    } else if (type === 'split') {
      ctx.fillStyle = '#7ddb8a';
      for (var i = 0; i < 3; i++) {
        var a = i * TAU / 3 - Math.PI / 2;
        lellipse(Math.cos(a) * 8, Math.sin(a) * 8, 7, 4.5, a);
        ctx.fill();
      }
      ctx.fillStyle = '#ffe27a';
      ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
    } else if (type === 'bomb') {
      ctx.fillStyle = '#20242c';
      ctx.beginPath(); ctx.arc(0, 2, 10, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#d98e2b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(6, -5);
      ctx.quadraticCurveTo(10, -10, 7, -14);
      ctx.stroke();
      ctx.fillStyle = '#ffd75e';
      ctx.beginPath(); ctx.arc(7, -14, 2.5, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath(); ctx.arc(-3, -1, 3, 0, TAU); ctx.fill();
    } else if (type === 'cluster') {
      ctx.fillStyle = '#fff3dc';
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#d9b381';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fff3dc';
      ctx.beginPath(); ctx.arc(-9, 6, 6, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(9, 6, 6, 0, TAU); ctx.fill();
    } else if (type === 'pierce') {
      ctx.fillStyle = '#d9534f';
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(10, 8);
      ctx.lineTo(0, 4);
      ctx.lineTo(-10, 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(160,240,255,0.9)';
      ctx.beginPath(); ctx.arc(0, -2, 3.5, 0, TAU); ctx.fill();
    } else if (type === 'carrier') {
      ctx.fillStyle = '#4a5568';
      rr(-11, -4, 22, 9, 2);
      ctx.fill();
      ctx.fillStyle = '#c8d4e0';
      rr(-9, -7, 18, 3, 1);
      ctx.fill();
      ctx.fillStyle = '#d9534f';
      ctx.beginPath();
      ctx.moveTo(6, -6);
      ctx.lineTo(12, -2);
      ctx.lineTo(6, 0);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'missile') {
      ctx.fillStyle = '#aebccb';
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.quadraticCurveTo(8, 0, 7, 8);
      ctx.lineTo(0, 11);
      ctx.lineTo(-7, 8);
      ctx.quadraticCurveTo(-8, 0, 0, -12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#d9534f';
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.quadraticCurveTo(4, -7, 0, -3);
      ctx.quadraticCurveTo(-4, -7, 0, -12);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'nuke') {
      ctx.fillStyle = '#4a5568';
      rr(-9, -5, 18, 13, 3);
      ctx.fill();
      ctx.fillStyle = '#ffd75e';
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4a5568';
      for (var k = 0; k < 3; k++) {
        var a2 = k * TAU / 3 - Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a2) * 9, Math.sin(a2) * 9);
        ctx.lineTo(Math.cos(a2 + 0.5) * 4.5, Math.sin(a2 + 0.5) * 4.5);
        ctx.closePath();
        ctx.fill();
      }
    } else if (type === 'chip') {
      var pulse = 0.5 + 0.5 * Math.sin(G.time * 8);
      ctx.fillStyle = 'rgba(125,250,156,' + (0.35 + pulse * 0.3) + ')';
      ctx.beginPath(); ctx.arc(0, 0, 14, 0, TAU); ctx.fill();
      ctx.fillStyle = '#eafff0';
      ctx.save();
      ctx.rotate(G.time * 2);
      rr(-6, -6, 12, 12, 3);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#7dfa9c';
      ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
    } else if (type === 'drone') {
      ctx.fillStyle = '#c8d4e0';
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(9, 0);
      ctx.lineTo(0, 9);
      ctx.lineTo(-9, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#5a6470';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#ff5f4f';
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill();
      ctx.save();
      ctx.translate(0, -9);
      ctx.rotate(G.time * 14);
      ctx.strokeStyle = 'rgba(200,212,224,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-10, 0); ctx.lineTo(10, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /* ====================== 渲染：结算面板 ====================== */
  function drawOverlay(win) {
    ctx.fillStyle = 'rgba(10,14,22,0.62)';
    ctx.fillRect(0, 0, W, H);
    var pw = Math.min(W - 60, 320);
    var ph = win ? 300 : 240;
    var px = W / 2 - pw / 2, py = H * 0.24;
    ctx.fillStyle = 'rgba(30,40,56,0.92)';
    rr(px, py, pw, ph, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    rr(px, py, pw, ph, 18); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (win) {
      ctx.font = 'bold 34px sans-serif';
      ctx.fillStyle = '#8ef07a';
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 6;
      ctx.strokeText('过关！', W / 2, py + 48);
      ctx.fillText('过关！', W / 2, py + 48);
      /* 星星 */
      var sy = py + 100;
      for (var i = 0; i < 3; i++) {
        var show = i < G.stars;
        var sc = G.starAnim[i];
        if (sc < 1) G.starAnim[i] = sc = Math.min(1, sc + (win ? 0.02 : 0.04));
        var t = easeOutCubic(sc);
        var sxp = W / 2 + (i - 1) * 52;
        var syp = sy + (1 - t) * -26;
        ctx.save();
        ctx.translate(sxp, syp);
        ctx.scale(t, t);
        ctx.fillStyle = show ? '#ffd75e' : 'rgba(255,255,255,0.25)';
        ctx.strokeStyle = show ? '#c98a1f' : 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var k = 0; k < 10; k++) {
          var ang = k * Math.PI / 5 - Math.PI / 2;
          var rad = k % 2 === 0 ? 20 : 9;
          if (k === 0) ctx.moveTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
          else ctx.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
        }
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = '#ffd75e';
      ctx.fillText('收益 ¥' + G.score, W / 2, py + 150);
    } else {
      ctx.font = 'bold 32px sans-serif';
      ctx.fillStyle = '#ff8a70';
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 6;
      ctx.strokeText('韭菜被收割了…', W / 2, py + 70);
      ctx.fillText('韭菜被收割了…', W / 2, py + 70);
      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText('别灰心，再来一次！', W / 2, py + 118);
    }
    /* 按钮 */
    for (var j = 0; j < G.uiButtons.length; j++) {
      drawButton(G.uiButtons[j]);
    }
  }

  function drawButton(b) {
    var pressed = G.pressedBtn === b;
    var x = b.x + (pressed ? 1 : 0);
    var y = b.y + (pressed ? 2 : 0);
    if (b.style === 'primary') {
      var bg = ctx.createLinearGradient(0, y, 0, y + b.h);
      bg.addColorStop(0, '#8ef07a');
      bg.addColorStop(1, '#2f9e45');
      ctx.fillStyle = bg;
    } else if (b.style === 'ghost') {
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
    }
    rr(x, y, b.w, b.h, b.h / 2);
    ctx.fill();
    ctx.strokeStyle = b.style === 'primary' ? 'rgba(30,80,30,0.7)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    rr(x, y, b.w, b.h, b.h / 2);
    ctx.stroke();
    ctx.fillStyle = b.style === 'primary' ? '#ffffff' : '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, x + b.w / 2, y + b.h / 2 + 1);
  }

  /* ====================== 主循环 ====================== */
  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (G.state === 'MENU') {
      drawMenu();
      return;
    }
    if (G.state === 'SHOP') {
      drawShop();
      return;
    }
    ctx.save();
    if (G.shake > 0.1) {
      ctx.translate(rand(-G.shake, G.shake), rand(-G.shake, G.shake));
    }
    drawSky();
    drawGround();
    drawWorld();
    ctx.restore();
    if (G.state === 'PLAY') drawHud();
    if (G.state === 'WIN' || G.state === 'LOSE') {
      drawHud();
      drawOverlay(G.state === 'WIN');
    }
    if (G.state === 'FINAL') {
      drawHud();
      drawFinale();
    }
  }

  /* ====================== 结局动画：抓多头牛 → 冲进城堡 → 欢庆胜利 ====================== */
  function drawFinale() {
    var t = G.finalT;
    var cx = W / 2;
    /* 多头牛：先沿韭菜地跑向山脚，再一鼓作气冲上山顶（冲向城堡） */
    if (t < 3.6) {
      var bx, by, bw2, bh2;
      if (t < 2.3) {
        var k = easeInOut(clamp(t / 2.3, 0, 1));
        bx = -70 + (cx + 70) * k;
        by = GROUND_Y - 34 - Math.sin(k * Math.PI) * 7;
        bw2 = 56; bh2 = 44;
      } else {
        var k2 = easeInOut(clamp((t - 2.3) / 1.3, 0, 1));
        bx = cx;
        by = GROUND_Y - 26 - (GROUND_Y - 26 - 158) * k2;
        bw2 = 56 * (1 - k2 * 0.55);
        bh2 = 44 * (1 - k2 * 0.55);
      }
      drawImg('bull', bx - bw2 / 2, by - bh2, bw2, bh2);
      /* 奔跑尘土 */
      if (t < 2.3 && Math.random() < 0.4) {
        spawnParticles(bx - 24, GROUND_Y - 4, '#b9c99a', 2, 60, 'circle');
      }
    }
    /* 字幕（节奏化旁白） */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (t < 2.3) {
      bannerText('抓住多头牛！', H * 0.30, clamp(t / 0.4, 0, 1));
    } else if (t < 4.0) {
      bannerText('攻入城堡！', H * 0.30, 1);
    } else {
      bannerText('欢庆胜利！', H * 0.30, clamp((t - 4.0) / 0.5, 0, 1), 40);
      bannerText('抓住多头牛 · 攻入城堡 · 烟花漫天', H * 0.30 + 52, clamp((t - 4.6) / 0.5, 0, 1), 16);
    }
    /* 星级 + 收益 */
    if (t > 3.2) {
      var alpha = clamp((t - 3.2) / 0.5, 0, 1);
      ctx.globalAlpha = alpha;
      for (var i = 0; i < 3; i++) {
        var show = i < G.stars;
        var sxp = cx + (i - 1) * 46;
        var syp = H * 0.30 + 92;
        ctx.save();
        ctx.translate(sxp, syp);
        ctx.rotate(i === 0 ? -0.2 : (i === 2 ? 0.2 : 0));
        ctx.fillStyle = show ? '#ffd75e' : 'rgba(255,255,255,0.25)';
        ctx.strokeStyle = show ? '#c98a1f' : 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var k2i = 0; k2i < 10; k2i++) {
          var ang = k2i * Math.PI / 5 - Math.PI / 2;
          var rad = k2i % 2 === 0 ? 18 : 8;
          if (k2i === 0) ctx.moveTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
          else ctx.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
        }
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      ctx.font = 'bold 17px sans-serif';
      ctx.fillStyle = '#ffd75e';
      ctx.fillText('收益 ¥' + G.score, cx, syp + 42);
      ctx.globalAlpha = 1;
    }
    /* 按钮（5s 后出现） */
    for (var j = 0; j < G.uiButtons.length; j++) {
      drawButton(G.uiButtons[j]);
    }
  }

  /* 带描边的大字横幅 */
  function bannerText(txt, y, a, size) {
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = clamp(a, 0, 1);
    var fs = size || 34;
    ctx.font = 'bold ' + fs + 'px sans-serif';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 6;
    ctx.strokeText(txt, W / 2, y);
    var bg = ctx.createLinearGradient(0, y - fs, 0, y + fs);
    bg.addColorStop(0, '#fff3b0');
    bg.addColorStop(0.5, '#ffd75e');
    bg.addColorStop(1, '#ff9d3a');
    ctx.fillStyle = bg;
    ctx.fillText(txt, W / 2, y);
    ctx.restore();
  }

  function frame(ts) {
    var dt = clamp((ts - lastTs) / 1000, 0.001, 0.033);
    if (lastTs === 0) dt = 0.016;
    lastTs = ts;
    update(dt);
    render();
    raf(frame);
  }
  var lastTs = 0;

  /* ====================== 启动 / 对外 API ====================== */
  function start(canvasId) {
    setupCanvas(canvasId);
    setupInput();
    loadImages();
    GROUND_Y = H - 150;
    SX = W * 0.5;          /* v7.8 弹弓回到画面居中（原左移 165 偏侧，居中更稳） */
    SY = GROUND_Y - 40;    /* v7.7 弹弓更低一点 + 主干插入黄土 */
    G.state = 'MENU';
    G.uiButtons = [];
    raf(function (ts) { lastTs = ts; frame(ts); });
  }

  return {
    start: start,
    sound: Sound,
    getState: function () {
      var blocks = [];
      for (var i = 0; i < G.blocks.length; i++) {
        var b = G.blocks[i];
        blocks.push({ x: b.x, y: b.y, w: b.w, h: b.h, kind: b.kind, hp: b.hp, maxHp: b.maxHp, dead: b.dead });
      }
      return {
        state: G.state, level: G.level, W: W, H: H,
        GROUND_Y: GROUND_Y, SX: SX, SY: SY,
        launch: { x: SX, y: SY - LAUNCH_OFF },
        shotsLeft: G.shotsLeft, score: G.score,
        enemiesLeft: G.enemiesLeft, unlock: G.unlock, stars: G.stars,
        hp: G.hp, hurtT: G.hurtT, enemyFire: G.enemyFire.length,
        activeLeek: !!G.activeLeek, dragging: G.dragging,
        weapon: G.weapon, owned: G.owned.slice(),
        whiteFlash: G.whiteFlash || 0,
        leek: G.projectiles[0] ? { x: G.projectiles[0].x, y: G.projectiles[0].y, vx: G.projectiles[0].vx, vy: G.projectiles[0].vy, resting: G.projectiles[0].resting, fading: G.projectiles[0].fading, dead: G.projectiles[0].dead, weapon: G.projectiles[0].weapon } : null,
        uiButtons: G.uiButtons.map(function (u) {
          return { x: u.x, y: u.y, w: u.w, h: u.h, action: u.action, label: u.label, style: u.style };
        }),
        blocks: blocks
      };
    },
    simulateTouch: function (type, x, y) { onTouch(type, x, y); },
    /* 换头像：src 为图片 URL / 微信本地临时路径，传空串恢复默认 */
    setAvatar: function (src) { setAvatar(src); },
    tapButton: function (action) {
      for (var i = 0; i < G.uiButtons.length; i++) {
        if (G.uiButtons[i].action === action) {
          var b = G.uiButtons[i];
          G.pressedBtn = b;
          triggerButton(b.action);
          G.pressedBtn = null;
          return true;
        }
      }
      return false;
    },
    /* 调试/图鉴导出：用独立 canvas 单独渲染任意角色（不参与正常游戏逻辑）。
     * kind 为武器名（WEAPONS key）→ 画韭菜/时代造型；否则按敌人绘制。 */
    __drawChar: function (c, kind, x, y, w, h, opts) {
      var old = ctx;
      ctx = c;
      try {
        if (WEAPONS[kind]) {
          drawLeek(x, y, Math.min(w, h) / 2, 0, 1, 1, opts || {});
        } else {
          drawEnemy({ x: x, y: y, w: w, h: h, kind: kind, hp: 999, maxHp: 999, dead: false });
        }
      } finally {
        ctx = old;
      }
    }
  };
});
