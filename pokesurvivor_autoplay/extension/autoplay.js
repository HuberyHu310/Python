/* PokéSurvivor 自動代玩 (auto-play bot)
 *
 * 用在「本機版」PokéSurvivor（原始碼 dev.html，遊戲狀態 window.G 看得到）。
 * 公開網站 pokesurvivor.com 的程式是包起來＋混淆過的（作者的防作弊），
 * 拿不到遊戲狀態，所以這支 bot 在那裡不會動。
 *
 * 安全設計：bot 一載入就把 G.FIREBASE_CONFIG 鎖成 null，遊戲因此只會用
 * 「本機模式」——不連雲端、不上傳排行榜，代玩的成績不會影響其他玩家。
 *
 * 會做的事：
 *   - 走位：避開敵人、敵人子彈、地上預警的範圍攻擊、熔岩/毒沼
 *   - 撿東西：道具、寶珠、經驗；低血量去泉水補血、順路拿祭壇加成
 *   - 升級三選一、道具二選一、羈絆融合都自動選
 *   - 有增益招式時自動切過去放 buff 再切回主力招式
 *   - 選單：訪客登入、性格測驗、按「開始」、結算後再來一局
 *
 * 熱鍵：F8 開/關 bot，F9 開/關自動重開新局。你自己按方向鍵時，以你的操作為主。
 */
(() => {
  'use strict';
  if (window.__psAutoplay) return;

  const S = window.__psAutoplay = {
    on: true,            // bot 是否在操控
    autoRestart: true,   // 結束後自動再開一局
    autoUpgrade: true,   // 開局前用金幣自動買永久強化
    runs: [],            // 每局結果 { time, level, kills, bosses }
    vec: [0, 0],
    status: '等待遊戲載入…',
    debug: false
  };

  // ---------- 1. 鎖成本機模式（在遊戲任何腳本跑之前） ----------
  const G = window.G = window.G || {};
  try {
    Object.defineProperty(G, 'FIREBASE_CONFIG', { get: () => null, set() {}, configurable: false });
  } catch (e) { /* 已經被定義：下面 install() 再檢查 */ }

  // ---------- 小工具 ----------
  const $ = id => document.getElementById(id);
  const visible = id => { const el = $(id); return !!el && !el.classList.contains('hidden'); };
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const later = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { console.warn('[autoplay]', e); } }, ms);

  // ---------- 2. 等遊戲載入 ----------
  const ready = () => G.Game && G.Input && G.RunUI && G.EnemyMgr && G.Projectiles && G.Pickups && G.World && G.Hazards;
  const wait = setInterval(() => {
    if (!ready()) {
      if (document.readyState === 'complete' && !G.Input && !wait.warned && /pokesurvivor\.com$/.test(location.hostname)) {
        wait.warned = true;
        console.warn('[autoplay] 公開網站的遊戲程式是封裝過的，bot 讀不到遊戲狀態。請用本機版（見 README）。');
        panel('公開網站讀不到遊戲狀態，請用本機版（見 README）');
      }
      return;
    }
    clearInterval(wait);
    install();
  }, 100);

  function install() {
    if (G.FIREBASE_CONFIG) {
      // 沒鎖成功（理論上不會）：保險起見不啟動。
      S.on = false;
      panel('沒辦法鎖定本機模式，bot 不啟動');
      return;
    }
    hookInput();
    hookChoices();
    hookKeys();
    requestAnimationFrame(tick);
    setInterval(menus, 400);
    S.status = '已啟動';
    panel();
    console.log('[autoplay] 已啟動。F8 開/關，F9 自動重開。window.__psAutoplay 可看狀態。');
  }

  // ---------- 3. 接管移動輸入 ----------
  function hookInput() {
    const orig = G.Input.axis.bind(G.Input);
    G.Input.axis = () => {
      const human = orig();
      if (human[0] || human[1]) return human;           // 玩家自己按鍵優先
      if (S.on && G.Game.state === 'playing') return S.vec;
      return human;
    };
  }

  function hookKeys() {
    addEventListener('keydown', e => {
      if (e.code === 'F8') { S.on = !S.on; panel(); e.preventDefault(); }
      if (e.code === 'F9') { S.autoRestart = !S.autoRestart; panel(); e.preventDefault(); }
    }, true);
  }

  // ---------- 4. 選卡 / 道具 / 羈絆 ----------
  // 會把自己送進敵人堆的招式 / 能站遠打的招式
  const RISKY = new Set(['dash', 'charge']);
  const SAFE_RANGED = new Set(['projectile', 'homing', 'beam', 'chain', 'meteor', 'bounce', 'turret', 'boomerang']);
  const STAT_SCORE = { atk: 50, cd: 46, def: 38, hp: 34, rgn: 30, spd: 26, xp: 22, mag: 18, heal: 6 };
  // 道具偏好（越前面越好）
  const ITEM_RANK = ['lifeorb', 'choiceband', 'leftovers', 'shellbell', 'assaultvest', 'focussash',
                     'quickclaw', 'choicescarf', 'rockyhelmet', 'luckyegg', 'amuletcoin'];

  function scoreCard(c, pl) {
    const [type, id] = (c.key || ':').split(':');
    const hpFrac = pl.hp / pl.maxHp;
    if (type === 'evo') return 1000;
    if (type === 'new') {
      // 同一時間只有「目前的招式槽」會攻擊，新招式會放進別的槽閒著，
      // 所以除了第一個增益招式外，新招式的優先度很低（之後羈絆可以把它們融合）。
      const d = G.Moves && G.Moves.BY_ID[id];
      if (!d) return 12;
      if (d.kind === 'buff') return pl.moves.some(m => m.kind === 'buff') ? 5 : 30;
      const fit = G.Stats ? G.Stats.fit(pl.mon, d.cat) : 1;
      // 主力是「衝進敵人堆」的招式（衝刺、蓄力衝撞）時，換一個遠程招式當主力比較安全
      const main = pl.activeMove && pl.activeMove();
      if (main && RISKY.has(main.kind) && !RISKY.has(d.kind)) return (SAFE_RANGED.has(d.kind) ? 75 : 55) * fit;
      return 14 * fit;
    }
    if (type === 'up') {
      const m = pl.moves.find(x => x.id === id);
      if (!m) return 20;
      if (pl.activeGroup().includes(m)) return 80;          // 主力招式優先升
      if (m.kind === 'buff') return 28;
      return 15;
    }
    if (type === 'stat') {
      let s = STAT_SCORE[id] || 20;
      if (id === 'heal') s = hpFrac < 0.4 ? 95 : hpFrac < 0.65 ? 40 : 4;
      if (id === 'hp' && hpFrac < 0.5) s += 20;
      if (/^Evoluciona/.test(c.tag || '')) s += 60;           // 能讓招式進化的屬性
      return s;
    }
    return 10;
  }

  function hookChoices() {
    const ui = G.RunUI;

    const showLevelUp = ui.showLevelUp;
    ui.showLevelUp = function (level, list, cb, coop) {
      const r = showLevelUp.apply(this, arguments);
      if (S.on && list && list.length) {
        const pl = G.Game.player;
        let best = 0, bestS = -1;
        list.forEach((c, i) => { const s = scoreCard(c, pl); if (s > bestS) { bestS = s; best = i; } });
        S.lastPick = list[best] && list[best].key;
        tryUntil(() => !visible('scr-levelup') || $('cards').classList.contains('done'), () => ui.pick(best));
      }
      return r;
    };

    const showItemChoice = ui.showItemChoice;
    ui.showItemChoice = function (cur, next, cb) {
      const r = showItemChoice.apply(this, arguments);
      if (S.on) {
        const rank = id => { const i = ITEM_RANK.indexOf(id); return i < 0 ? 99 : i; };
        const idx = rank(next) < rank(cur) ? 1 : 0;
        tryUntil(() => !visible('scr-item'), () => { const el = document.querySelectorAll('#item-cards .card')[idx]; el && el.click(); });
      }
      return r;
    };

    const showBond = ui.showBond;
    ui.showBond = function (opt, cb) {
      const r = showBond.apply(this, arguments);
      if (S.on && opt && opt.loose && opt.loose.length) {
        // 先挑等級最高、非增益的招式來融合
        const val = m => (m.kind === 'buff' ? -10 : 0) + (m.lvl || 1) + (m.evolved ? 5 : 0);
        const order = opt.loose.slice().sort((a, b) => val(b) - val(a));
        const first = order[0], second = order.find(m => m !== first);
        if (opt.mode === 'pair' && second) {
          // 兩步：先選第一個，畫面換成第二步（出現「返回」鈕）後再選第二個
          const step2 = () => !$('bond-back').classList.contains('hidden');
          tryUntil(() => !visible('scr-bond') || step2(), () => ui.pickBond(opt.loose.indexOf(first)), () => {
            const rest = opt.loose.filter(m => m !== first);
            tryUntil(() => !visible('scr-bond'), () => ui.pickBond(Math.max(0, rest.indexOf(second))));
          });
        } else {
          tryUntil(() => !visible('scr-bond'), () => ui.pickBond(Math.max(0, opt.loose.indexOf(first))));
        }
      }
      return r;
    };
  }

  /** 每 250ms 試一次 act()，直到 done() 成立（遊戲有防誤觸延遲）。 */
  function tryUntil(done, act, then, n = 0) {
    later(n ? 250 : 450, () => {
      if (done()) { if (then) then(); return; }
      if (n > 40) return;
      act();
      tryUntil(done, act, then, n + 1);
    });
  }

  // ---------- 5. 選單自動化 ----------
  let lastOver = null;
  function menus() {
    if (!S.on) return;
    const st = G.Game.state;
    const click = id => { const el = $(id); if (el) el.click(); };

    // 跳過各種提示視窗
    for (const [scr, btn] of [['scr-savenote', 'savenote-ok'], ['scr-recover', 'rec-later'], ['scr-nick', 'nick-later'],
                              ['scr-legal', 'legal-close'], ['scr-support', 'sup-close'], ['scr-news', null]]) {
      if (visible(scr)) { if (btn) click(btn); else if (G.NewsUI) G.NewsUI.close(); return; }
    }
    if (G.Judgment && G.Judgment.cinematic && G.Judgment.skip) G.Judgment.skip();

    if (st === 'ui') {
      if (visible('tap-start')) { click('tap-start'); return; }
      if (visible('scr-login')) { click('btn-guest'); S.status = '訪客登入'; return; }
      if (visible('scr-test')) {
        const a = document.querySelector('#test-a button, #test-a .btn, #test-a > *');
        if (a) a.click();
        S.status = '性格測驗';
        return;
      }
      if (visible('scr-result')) { click('res-ok'); return; }
      if (visible('scr-menu') && S.autoRestart) {
        const b = document.querySelector('#scr-menu [data-go="play"]');
        if (b) { if (S.autoUpgrade) autoUpgrade(); b.click(); S.status = '開始新局'; }
      }
      return;
    }
    if (st === 'over' && visible('scr-over')) {
      if (lastOver !== S.cur) {
        lastOver = S.cur;
        if (S.cur) { S.runs.push(S.cur); console.log('[autoplay] 這局結果', JSON.stringify(S.cur)); }
        panel();
      }
      if (S.autoRestart) later(1500, () => { if (visible('scr-over')) click('btn-again'); });
    }
  }

  // 永久強化（選單「Mejoras」）：分數 = 價格 × 權重，每次買分數最低的；買不起就存錢。
  const UPG_W = { atk: 0.7, hp: 0.8, cd: 0.8, def: 0.9, crit: 0.95, regen: 1, spd: 1.1, coins: 1, xp: 1.2, magnet: 1.3, reroll: 1.6 };
  function autoUpgrade() {
    const sv = G.DB && G.DB.save;
    if (!sv || !sv.partner || !G.Upgrades) return;
    const lv = G.DB.upgradesOf(sv.partner);
    const got = [];
    for (let k = 0; k < 100; k++) {
      let best = null, bs = Infinity;
      for (const id in UPG_W) {
        const u = G.Upgrades.BY[id];
        if (!u || (lv[id] || 0) >= u.max) continue;
        const sc = G.Upgrades.cost(id, lv[id] || 0) * UPG_W[id];
        if (sc < bs) { bs = sc; best = id; }
      }
      if (!best) break;
      const price = G.Upgrades.cost(best, lv[best] || 0);
      if (sv.coins < price) break;
      sv.coins -= price;
      lv[best] = (lv[best] || 0) + 1;
      got.push(best);
    }
    if (got.length) {
      G.DB.commit(true);
      if (G.UI.refreshCoins) G.UI.refreshCoins();
      console.log('[autoplay] 買了永久強化', got.join(', '), '剩', sv.coins, '金幣');
    }
  }

  // ---------- 6. 每幀決策 ----------
  const DIRS = 24;
  // 模擬的時間點與權重：近的比較準、比較重要；遠的用來找包圍的缺口
  const HORIZON = [[0.12, 1.4], [0.3, 1], [0.55, 0.6], [0.9, 0.35]];
  let prevDir = -1, wanderA = Math.random() * Math.PI * 2, stuckT = 0, lastPos = null, slotT = 0, frameN = 0;

  function tick() {
    requestAnimationFrame(tick);
    frameN++;
    const pl = G.Game.player;
    if (!S.on || G.Game.state !== 'playing' || !pl || pl.dead) { S.vec = [0, 0]; return; }
    try {
      S.cur = { time: Math.floor(G.Game.st.time), level: pl.level, kills: pl.kills, bosses: pl.bosses };
      S.vec = think(pl);
      if (++slotT % 15 === 0) manageSlots(pl);
      if (frameN % 30 === 0) useOrbs(pl);
      if (frameN % 60 === 0) panel();
    } catch (e) {
      S.vec = [0, 0];
      if (!S.err) { S.err = e; console.warn('[autoplay] 錯誤', e); }
    }
  }

  /** 招式槽：主力用傷害招式，增益快沒了就切去放一下。 */
  function manageSlots(pl) {
    if (!pl.slots || pl.slots.length < 2) return;
    const dmgVal = g => g.reduce((a, m) => a + (m.kind === 'buff' ? 0 : ((m.lvl || 1) + (m.evolved ? 6 : 0)) * (RISKY.has(m.kind) ? 0.4 : 1)), 0);
    let main = 0;
    pl.slots.forEach((g, i) => { if (dmgVal(g) > dmgVal(pl.slots[main])) main = i; });
    // 需要補 buff 的槽（整槽都是增益）
    const enemies = G.EnemyMgr.all().filter(e => !e.dead);
    const close = enemies.some(e => dist(pl.x, pl.y, e.x, e.y) < 220);
    let want = main;
    if (close) {
      pl.slots.forEach((g, i) => {
        if (g.every(m => m.kind === 'buff')) {
          const need = g.some(m => { const b = pl.buffs[m.stat]; return b && (b.t < 1.5 || b.n < (m.stacks | 0)); });
          if (need) want = i;
        }
      });
    }
    if (pl.active !== want) pl.setActive(want);
  }

  /** 寶珠：被包圍或血少時用控場的，打王時用增益的。 */
  function useOrbs(pl) {
    if (!pl.orbs || !G.Orbs) return;
    const enemies = G.EnemyMgr.all().filter(e => !e.dead);
    const near = enemies.filter(e => dist(pl.x, pl.y, e.x, e.y) < 200).length;
    const boss = enemies.some(e => e.boss && dist(pl.x, pl.y, e.x, e.y) < 400);
    const low = pl.hp / pl.maxHp < 0.45;
    pl.orbs.forEach((o, i) => {
      if (!o) return;
      const kind = (G.Orbs.BY[o.id] || {}).kind;
      if (kind === 'foe' && (near >= 12 || (low && near >= 4))) G.Orbs.use(pl, i);
      else if (kind === 'buff' && o.id !== 'luminous' && (boss || near >= 15)) G.Orbs.use(pl, i);
      else if (o.id === 'luminous' && near >= 20) G.Orbs.use(pl, i);
    });
  }

  /** 招式的有效距離 → 想跟敵人保持的距離。 */
  function preferredRange(pl) {
    const m = pl.activeMove && pl.activeMove();
    if (!m) return 140;
    const r = m.radius || 60;
    switch (m.kind) {
      case 'melee': case 'spin': case 'shove': case 'charge': case 'aura': case 'nova': case 'quake':
        return clamp(r * 0.8 + 10, 45, 120);
      case 'beam': case 'boomerang': case 'dash': case 'cone': return clamp(r * 0.75, 80, 200);
      case 'orbit': return 70;
      default: return 190;   // 投射物、追蹤、連鎖、隕石…
    }
  }

  function think(pl) {
    const px = pl.x, py = pl.y, pr = pl.r, spd = Math.max(40, pl.spd || 100);
    const hpFrac = pl.hp / pl.maxHp;
    const enemies = G.EnemyMgr.all().filter(e => !e.dead && dist(px, py, e.x, e.y) < 700);
    const shots = G.Projectiles.all().filter(p => !p.friendly && !p.orb && dist(px, py, p.x, p.y) < 450);
    const hazards = G.Hazards.all.filter(h => !h.hit || h.t < h.delay + h.end);
    const pickups = G.Pickups.all();
    const liq = G.World.liquidEffect(pl.mon.types) || {};
    const levitate = pl.abil && pl.abil.levitate;
    const want = preferredRange(pl);

    // 目標點（撿東西 / 泉水 / 祭壇 / 大寶箱）
    let goal = null, goalW = 0;
    const consider = (x, y, w) => {
      const d = dist(px, py, x, y);
      const v = w / (d + 60);
      if (v > goalW) { goalW = v; goal = { x, y }; }
    };
    // 撿東西前先看那裡安不安全（經驗常掉在敵人堆裡，磁力會幫忙吸過來）
    const crowdAt = (x, y, r) => { let n = 0; for (const e of enemies) if (dist(x, y, e.x, e.y) < r + e.r) n++; return n; };
    for (const p of pickups) {
      if (p.pulled || dist(px, py, p.x, p.y) > 650) continue;
      const w = p.kind === 'item' || p.kind === 'sphere' ? 260 : p.kind === 'xpBig' ? 60 : p.kind === 'xp' ? 12 : 120;
      const n = crowdAt(p.x, p.y, 110);
      if (n > (w >= 120 ? 3 : 0)) continue;
      consider(p.x, p.y, w);
    }
    if (G.World.specialsNear) {
      for (const s of G.World.specialsNear(px, py, 600) || []) {
        if (s.type === 'spring' && s.charge > 0.1 && hpFrac < 0.7) consider(s.x, s.y, 500 * (1 - hpFrac));
        else if (s.type === 'altar' && !s.used && !pl.power) consider(s.x, s.y, 160);
        else if (s.type === 'bigchest' && !s.used && hpFrac > 0.55 && enemies.length < 25) consider(s.x, s.y, 120);
      }
    }

    // 敵人的質心（大方向逃開人多的地方）
    let cx = 0, cy = 0, cn = 0, nearest = null, nd = 1e9;
    for (const e of enemies) {
      const d = dist(px, py, e.x, e.y);
      if (d < 400) { const k = 1 / (d + 40); cx += e.x * k; cy += e.y * k; cn += k; }
      if (d < nd) { nd = d; nearest = e; }
    }

    const evalPos = (x, y) => {
      let c = 0;
      // 地形
      if (G.World.isWall(x, y)) return 1e6;
      if (!G.World.isFree(x, y, pr * 0.7, true)) c += 4000;
      if (!levitate && G.World.isLiquid(x, y)) c += liq.dmg ? 60000 : liq.slow ? 120 : 30;
      return c;
    };

    let bestI = -1, bestC = Infinity;
    for (let i = -1; i < DIRS; i++) {
      const a = i < 0 ? 0 : (i / DIRS) * Math.PI * 2;
      const dx = i < 0 ? 0 : Math.cos(a), dy = i < 0 ? 0 : Math.sin(a);
      let cost = 0;
      // 多個時間點模擬
      for (const [t, wt] of HORIZON) {
        const x = px + dx * spd * t, y = py + dy * spd * t;
        cost += evalPos(x, y) * wt;
        // 敵人（假設會朝我們走過來）
        for (const e of enemies) {
          let ex = e.x, ey = e.y;
          const ed = dist(ex, ey, x, y) || 1;
          const step = Math.min(ed, (e.spd || 60) * t);
          ex += (x - ex) / ed * step; ey += (y - ey) / ed * step;
          const gap = dist(ex, ey, x, y) - (e.r + pr);
          const safe = e.boss ? 150 : 45;
          if (gap < safe) cost += wt * (e.boss ? 4 : 1) * (e.dmg || 10) * 6 * Math.pow((safe - gap) / safe + 0.2, 2);
        }
        // 敵人子彈
        for (const s of shots) {
          const sx = s.x + (s.vx || 0) * t, sy = s.y + (s.vy || 0) * t;
          const gap = dist(sx, sy, x, y) - ((s.r || 7) + pr);
          if (gap < 14) cost += wt * 220 * ((14 - gap) / 14 + 0.3);
        }
        // 地面預警（光束、圓形範圍）
        for (const h of hazards) {
          if (G.Hazards.inside(h, x, y, pr + 8)) cost += wt * (h.hit ? 300 : 900);
        }
      }
      // 不要被包圍：往人少的方向
      if (cn > 0 && i >= 0) {
        const ax = cx / cn - px, ay = cy / cn - py, al = Math.hypot(ax, ay) || 1;
        cost += 22 * (dx * ax + dy * ay) / al * clamp(enemies.length / 15, 0.3, 3);
      }
      // 保持攻擊距離（血量健康時才主動靠近）
      if (nearest && i >= 0) {
        const nx = px + dx * spd * 0.3, ny = py + dy * spd * 0.3;
        const nd2 = dist(nx, ny, nearest.x, nearest.y);
        const k = hpFrac > 0.5 ? 0.05 : 0.015;
        cost += k * Math.abs(nd2 - want);
      }
      // 目標點
      if (goal && i >= 0) {
        const gl = dist(px, py, goal.x, goal.y) || 1;
        cost -= 40 * Math.min(1, goalW * 3) * (dx * (goal.x - px) + dy * (goal.y - py)) / gl;
      }
      // 沒事做時四處晃找敵人
      if (!nearest && !goal && i >= 0) cost -= 15 * (dx * Math.cos(wanderA) + dy * Math.sin(wanderA));
      // 平滑：偏好原方向，避免抖動
      if (i >= 0 && i === prevDir) cost -= 6;
      if (i < 0) cost += 4;          // 站著不動略差（容易被圍）
      if (cost < bestC) { bestC = cost; bestI = i; }
    }

    // 卡住偵測
    if (lastPos && bestI >= 0 && dist(lastPos.x, lastPos.y, px, py) < spd * 0.004) {
      stuckT++;
      if (stuckT > 40) { wanderA = Math.random() * Math.PI * 2; stuckT = 0; }
    } else stuckT = 0;
    lastPos = { x: px, y: py };
    if (Math.random() < 0.002) wanderA += (Math.random() - 0.5) * 2;

    prevDir = bestI;
    if (S.debug) S.dbg = { bestI, bestC, enemies: enemies.length, shots: shots.length, hazards: hazards.length, goal };
    if (bestI < 0) return [0, 0];
    const a = (bestI / DIRS) * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  }

  // ---------- 7. 小面板 ----------
  function panel(msg) {
    if (!document.body) return;
    let el = $('ps-autoplay-panel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ps-autoplay-panel';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:12px/1.4 monospace;color:#fff;' +
        'background:rgba(0,0,0,.6);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre';
      document.body.appendChild(el);
    }
    const best = S.runs.reduce((a, r) => Math.max(a, r.time), 0);
    const c = S.cur;
    el.textContent = msg ? '[代玩] ' + msg :
      `[代玩] ${S.on ? '開啟' : '關閉'} (F8)  自動重開 ${S.autoRestart ? '開' : '關'} (F9)\n` +
      (c ? `本局 ${c.time}s  Lv${c.level}  擊倒 ${c.kills}\n` : '') +
      `已玩 ${S.runs.length} 局  最佳 ${best}s  · 本機模式`;
  }
})();
